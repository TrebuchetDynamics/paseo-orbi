import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import { capture, expect, test, TARGET_ID } from './fixture';
import { assertState, cli, configure, menu, navigate, refresh, select, state } from '../fixtures/browser';

// One worker, one owned Xvfb display and one real window: these journeys are serial
// because they share the disposable profile, hosts and plugin lifecycle.
test.describe.configure({ mode: 'serial' });
const views = ['fleet', 'issues', 'runs', 'blockers'] as const;
const detailControl = { fleet: 'Active work for Demo', issues: 'Inspect issue 42', runs: 'Inspect run 42 84360d31', blockers: 'Inspect blocker 43' } as const;

// The native app imports no URL: appearance is changed through the real settings UI.
async function nativeTheme(page: Page, mode: 'light' | 'dark') {
  await menu(page);
  await page.getByTestId('sidebar-settings').click();
  await page.getByTestId('settings-sidebar').getByRole('button', { name: 'Appearance', exact: true }).click();
  const radio = page.getByRole('radio', { name: mode === 'dark' ? 'Dark' : 'Light', exact: true });
  await radio.click(); await expect(radio).toBeChecked();
  await menu(page); await page.getByRole('button', { name: 'Orbi', exact: true }).click();
  await expect(page.getByTestId('plugin-surface-title')).toHaveText('Fleet');
}
async function resize(app: ElectronApplication, page: Page, width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, size) => { BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height); }, { width, height });
  await page.waitForTimeout(500);
}
async function addHost(page: Page, port: number) {
  await page.getByTestId('sidebar-settings').click();
  await page.getByTestId('settings-host-picker').click(); await page.getByTestId('settings-add-host').click();
  await page.getByRole('button', { name: 'Direct connection', exact: true }).click();
  await page.getByTestId('direct-host-input').fill('127.0.0.1');
  await page.getByTestId('direct-port-input').fill(String(port));
  await page.getByTestId('direct-host-submit').click();
  await expect(page.getByTestId('add-host-modal')).toHaveCount(0, { timeout: 30000 });
}

test('[native] connect both owned loopback hosts through Add Host and verify host identity', async ({ native }) => {
  const { page, lease } = native;
  const [a, b] = lease.hosts;
  for (const host of [a, b]) { await state(host, 'available'); await configure(host, 'available'); }
  await expect(page.getByTestId('plugin-surface-title')).toHaveText('Fleet', { timeout: 60000 });
  // Fresh profile: every host is added through the actual direct-loopback UI, never a
  // copied personal configuration or an external relay/LAN endpoint.
  await addHost(page, a.port);
  await addHost(page, b.port);
  // Rename through the real host settings so both app labels collide on purpose.
  await page.getByTestId('sidebar-settings').click();
  await page.getByTestId('settings-host-picker').click();
  const options = page.locator('[data-testid^="settings-host-picker-item-"]');
  await expect(options).toHaveCount(2);
  const ids = await options.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')!));
  await page.keyboard.press('Escape');
  let primaryIndex = -1, secondaryIndex = -1;
  for (const [index, id] of ids.entries()) {
    await page.getByTestId('settings-host-picker').click(); await page.getByTestId(id).click();
    await page.getByTestId('settings-host-section-connections').click();
    const connection = await page.getByTestId('host-page-connections-card').innerText();
    if (connection.includes(`:${a.port}`)) primaryIndex = index;
    if (connection.includes(`:${b.port}`)) secondaryIndex = index;
    await page.getByTestId('host-page-label-edit-button').click(); await page.getByTestId('host-page-rename-modal-input').fill('Qualification'); await page.getByTestId('host-page-rename-modal-submit').click();
  }
  expect(primaryIndex).toBeGreaterThanOrEqual(0); expect(secondaryIndex).toBeGreaterThanOrEqual(0);
  await navigate(page, 'issues'); await select(page, 'issues');
  await page.getByTestId('plugin-host-filter-trigger').click();
  const choices = page.getByRole('button', { name: 'Qualification', exact: true });
  await expect(choices).toHaveCount(2);
  // Identical labels and deployment IDs: only the selected endpoint's synthetic data may render.
  await choices.nth(secondaryIndex).click();
  await expect(page.getByText(/host-b synthetic issue 42/).first()).toBeVisible({ timeout: 65000 });
  expect((await readFile(b.calls, 'utf8')).trim().split('\n').filter(Boolean).length).toBeGreaterThan(0);
  await page.getByTestId('plugin-host-filter-trigger').click(); await choices.nth(primaryIndex).click();
  await expect(page.getByText(/host-a synthetic issue 42/).first()).toBeVisible({ timeout: 65000 });
});

test('[native] four views in light and dark are captured from the actual window', async ({ native }) => {
  const { page, lease, tool } = native;
  const host = lease.hosts[0];
  await state(host, 'available'); await configure(host, 'available');
  for (const theme of ['light', 'dark'] as const) {
    await nativeTheme(page, theme);
    for (const view of views) {
      await navigate(page, view); await select(page, view); await assertState(page, view, 'available');
      const size = await capture(page, lease, { id: `${TARGET_ID}-${view}-available-${theme}`, view, theme, scenario: 'available', tool });
      expect(size.width).toBeGreaterThan(0); expect(size.height).toBeGreaterThan(0);
    }
  }
});

test('[native] deployment detail, keyboard activation and nested scrolling stay reachable', async ({ native }) => {
  const { page, lease, app, tool } = native;
  await nativeTheme(page, 'light');
  await resize(app, page, 420, 900);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(420);
  for (const view of views) {
    await navigate(page, view); await select(page, view);
    const control = page.getByRole('button', { name: detailControl[view], exact: true });
    await control.focus(); await page.keyboard.press('Enter');
    await expect(page.getByText(view === 'fleet' ? /Page 1\./ : view === 'issues' ? /Dependencies: no open blockers observed/ : view === 'runs' ? /Detail evidence — loaded only on selection/ : /Artifact metadata only/).first()).toBeVisible({ timeout: 30000 });
    const end = page.getByTestId(`orbi-${view === 'fleet' ? 'issues' : view}`).getByRole('button', { name: 'Refresh', exact: true }).last();
    await end.scrollIntoViewIfNeeded(); await expect(end).toBeInViewport();
    await capture(page, lease, { id: `${TARGET_ID}-${view}-detail-light`, view, theme: 'light', scenario: 'detail', tool, supplemental: true });
    // No control may request a mutation from this read-only surface.
    expect(await page.getByRole('button', { name: /^(Retry|Requeue|Merge|Approve|Restart|Stop service)$/i }).count()).toBe(0);
  }
  await resize(app, page, 1280, 900);
});

test('[native] refresh, error, stale retention and a disconnected host reconnect without fallback', async ({ native }) => {
  const { page, lease, tool } = native;
  const [a] = lease.hosts;
  await nativeTheme(page, 'dark');
  await state(a, 'unavailable'); await configure(a, 'available');
  await navigate(page, 'fleet'); await select(page, 'fleet'); await assertState(page, 'fleet', 'unavailable');
  await expect(page.getByText(/Ask the operator to check/).first()).toBeVisible();
  await capture(page, lease, { id: `${TARGET_ID}-fleet-unavailable-dark`, view: 'fleet', theme: 'dark', scenario: 'unavailable', tool, supplemental: true });
  // Only the fixture writer repairs; the observer never mutates the host.
  await state(a, 'available'); await page.waitForTimeout(30100); await refresh(page, 'fleet'); await assertState(page, 'fleet', 'available');
  await state(a, 'stale'); await page.waitForTimeout(30100); await refresh(page, 'fleet');
  await capture(page, lease, { id: `${TARGET_ID}-fleet-stale-dark`, view: 'fleet', theme: 'dark', scenario: 'stale', tool, supplemental: true });
  // A loopback endpoint that is never listened on models a real disconnect: the app must
  // report an offline/refused state, never another host's synthetic data.
  await page.getByTestId('sidebar-settings').click();
  await page.getByTestId('settings-host-picker').click(); await page.getByTestId('settings-add-host').click();
  await page.getByRole('button', { name: 'Direct connection', exact: true }).click();
  const dead = lease.native.disconnectedHost.split(':').at(-1)!;
  await page.getByTestId('direct-host-input').fill('127.0.0.1'); await page.getByTestId('direct-port-input').fill(dead); await page.getByTestId('direct-host-submit').click();
  await page.waitForTimeout(1000);
  await expect(page.getByText(/Selected host is offline|Plugin host is offline|Failed to connect|Could not connect|Connection refused|ECONNREFUSED/i).first()).toBeVisible({ timeout: 30000 });
  await capture(page, lease, { id: `${TARGET_ID}-fleet-disconnected-dark`, view: 'fleet', theme: 'dark', scenario: 'disconnected', tool, supplemental: true });
  // Reconnect to the live owned endpoint and verify the correct host data returns.
  if (await page.getByTestId('add-host-modal').count()) await page.keyboard.press('Escape');
  await page.getByTestId('sidebar-settings').click();
  await page.getByTestId('settings-host-picker').click();
  await page.locator('[data-testid^="settings-host-picker-item-"]').first().click();
  await state(a, 'available'); await navigate(page, 'fleet'); await select(page, 'fleet'); await refresh(page, 'fleet');
  await assertState(page, 'fleet', 'available');
  expect(JSON.parse(await cli(a, 'ls', 'paseo-orbi', '--json'))[0].status).toBe('running');
});

test('[native] window background and foreground keep state without duplicated refresh', async ({ native }) => {
  const { page, lease, app } = native;
  const a = lease.hosts[0];
  await navigate(page, 'issues'); await select(page, 'issues'); await assertState(page, 'issues', 'available');
  const count = async () => (await readFile(a.calls, 'utf8')).trim().split('\n').filter(Boolean).length;
  const before = await count();
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.blur(); window.hide(); });
  await page.waitForTimeout(1500);
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('plugin-surface-title')).toHaveText('Issues');
  await assertState(page, 'issues', 'available');
  expect(await count() - before).toBeLessThanOrEqual(2);
});

test('[native] disposable plugin install/reload/disable/re-enable/removal recovers the client', async ({ native }) => {
  const { page, lease } = native;
  const [a] = lease.hosts;
  const rows = async () => JSON.parse(await cli(a, 'ls', 'paseo-orbi', '--json'));
  expect((await rows())[0].status).toBe('running');
  // Test-only lifecycle on the disposable daemon: reload, disable, re-enable, remove, reinstall.
  await cli(a, 'reload', 'paseo-orbi');
  await expect.poll(async () => (await rows())[0]?.status).toBe('running');
  await cli(a, 'disable', 'paseo-orbi');
  expect((await rows())[0].enabled).toBe(false);
  await refresh(page, 'issues');
  await expect(page.getByText(/Plugin host is offline|Plugin is disabled|not running|unavailable/i).first()).toBeVisible({ timeout: 65000 });
  await cli(a, 'enable', 'paseo-orbi');
  await expect.poll(async () => (await rows())[0]?.enabled).toBe(true);
  await expect.poll(async () => (await rows())[0]?.status).toBe('running');
  await refresh(page, 'issues'); await assertState(page, 'issues', 'available');
  await cli(a, 'remove', 'paseo-orbi');
  expect(await rows()).toEqual([]);
  await refresh(page, 'issues');
  await expect(page.getByText(/plugin|not installed|unavailable/i).first()).toBeVisible({ timeout: 65000 });
  await cli(a, 'install', lease.hosts[0].candidate, '--id', 'paseo-orbi');
  await expect.poll(async () => (await rows())[0]?.status).toBe('running');
  await refresh(page, 'issues'); await assertState(page, 'issues', 'available');
  // Final removal stays with the ownership-aware global teardown, which also verifies ports.
  await expect(page.getByTestId('plugin-surface-title')).toHaveText('Issues');
});
