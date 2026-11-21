import { test } from '../fixtures/browser';
import { state as setScenario } from '../fixtures/browser';
import { theme } from '../fixtures/browser';
import { start } from '../harness';
import { hostFirstScreenshots, hostFirstTitles as titles, hostFirstCaptureTitle } from './contract.mjs';
import {
  openPlugin, openNav, openWork, openServices, pressEnter, configureHost, assertServicesState,
  captureOverview, hostCalls, expect, type Lease, type OverviewCase,
} from './fixtures';

const shots = hostFirstScreenshots as OverviewCase[];

// Add the second owned daemon through the real Add Host flow and rename both
// hosts to the same label, so a host switch is decided by host identity only.
// Safe to repeat: an already-added host is not added twice.
async function preparePair(page: import('@playwright/test').Page, lease: Lease) {
  const [a, b] = lease.hosts;
  await page.goto(a.url);
  await page.getByTestId('sidebar-settings').click();
  await page.getByTestId('settings-host-picker').click();
  const options = page.locator('[data-testid^="settings-host-picker-item-"]');
  if (await options.count() === 1) {
    await page.getByTestId('settings-add-host').click();
    await page.getByRole('button', { name: 'Direct connection', exact: true }).click();
    await page.getByTestId('direct-host-input').fill('127.0.0.1');
    await page.getByTestId('direct-port-input').fill(String(b.port));
    await page.getByTestId('direct-host-submit').click();
    await expect(page.getByTestId('add-host-modal')).toHaveCount(0, { timeout: 30000 });
  } else await page.keyboard.press('Escape');
  await page.getByTestId('settings-host-picker').click();
  await expect(options).toHaveCount(2);
  const ids = await options.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')!));
  await page.keyboard.press('Escape');
  let primary = -1, secondary = -1;
  for (const [index, id] of ids.entries()) {
    await page.getByTestId('settings-host-picker').click();
    await page.getByTestId(id).click();
    await page.getByTestId('settings-host-section-connections').click();
    const connection = await page.getByTestId('host-page-connections-card').innerText();
    if (connection.includes(`:${a.port}`)) primary = index;
    if (connection.includes(`:${b.port}`)) secondary = index;
    await page.getByTestId('host-page-label-edit-button').click();
    await page.getByTestId('host-page-rename-modal-input').fill('Qualification');
    await page.getByTestId('host-page-rename-modal-submit').click();
  }
  expect(primary).toBeGreaterThanOrEqual(0);
  expect(secondary).toBeGreaterThanOrEqual(0);
  return { primary, secondary };
}
async function switchHost(page: import('@playwright/test').Page, index: number) {
  await page.getByTestId('plugin-host-filter-trigger').click();
  await page.getByRole('button', { name: 'Qualification', exact: true }).nth(index).click();
  await expect(page.getByTestId('orbi-services-heading')).toBeVisible();
}

test(titles[0], async ({ page, lease }) => {
  const host = lease.hosts[0];
  await setScenario(host, 'available'); await configureHost(host, 'available');
  await openServices(page, host);
  const demo = page.getByTestId('orbi-family-orbi-demo');
  // Every observed group is listed without a tap: no chevron, no accordion.
  await expect(demo.getByText('Slot 2 · Timer failed', { exact: true })).toBeVisible();
  await expect(demo.getByText('Running', { exact: true }).first()).toBeVisible();
  await expect(demo.getByText('Timer waiting', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('orbi-family-orbi-analytics-pipeline-with-a-very-long-family-name')).toBeVisible();
  await expect(page.locator('[data-testid^="orbi-chevron-"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Expand|Collapse) / })).toHaveCount(0);
  // Keyboard-only diagnostics; raw unit data stays off every row.
  await pressEnter(page, 'button', 'Details for Example/project');
  await expect(page.getByTestId('orbi-service-details-heading')).toHaveText(/^Service details · /);
  await expect(page.getByText('The timer schedules a check. The worker runs it. They are two parts of the same slot, not two workers.', { exact: true })).toBeVisible();
  await expect(page.getByText('Slot 1 · Worker running · Timer waiting', { exact: true })).toBeVisible();
  await expect(page.getByText('Slot 2 · Worker activating/start · Timer failed', { exact: true })).toBeVisible();
  await expect(page.getByText('Slot 3 · Worker active/exited · Timer not observed', { exact: true })).toBeVisible();
  await expect(page.getByTestId('orbi-service-units')).toContainText('orbi-demo@1.service');
  // Back restores the same list, in the same failure-first order.
  await pressEnter(page, 'button', 'Back to services');
  await expect(page.getByTestId('orbi-services-heading')).toBeVisible();
  await expect(page.locator('[data-testid^="orbi-family-"]')).toHaveCount(3);
  await expect(page.getByTestId('orbi-family-orbi-demo')).not.toContainText('orbi-demo@1.service');
});

test(titles[1], async ({ page, lease }) => {
  const host = lease.hosts[0];
  await setScenario(host, 'available'); await configureHost(host, 'available');
  await openServices(page, host);
  await pressEnter(page, 'button', 'Details for Example/project');
  await expect(page.getByText(/Matches configured deployment Demo \(Example\/project\) by unit name/)).toBeVisible();
  await expect(page.getByText(/Unit activity does not establish issue delivery\./)).toBeVisible();
  // The authorized association is the only drill-down route.
  await pressEnter(page, 'button', 'View repository Demo');
  await expect(page.getByTestId('plugin-surface-title')).toHaveText('Issues');
  await expect(page.getByText('Issues — select a repository to browse', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select Demo', exact: true }).click();
  await expect(page.getByText(/host-a synthetic issue 42/).first()).toBeVisible();
  // Keyboard return to Orbi, then the persistent Services navigation.
  await pressEnter(page, 'button', 'Orbi');
  await openNav(page, 'Services');
  await expect(page.getByTestId('orbi-services-heading')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Details for Example/project', exact: true })).toBeVisible();
});

test(titles[2], async ({ page, lease }) => {
  const host = lease.hosts[0];
  await setScenario(host, 'available'); await configureHost(host, 'norepo');
  await openServices(page, host);
  await expect(page.getByText('No configured deployments.', { exact: true })).toBeVisible();
  const unclaimed = page.getByTestId('orbi-family-orbi-unclaimed');
  await expect(unclaimed.getByText('Unlinked', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^View repository / })).toHaveCount(0);
  await pressEnter(page, 'button', 'Details for orbi-unclaimed');
  await expect(page.getByText(/Discovered on this host only; no configured deployment claims this unit name/)).toBeVisible();
});

test(titles[3], async ({ page, lease }) => {
  const isolated = await start({ ...process.env, PASEO_E2E_OUTPUT: `${lease.input.output}/inventory-off` }, 'available', 'host-first', false);
  lease.hosts.push(...isolated.hosts);
  try {
    const host = isolated.hosts[0];
    await openServices(page, host);
    await expect(page.getByText('Service check off · activity unknown', { exact: true })).toBeVisible();
    await pressEnter(page, 'button', 'Set up service access');
    await expect(page.getByText(/PASEO_ORBI_HOST_INVENTORY=1/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh services', exact: true })).toHaveCount(0);
    // The authorized catalog is independent of the inventory opt-in: Work keeps
    // its GitHub issue rows and one activated row opens the real issue screen.
    await openWork(page, host);
    await pressEnter(page, 'button', 'Inspect issue 42');
    await expect(page.getByTestId('plugin-surface-title')).toHaveText('Issues');
    await expect(page.getByText(/host-a synthetic issue 42/).first()).toBeVisible();
    const calls = await hostCalls(host);
    expect(calls.some((call: { args: string[] }) => call.args.includes('list-units') || call.args.includes('list-unit-files'))).toBe(false);
  } finally {
    lease.hosts.splice(lease.hosts.length - isolated.hosts.length);
    await isolated.cleanup();
  }
});

test(titles[4], async ({ page, lease }) => {
  const host = lease.hosts[0];
  await setScenario(host, 'available'); await configureHost(host, 'unsupported');
  await openServices(page, host);
  await expect(page.getByText('Demo (Example/project): unsupported_source_profile', { exact: true })).toBeVisible();
  await expect(page.getByText(/Ask the operator to repair the authorized configuration\/source profile/)).toBeVisible();
  await pressEnter(page, 'button', 'Details for Example/project');
  await expect(page.getByText(/its source profile is unsupported for repository detail\. This compatibility limit does not mean the runner is broken\./)).toBeVisible();
  await expect(page.getByRole('button', { name: /^View repository / })).toHaveCount(0);
});

test(titles[5], async ({ page, lease }) => {
  const host = lease.hosts[0];
  await configureHost(host, 'available'); await setScenario(host, 'denied');
  await openServices(page, host);
  await expect(page.getByText('installed: process_failed', { exact: true })).toBeVisible();
  // Confirmed runtime families survive; a denied source is never an empty host.
  await expect(page.getByTestId('orbi-family-orbi-demo')).toBeVisible();
  await expect(page.getByText('No Orbi units found.', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/^0 groups/)).toHaveCount(0);
  await expect(page.getByTestId('orbi-attention-count')).toHaveCount(0);
});

test(titles[6], async ({ page, lease }) => {
  const [a, b] = lease.hosts;
  for (const host of [a, b]) { await setScenario(host, 'available'); await configureHost(host, 'available'); }
  const { primary, secondary } = await preparePair(page, lease);
  await openServices(page, a);
  await switchHost(page, primary);
  await expect(page.getByTestId('orbi-services-heading')).toHaveText('Services · Qualification');
  await pressEnter(page, 'button', 'Details for Example/project');
  await expect(page.getByText('Slot 1 · Worker running · Timer waiting', { exact: true })).toBeVisible();
  await page.getByTestId('plugin-host-filter-trigger').click();
  await page.getByRole('button', { name: 'Qualification', exact: true }).nth(secondary).click();
  await expect(page.getByTestId('orbi-services-heading')).toHaveText('Services · Qualification');
  // Identical labels: only the selected host identity decides the rows, and the
  // previous host's diagnostic view never survives the switch.
  await expect(page.getByTestId('orbi-service-details')).toHaveCount(0);
  await expect(page.getByText('Slot 1 · Worker running · Timer waiting', { exact: true })).toHaveCount(0);
  await pressEnter(page, 'button', 'Details for Example/project');
  await expect(page.getByText('Slot 4 · Worker running · Timer waiting', { exact: true })).toBeVisible();
});

test(titles[7], async ({ page, lease, network }) => {
  const [a, b] = lease.hosts;
  for (const host of [a, b]) { await setScenario(host, 'available'); await configureHost(host, 'available'); }
  const { primary, secondary } = await preparePair(page, lease);
  await openServices(page, a);
  await switchHost(page, primary);
  await expect(page.getByText('Services: Current', { exact: true })).toBeVisible();
  // Delay the selected host's inventory read, then switch hosts.
  await setScenario(a, 'late');
  await pressEnter(page, 'button', 'Refresh services');
  await switchHost(page, secondary);
  await pressEnter(page, 'button', 'Details for Example/project');
  await expect(page.getByText('Slot 4 · Worker running · Timer waiting', { exact: true })).toBeVisible();
  await page.waitForTimeout(2200);
  await expect(page.getByText('Slot 1 · Worker running · Timer waiting', { exact: true })).toHaveCount(0);
  await setScenario(a, 'available');
  // Back restores the same host-B list before the disconnect.
  await pressEnter(page, 'button', 'Back to services');
  await expect(page.getByTestId('orbi-services-heading')).toBeVisible();
  // Offline keeps known history as unknown, never as confirmed absence.
  network.blocked.add(b.port);
  for (const socket of network.sockets) if (Number(new URL(socket.url()).port) === b.port) await socket.close();
  await expect(page.getByText(/Offline · current activity unknown/)).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('No Orbi units found.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Services: Current', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Last seen /).first()).toBeVisible();
  // Without same-host history the same offline host may publish no count at all.
  const fresh = await page.context().newPage();
  try {
    await openServices(fresh, a);
    await fresh.getByTestId('plugin-host-filter-trigger').click();
    await fresh.getByRole('button', { name: 'Qualification', exact: true }).nth(secondary).click();
    await expect(fresh.getByText(/Offline · current activity unknown|Unavailable · current activity unknown\./)).toBeVisible({ timeout: 30000 });
    await expect(fresh.getByText('No Orbi units found.', { exact: true })).toHaveCount(0);
    await expect(fresh.getByText(/^[0-9]+ of [0-9]+ groups/)).toHaveCount(0);
  } finally { await fresh.close(); }
  network.blocked.delete(b.port);
});

test(titles[8], async ({ page, lease }) => {
  const host = lease.hosts[0];
  await setScenario(host, 'available'); await configureHost(host, 'available');
  await openWork(page, host);
  await expect(page.getByTestId('plugin-surface-title')).toHaveText('Work');
  await expect(page.getByText(/host-a synthetic issue 42/).first()).toBeVisible();
  await expect(page.getByTestId('orbi-label-chip').first()).toBeVisible();
  // The service inventory is not embedded in Work; its one-line health summary
  // links straight to the Services screen.
  await expect(page.getByTestId('orbi-host-services')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Services summary', exact: true })).toBeVisible();
  await expect(page.getByTestId('orbi-navigation').getByRole('button')).toHaveCount(3);
  await pressEnter(page, 'button', 'Open Services');
  await expect(page.getByTestId('orbi-services-heading')).toBeVisible();
  // A confirmed unconfigured host lands on Services with one notice and Setup guide.
  const unconfigured = await start({ ...process.env, PASEO_E2E_OUTPUT: `${lease.input.output}/unconfigured-landing` }, 'unconfigured', 'host-first');
  lease.hosts.push(...unconfigured.hosts);
  try {
    await openPlugin(page, unconfigured.hosts[0]);
    await expect(page.getByTestId('plugin-surface-title')).toHaveText('Services');
    await expect(page.getByText('Repositories aren’t linked. Link repositories to see GitHub issues.', { exact: true })).toHaveCount(1);
    await expect(page.getByTestId('orbi-host-services')).toBeVisible();
    // Explicit Work navigation is preserved and still shows the single notice.
    await openNav(page, 'Work');
    await expect(page.getByTestId('plugin-surface-title')).toHaveText('Work');
    await expect(page.getByTestId('orbi-work-heading')).toBeVisible();
    await expect(page.getByText('Repositories aren’t linked. Link repositories to see GitHub issues.', { exact: true })).toHaveCount(1);
    await expect(page.getByTestId('orbi-work-issues')).toHaveCount(0);
  } finally {
    lease.hosts.splice(lease.hosts.length - unconfigured.hosts.length);
    await unconfigured.cleanup();
  }
});

test(hostFirstCaptureTitle, async ({ page, lease, browser }) => {
  const host = lease.hosts[0];
  for (const c of shots.filter(item => item.state !== 'unconfigured')) {
    await configureHost(host, 'available');
    await setScenario(host, c.scenario);
    await theme(page, host.url, c.theme);
    await page.setViewportSize(c.viewport);
    await openServices(page, host);
    if (c.details) {
      await pressEnter(page, 'button', `Details for ${c.details}`);
      await expect(page.getByTestId('orbi-service-details-heading')).toHaveText(/^Service details · /);
      await expect(page.getByTestId('orbi-service-units')).toBeVisible();
    }
    await captureOverview(page, lease, browser.version(), c);
  }
  await configureHost(host, 'available'); await setScenario(host, 'available');
  const unconfigured = shots.find(item => item.state === 'unconfigured')!;
  const isolated = await start({ ...process.env, PASEO_E2E_OUTPUT: `${lease.input.output}/unconfigured` }, 'unconfigured', 'host-first');
  lease.hosts.push(...isolated.hosts);
  try {
    await theme(page, isolated.hosts[0].url, unconfigured.theme);
    await page.setViewportSize(unconfigured.viewport);
    await openServices(page, isolated.hosts[0]);
    await captureOverview(page, lease, browser.version(), unconfigured);
  } finally {
    lease.hosts.splice(lease.hosts.length - isolated.hosts.length);
    await isolated.cleanup();
  }
});
