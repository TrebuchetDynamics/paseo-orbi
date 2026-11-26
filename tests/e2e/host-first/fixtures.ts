import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, menu, cli, type Lease, type LeaseHost } from '../fixtures/browser';
import { provenance, pngSize, sha256 } from '../evidence.mjs';

export { expect, cli };
export type { Lease, LeaseHost };

export async function pressEnter(page: Page, role: 'button' | 'link', name: string) {
  const control = page.getByRole(role, { name, exact: true });
  await control.focus();
  await page.keyboard.press('Enter');
}

// The single Orbi sidebar entry opens the default route: a configured host lands
// on Work, a confirmed unconfigured host lands on Services.
export async function openPlugin(page: Page, host: LeaseHost) {
  await page.goto(host.url);
  await menu(page);
  await pressEnter(page, 'button', 'Orbi');
  await expect(page.getByTestId('plugin-surface-title')).toHaveText(/^(Work|Services)$/);
}

// Persistent Work / Services / Runs navigation, keyboard-only activation.
export async function openNav(page: Page, route: 'Work' | 'Services' | 'Runs') {
  await pressEnter(page, 'button', `Open ${route}`);
  await expect(page.getByTestId('plugin-surface-title')).toHaveText(route);
}

export async function openWork(page: Page, host: LeaseHost) {
  await openPlugin(page, host);
  await openNav(page, 'Work');
  await expect(page.getByTestId('orbi-work')).toBeVisible();
}

export async function openServices(page: Page, host: LeaseHost) {
  await openPlugin(page, host);
  await openNav(page, 'Services');
  await expect(page.getByTestId('orbi-services-heading')).toBeVisible();
}

// Startup-only inventory authorization is separate from the authorized catalog:
// removing/emptying the config never toggles inventory, and inventory never
// grants repository detail.
export async function configureHost(host: LeaseHost, kind: 'available' | 'norepo' | 'unsupported') {
  await writeFile(host.data.authorization, JSON.stringify({ schema: 1, deployments: kind === 'norepo' ? []
    : [{ ...(host.data.entry as Record<string, unknown>), ...(kind === 'unsupported' ? { adapter: 'unknown-source-profile' } : {}) }] }));
  await cli(host, 'reload', 'paseo-orbi');
}

export async function assertServicesState(page: Page, state: 'complete' | 'partial' | 'unconfigured') {
  if (state === 'complete') {
    await expect(page.getByText('Services: Current', { exact: true })).toBeVisible();
    await expect(page.getByText('1 of 3 groups needs attention', { exact: true })).toBeVisible();
  } else if (state === 'partial') {
    await expect(page.getByText('Services: Partial', { exact: true })).toBeVisible();
    await expect(page.getByText('Partial · units may be missing.', { exact: true })).toBeVisible();
    await expect(page.getByText('installed: process_failed', { exact: true })).toBeVisible();
  } else {
    // One notice with an instructions-only guide; no repository authority.
    await expect(page.getByText('Repositories aren’t linked. Link repositories to see GitHub issues.', { exact: true })).toBeVisible();
    await pressEnter(page, 'button', 'Setup guide');
    await expect(page.getByText(/PASEO_ORBI_CONFIG/)).toBeVisible();
  }
  // No state may claim confirmed absence without a current complete empty read.
  await expect(page.getByText('No Orbi units found.', { exact: true })).toHaveCount(0);
}

export type OverviewCase = {
  id: string; scenario: string; state: 'complete' | 'partial' | 'unconfigured';
  theme: string; viewport: { width: number; height: number };
  supplemental?: boolean; details?: string;
};

// Capture contract: actual pixels, declared dimensions, source/version/host/state
// metadata and inspection:null. Automatic capture never blesses its own image.
export async function captureOverview(page: Page, lease: Lease, browserVersion: string, c: OverviewCase) {
  await assertServicesState(page, c.state);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1000); // real geometry settles after resize; no fake clocks
  const geometry = () => page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  const before = await geometry();
  await page.waitForTimeout(150);
  expect(await geometry()).toEqual(before);
  expect(before.width).toBeLessThanOrEqual(c.viewport.width);
  await expect(page.locator('body')).not.toContainText(/(?:SECRET|TOKEN|PROMPT|REASONING|PRIVATE)[A-Z_]*CANARY/);
  const path = `${c.id}.png`;
  const bytes = await page.screenshot({ path: join(lease.input.output, path), fullPage: true });
  const size = pngSize(bytes);
  expect(size.width).toBe(c.viewport.width);
  expect(size.height).toBeGreaterThanOrEqual(c.viewport.height);
  const fixture = (await provenance()).find(p => p.profile === lease.hosts[0].profile);
  await writeFile(join(lease.input.output, `${c.id}.shot.json`), JSON.stringify({ ...c, path,
    pixelWidth: size.width, pixelHeight: size.height, sha256: sha256(bytes), expected: 'pass', observed: 'pass', inspection: null,
    pluginSha: lease.input.sha, dirty: false, hostAlias: 'host-a', paseoVersion: '0.15.4', daemonVersion: '0.15.4', appVersion: '0.15.4',
    playwrightVersion: '1.65.1', browser: 'chromium', browserVersion, deviceScaleFactor: 1, observedAt: new Date().toISOString(), fixture }, null, 2));
  return size;
}

export async function hostCalls(host: LeaseHost) {
  const text = (await readFile(host.calls, 'utf8')).trim();
  return text ? text.split('\n').map(line => JSON.parse(line)) : [];
}
