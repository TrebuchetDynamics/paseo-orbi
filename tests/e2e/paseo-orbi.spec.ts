import { readFile } from 'node:fs/promises';
import { test, expect, navigate, select, state, configure, refresh, pageRefresh, assertState, cli } from './fixtures/browser';

const views = ['fleet', 'issues', 'runs', 'blockers'];
for (const view of views) {
  test(`[smoke] ${view}: sidebar, deployment, actual detail, keyboard and narrow scrolling`, async ({ page, lease }) => {
    const host = lease.hosts[0]; await state(host, 'available'); await configure(host, 'available');
    await page.goto(host.url); await navigate(page, view); await select(page, view);
    await assertState(page, view, 'available');
    const name = view === 'fleet' ? 'Active work for Demo' : view === 'issues' ? 'Inspect issue 42' : view === 'runs' ? 'Inspect run 42 84360d31' : 'Inspect blocker 43';
    const control = page.getByRole('button', { name, exact: true });
    await control.focus(); await page.keyboard.press('Enter');
    await expect(page.getByText(view === 'fleet' ? /Page 1\./ : view === 'issues' ? /Dependencies: no open blockers observed/ : view === 'runs' ? /Detail evidence — loaded only on selection/ : /Artifact metadata only/).first()).toBeVisible();
    await page.setViewportSize({ width: 375, height: 667 });
    const target = view === 'fleet' ? 'issues' : view;
    const end = page.getByTestId(`orbi-${target}`).getByRole('button', { name: pageRefresh(target), exact: true }).last();
    await end.scrollIntoViewIfNeeded(); await expect(end).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    expect(await page.getByRole('button', { name: /^(Retry|Requeue|Merge|Approve|Restart|Stop service)$/i }).count()).toBe(0);
  });
  for (const scenario of ['empty', 'partial', 'unavailable', 'stale']) test(`${view}: ${scenario}, external repair and safe Refresh`, async ({ page, lease }) => {
    const host = lease.hosts[0];
    await state(host, scenario === 'stale' ? 'available' : scenario); await configure(host, 'available');
    await page.goto(host.url); await navigate(page, view); await select(page, view);
    if (scenario === 'partial' && view === 'issues') await page.getByRole('button', { name: 'Inspect issue 42', exact: true }).click();
    if (scenario === 'stale') { await assertState(page, view, 'available'); await state(host, 'stale'); await page.waitForTimeout(30100); await refresh(page, view); }
    await assertState(page, view, scenario);
    if (scenario !== 'empty') {
      // Runs and Blockers print a repair step only next to the code they reported:
      // a 401 reports auth_denied, the partial fixture reports network_failed.
      const repair = view === 'fleet' ? /Ask the operator to check/ : view === 'issues' ? /auth_denied: ask the operator/
        : /Ask the operator to repair the daemon user's existing gh authentication|Repair access externally, then Refresh/;
      await expect(page.getByText(repair).first()).toBeVisible();
      await state(host, 'available'); // only fixture writer repairs; the observer never mutates
      await page.waitForTimeout(30100); await refresh(page, view);
      await assertState(page, view, 'available');
    }
  });
}
test('invalid and missing configuration, unknown source profile refuse telemetry', async ({ page, lease }) => {
  const host = lease.hosts[0];
  for (const mode of ['invalid', 'unconfigured', 'rejected-profile']) {
    const before = (await readFile(host.calls, 'utf8')).length;
    await configure(host, mode); await page.goto(host.url); await navigate(page, 'fleet');
    await expect(page.getByText(mode === 'rejected-profile' ? /unsupported_source_profile/ : /Invalid configuration: ask the operator/).first()).toBeVisible();
    expect((await readFile(host.calls, 'utf8')).length).toBe(before);
  }
  await configure(host, 'available'); await page.reload(); await assertState(page, 'fleet', 'available');
});
test('refresh coalesces, polls at 30 seconds and selection-only detail ages at 60 seconds', async ({ page, lease }) => {
  const host = lease.hosts[0]; await state(host, 'available'); await configure(host, 'available');
  await page.goto(host.url); await navigate(page, 'fleet'); await assertState(page, 'fleet', 'available');
  const count = async () => (await readFile(host.calls, 'utf8')).trim().split('\n').filter(Boolean).length;
  const before = await count(), start = Date.now();
  await page.waitForTimeout(31000);
  expect(Date.now() - start).toBeGreaterThanOrEqual(30000); expect(await count()).toBeGreaterThan(before);
  await state(host, 'late');
  // Exercise Fleet telemetry, not the shared catalog read.
  const control = page.getByTestId('orbi-fleet').getByRole('button', { name: 'Refresh', exact: true }).first();
  await control.click(); await expect(control).toBeDisabled();
  // Disabled UI does not issue a second request; every unit is read once per refresh.
  const during = await count(); await page.waitForTimeout(200);
  expect(await count() - during).toBeLessThanOrEqual(2);
  await expect(control).toBeEnabled();
  await state(host, 'available'); await navigate(page, 'runs'); await select(page, 'runs');
  await page.getByRole('button', { name: 'Inspect run 42 84360d31', exact: true }).click();
  await expect(page.getByText(/Detail evidence — loaded only on selection/)).toBeVisible();
  const detailStamp = await page.getByTestId('orbi-runs').getByText(/Observed: .*Last success:/).last().innerText(), agingStart = Date.now();
  // #134: the rendered observation line is a local time, never the raw ISO stamp.
  expect(detailStamp).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  await page.waitForTimeout(60100);
  expect(Date.now() - agingStart).toBeGreaterThanOrEqual(60000);
  await expect(page.getByTestId('orbi-runs').getByLabel('Observation status: stale', { exact: true }).last()).toBeVisible();
  expect(await page.getByTestId('orbi-runs').getByText(/Observed: .*Last success:/).last().innerText()).toBe(detailStamp);
});
test('two hosts with identical labels/IDs: selected detail/page, late result, no fallback and disconnect/reconnect', async ({ page, lease, network }) => {
  const [a, b] = lease.hosts;
  for (const host of [a, b]) { await state(host, 'available'); await configure(host, 'available'); }
  await page.goto(a.url);
  await page.getByTestId('sidebar-settings').click();
  await page.getByTestId('settings-host-picker').click(); await page.getByTestId('settings-add-host').click();
  await page.getByRole('button', { name: 'Direct connection', exact: true }).click();
  await page.getByTestId('direct-host-input').fill('127.0.0.1'); await page.getByTestId('direct-port-input').fill(String(b.port)); await page.getByTestId('direct-host-submit').click();
  await expect(page.getByTestId('add-host-modal')).toHaveCount(0, { timeout: 30000 });
  // Rename via actual host settings. Both labels and deployment IDs intentionally collide.
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
  await page.goto(a.url); await navigate(page, 'issues');
  await page.getByTestId('plugin-host-filter-trigger').click(); await page.getByRole('button', { name: 'Qualification', exact: true }).nth(primaryIndex).click();
  await select(page, 'issues');
  await page.getByRole('button', { name: 'Inspect issue 42', exact: true }).click();
  await expect(page.getByText(/Reported run: 84360d31/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText(/Page 2\./)).toBeVisible();
  await state(a, 'late'); await page.getByRole('button', { name: 'Inspect issue 142', exact: true }).click();
  await page.getByTestId('plugin-host-filter-trigger').click();
  const choices = page.getByRole('button', { name: 'Qualification', exact: true }); await expect(choices).toHaveCount(2); await choices.nth(secondaryIndex).click();
  await expect(page.getByText(/host-b synthetic issue 42/).first()).toBeVisible();
  await expect(page.getByText(/Page 2\./)).toHaveCount(0); // local selection identity, not just cache keys
  // A detail request reads issue, comments, then dependencies sequentially. Wait
  // for its final delayed stand-in to complete, not merely the first 1.8s read.
  await expect.poll(async () => (await readFile(a.calls, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).some(call =>
    call.scenario === 'late' && call.phase === 'completed' && call.args.at(-1) === 'repos/Example/project/issues/142/dependencies/blocked_by?per_page=100&page=1'
  )).toBe(true);
  await page.waitForTimeout(1000); // permit the real RPC/React delivery after the last process exits
  await expect(page.getByText(/host-a synthetic issue/)).toHaveCount(0);
  const beforeA = (await readFile(a.calls, 'utf8')).length;
  network.blocked.add(b.port);
  for (const socket of network.sockets) if (Number(new URL(socket.url()).port) === b.port) await socket.close();
  await expect(page.getByText(/Selected host is offline|Plugin host is offline/).first()).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('orbi-issues').getByRole('button', { name: pageRefresh('issues'), exact: true }).last()).toBeDisabled();
  expect((await readFile(a.calls, 'utf8')).length).toBe(beforeA);
  network.blocked.delete(b.port);
  await expect(page.getByText(/Selected host is offline|Plugin host is offline/)).toHaveCount(0, { timeout: 30000 });
  await refresh(page, 'issues'); await expect(page.getByText(/host-b synthetic issue 42/).first()).toBeVisible();
  // Removal/disposal is performed by global teardown on each explicit owned host.
  expect(JSON.parse(await cli(b, 'ls', 'paseo-orbi', '--json'))[0].status).toBe('running');
});
