import { test, expect, theme, navigate, select, state, configure, refresh, capture, assertState } from './fixtures/browser';
import { matrix } from './evidence.mjs';
import { start } from './harness';

for (const c of matrix) test(`screenshot ${c.id}`, async ({ page, browser, lease }) => {
  if (c.scenario === 'unconfigured') {
    // Startup authorization is snapshotted by the real plugin. A missing environment
    // requires a NEW owned pair, never patching/restarting an existing daemon.
    const isolated = await start({ ...process.env, PASEO_E2E_OUTPUT: `${lease.input.output}/unconfigured` }, 'unconfigured');
    try {
      lease.hosts.push(...isolated.hosts);
      await theme(page, isolated.hosts[0].url, c.theme); await navigate(page, 'fleet');
      await page.setViewportSize(c.viewport);
      await capture(page, lease, browser.version(), c);
    } finally { lease.hosts.splice(2); await isolated.cleanup(); }
    return;
  }
  const host = lease.hosts[0];
  await state(host, c.scenario === 'stale' ? 'available' : c.scenario);
  await configure(host, c.scenario === 'rejected-profile' ? c.scenario : 'available');
  await theme(page, host.url, c.theme);
  await navigate(page, c.view === 'catalog' ? 'fleet' : c.view);
  if (c.view !== 'catalog') await select(page, c.view);
  if (c.scenario === 'partial' && c.view === 'issues') await page.getByRole('button', { name: 'Inspect issue 42', exact: true }).click();
  if (c.scenario === 'stale') {
    await assertState(page, c.view, 'available');
    await state(host, 'stale');
    // Real server cache has a 30-second TTL. Failed read retains the prior success.
    await page.waitForTimeout(30100); await refresh(page);
  }
  await page.setViewportSize(c.viewport);
  await capture(page, lease, browser.version(), c);
  // Full-page PNG cannot expand nested RN ScrollViews. Also retain reachable detail/end images.
  if (c.scenario === 'available' && c.viewport.width === 375) {
    const control = page.getByRole('button', { name: c.view === 'fleet' ? 'Active work for Demo' : c.view === 'issues' ? 'Inspect issue 42' : c.view === 'runs' ? 'Inspect run 42 84360d31' : 'Inspect blocker 43', exact: true });
    await control.scrollIntoViewIfNeeded(); await expect(control).toBeVisible();
    if (c.view !== 'fleet') { await control.focus(); await page.keyboard.press('Enter'); }
    const end = page.getByRole('button', { name: 'Refresh', exact: true }).last();
    await end.scrollIntoViewIfNeeded(); await expect(end).toBeVisible();
    await capture(page, lease, browser.version(), { ...c, id: `${c.id}-scrolled-detail`, supplemental: true });
  }
});
