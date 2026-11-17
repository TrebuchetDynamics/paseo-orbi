import { test as base, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { command, environment, sanitize, assertListenerOwned, type Identity } from '../harness';
import { provenance, pngSize, sha256 } from '../evidence.mjs';

type LeaseHost = { initial: Identity; alias: string; profile: string; port: number; url: string; host: string; home: string; state: string; calls: string; env: NodeJS.ProcessEnv; cli: string; candidate: string; data: { authorization: string; entry: unknown } };
type Lease = { root: string; input: { output: string; sha: string }; hosts: LeaseHost[] };
export async function state(host: LeaseHost, scenario: string) {
  const previous = JSON.parse(await readFile(host.state, 'utf8'));
  await writeFile(host.state, JSON.stringify({ ...previous, scenario }));
  const entry = host.data.entry as { repoDir: string };
  await writeFile(join(entry.repoDir, '.orbi/health.json'), ['partial', 'unavailable', 'stale'].includes(scenario) ? '{}' : JSON.stringify({ runs: scenario === 'empty' ? [] : [{ repo: 'Example/project', issue: 42, run_id: '84360d31', outcome: 'pr_opened', fingerprint: 'synthetic', ts: Date.now() / 1000 }], last_pickup_ts: Date.now() / 1000, alerted: [] }));
}
export const cli = async (host: LeaseHost, ...args: string[]) => {
  await assertListenerOwned(host);
  return command(process.execPath, [host.cli, '--host', host.host, 'plugin', ...args], host.env, host.candidate, 10000);
};
export async function configure(host: LeaseHost, kind: string) {
  // Missing path is represented by a nonexistent authorization path only via removing generated data.
  const { rm } = await import('node:fs/promises');
  if (kind === 'unconfigured') await rm(host.data.authorization, { force: true });
  else await writeFile(host.data.authorization, kind === 'invalid' ? '{}' : JSON.stringify({ schema: 1, deployments: [kind === 'rejected-profile' ? { ...(host.data.entry as object), adapter: 'unknown-source-profile' } : host.data.entry] }));
  await cli(host, 'reload', 'paseo-orbi');
}
export const test = base.extend<{ lease: Lease; errors: string[]; network: { blocked: Set<number>; sockets: WebSocketRoute[] } }>({
  network: async ({}, use) => { await use({ blocked: new Set(), sockets: [] }); },
  lease: async ({}, use) => {
    const path = process.env.PASEO_E2E_LEASE;
    if (!path) throw new Error('No owned harness lease; run the approved global setup, never target a default host.');
    await use(JSON.parse(await readFile(path, 'utf8')));
  },
  browser: async ({ playwright, browserName }, use) => {
    const lease: Lease = JSON.parse(await readFile(process.env.PASEO_E2E_LEASE!, 'utf8'));
    const type = playwright[browserName];
    const env = environment(lease.root, join(lease.root, 'host-a-bin'), join(lease.root, 'browser-home'));
    // WebKit's pinned pw_run.sh needs system utilities; these are browser-only,
    // never added to the daemon's strict telemetry PATH. HOME/caches stay owned.
    env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
    for (const path of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME]) await mkdir(path!, { recursive: true });
    const browser = await type.launch({ executablePath: type.executablePath(), env: env as Record<string, string> });
    try { await use(browser); } finally { await browser.close(); }
  },
  context: async ({ browser, lease, network }, use) => {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false });
    const allowed = (url: string) => { try { const u = new URL(url); return ['http:', 'ws:'].includes(u.protocol) && u.hostname === '127.0.0.1' && lease.hosts.some(h => String(h.port) === u.port); } catch { return false; } };
    await context.route('**/*', route => allowed(route.request().url()) ? route.continue() : route.abort('blockedbyclient'));
    await context.routeWebSocket('**/*', socket => { network.sockets.push(socket); if (allowed(socket.url()) && !network.blocked.has(Number(new URL(socket.url()).port))) socket.connectToServer(); else socket.close(); });
    try { await use(context); } finally { await context.close(); }
  },
  errors: [async ({ page, lease }, use, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(sanitize(error.message, [lease.root, process.cwd()])));
    page.on('console', message => { if (message.type() === 'error') errors.push(sanitize(message.text(), [lease.root, process.cwd()])); });
    try { await use(errors); }
    finally {
      await writeFile(join(lease.input.output, `${info.project.name}-${info.line}.browser.log`), errors.join('\n'));
      expect(errors, 'unexpected browser errors').toEqual([]);
      for (const host of lease.hosts) {
        const calls = (await readFile(host.calls, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        expect(calls.every(call => call.allowed === true), 'observer attempted an unapproved command').toBe(true);
      }
    }
  }, { auto: true }],
});
export { expect };
export async function menu(page: Page) {
  const open = page.getByRole('button', { name: 'Open menu', exact: true }).first();
  if (await open.isVisible()) await open.click();
}
export async function navigate(page: Page, view: string) {
  await menu(page);
  await page.getByRole('button', { name: 'Orbi', exact: true }).click();
  await expect(page.getByTestId('plugin-surface-title')).toHaveText('Fleet');
  if (view !== 'fleet') {
    const destination = page.getByTestId('orbi-navigation').getByRole('button', { name: `Open ${view[0].toUpperCase() + view.slice(1)}`, exact: true });
    // RN Pressable keyboard activation must reach the same route owner as a click.
    await destination.focus(); await page.keyboard.press('Enter');
    await expect(page.getByTestId('plugin-surface-title')).toHaveText(view[0].toUpperCase() + view.slice(1));
    await expect(destination).toHaveAttribute('aria-selected', 'true');
  }
}
export async function select(page: Page, view: string) {
  if (view !== 'fleet') await page.getByTestId(`orbi-${view}`).getByRole('button', { name: 'Select Demo', exact: true }).click();
}
export async function refresh(page: Page, view: string) {
  const controls = page.getByTestId(`orbi-${view}`).getByRole('button', { name: 'Refresh', exact: true });
  for (let i = 0; i < await controls.count(); i++) { const control = controls.nth(i); if (await control.isEnabled()) await control.click(); }
}
export async function theme(page: Page, url: string, mode: string) {
  await page.goto(url);
  await menu(page);
  await page.getByTestId('sidebar-settings').click();
  await page.getByTestId('settings-sidebar').getByRole('button', { name: 'Appearance', exact: true }).click();
  const radio = page.getByRole('radio', { name: mode === 'dark' ? 'Dark' : 'Light', exact: true });
  await radio.click(); await expect(radio).toBeChecked();
  await page.goto(url);
}
export async function assertState(page: Page, view: string, scenario: string) {
  if (view === 'catalog') {
    await expect(page.getByText(scenario === 'unconfigured' ? /Unconfigured: ask the operator/ : /unsupported_source_profile/).first()).toBeVisible(); return;
  }
  const status = scenario === 'stale' ? 'stale' : scenario === 'unavailable' ? 'unavailable' : scenario === 'partial' ? 'partial' : 'available';
  // Scope to the actual feature, never a catalog-relative observation index.
  // Partial Issues selects its detail; Runs list remains independent of journal detail.
  const feature = page.getByTestId(`orbi-${view}`);
  const observations = feature.getByLabel(/^Observation status: /);
  const observation = view === 'issues' && scenario === 'partial' ? observations.last() : observations.first();
  await expect(observation).toHaveAttribute('aria-label', `Observation status: ${status}`, { timeout: 65000 });
  await expect(observation).toBeVisible();
  const stamps = feature.getByText(/Observed: .*Last success:/);
  await expect(view === 'issues' && scenario === 'partial' ? stamps.last() : stamps.first()).toBeVisible();
  if (scenario === 'empty') await expect(page.getByText(view === 'fleet' ? 'No recorded runs in the validated health history.' : view === 'issues' ? 'No issues on this observed page.' : view === 'runs' ? 'No attributed runs in this observed scope.' : 'No blockers in the complete observed scope.', { exact: true })).toBeVisible();
  if (scenario === 'available') await expect(page.getByText(view === 'fleet' ? /Configured capacity: 2/ : view === 'runs' ? /run 84360d31/ : new RegExp(`host-a synthetic issue ${view === 'blockers' ? 43 : 42}`)).first()).toBeVisible();
}
export async function capture(page: Page, lease: Lease, browserVersion: string, c: { id: string; view: string; theme: string; scenario: string; viewport: { width: number; height: number }; supplemental?: boolean }) {
  await assertState(page, c.view, c.scenario);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1000); // real geometry settles after resize; no fake clocks
  const geometry = () => page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  const before = await geometry(); await page.waitForTimeout(150); expect(await geometry()).toEqual(before);
  expect(before.width).toBeLessThanOrEqual(c.viewport.width);
  await expect(page.locator('body')).not.toContainText(/(?:SECRET|TOKEN|PROMPT|REASONING|PRIVATE)[A-Z_]*CANARY/);
  const path = `${c.id}.png`, bytes = await page.screenshot({ path: join(lease.input.output, path), fullPage: true });
  const size = pngSize(bytes); expect(size.width).toBe(c.viewport.width); expect(size.height).toBeGreaterThanOrEqual(c.viewport.height);
  const fixture = (await provenance()).find(p => p.profile === lease.hosts[0].profile);
  await writeFile(join(lease.input.output, `${c.id}.shot.json`), JSON.stringify({ ...c, path, pixelWidth: size.width, pixelHeight: size.height, sha256: sha256(bytes), pluginSha: lease.input.sha, dirty: false,
    daemonVersion: '0.15.4', appVersion: '0.15.4', playwrightVersion: '1.65.1', browser: 'chromium', browserVersion, deviceScaleFactor: 1,
    observedAt: new Date().toISOString(), hostAlias: 'host-a', fixture, expected: 'pass', observed: 'pass', inspection: null }, null, 2));
}
