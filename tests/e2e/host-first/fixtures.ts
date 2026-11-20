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

// The shipped Overview title is sourced from client/shell.tsx title('fleet').
export async function openOverview(page: Page, host: LeaseHost) {
  await page.goto(host.url);
  await menu(page);
  await pressEnter(page, 'button', 'Orbi');
  await expect(page.getByTestId('plugin-surface-title')).toHaveText('Overview');
  await expect(page.getByTestId('orbi-overview-heading')).toBeVisible();
}

export async function openRoute(page: Page, route: 'Issues' | 'Runs' | 'Blockers') {
  await page.getByTestId('orbi-navigation').getByRole('button', { name: `Open ${route}`, exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('plugin-surface-title')).toHaveText(route);
}

// Startup-only inventory authorization is separate from the authorized catalog:
// removing/emptying the config never toggles inventory, and inventory never
// grants repository detail.
export async function configureHost(host: LeaseHost, kind: 'available' | 'norepo' | 'unsupported') {
  await writeFile(host.data.authorization, JSON.stringify({ schema: 1, deployments: kind === 'norepo' ? []
    : [{ ...(host.data.entry as Record<string, unknown>), ...(kind === 'unsupported' ? { adapter: 'unknown-source-profile' } : {}) }] }));
  await cli(host, 'reload', 'paseo-orbi');
}

export async function assertOverviewState(page: Page, state: 'complete' | 'partial' | 'unconfigured') {
  if (state === 'complete') {
    await expect(page.getByText('Services: Current', { exact: true })).toBeVisible();
    await expect(page.getByText('3 families · 1 failed', { exact: true })).toBeVisible();
  } else if (state === 'partial') {
    await expect(page.getByText('Services: partial', { exact: true })).toBeVisible();
    await expect(page.getByText('Partial · units may be missing.', { exact: true })).toBeVisible();
    await expect(page.getByText('installed: process_failed', { exact: true })).toBeVisible();
  } else {
    await page.getByRole('button', { name: 'Repository setup', exact: true }).click();
    await expect(page.getByText(/Unconfigured: ask the operator/)).toBeVisible();
  }
  // No state may claim confirmed absence without a current complete empty read.
  await expect(page.getByText('No Orbi units found.', { exact: true })).toHaveCount(0);
}

export type OverviewCase = {
  id: string; scenario: string; state: 'complete' | 'partial' | 'unconfigured';
  theme: string; viewport: { width: number; height: number };
  supplemental?: boolean; expanded?: string;
};

// Capture contract: actual pixels, declared dimensions, source/version/host/state
// metadata and inspection:null. Automatic capture never blesses its own image.
export async function captureOverview(page: Page, lease: Lease, browserVersion: string, c: OverviewCase) {
  await assertOverviewState(page, c.state);
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
