import './helpers/host';
import { host } from './helpers/host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { Shell } from '../client/shell';
import { resetHostOverviewState } from '../client/host-overview';
import type { DeploymentCatalog } from '../shared/common';
import { classifyIssue, issuesGet, issuesList, labelForeground, labelLuminance, neutralLabelColor, type IssueSummary } from '../shared/issues';
import { servicesInventory, type InventoryGroup, type InventoryUnit, type ServiceInventory } from '../shared/services';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const stamp = '2026-11-19T18:00:00.000Z';
const repo = 'Example/project';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  host.hosts.splice(1);
  host.hosts[0] = { serverId: 'host-a', label: 'Host A', status: 'online' };
  vi.useRealTimers();
});
const demo: DeploymentCatalog['entries'][number] = { id: 'demo', label: 'Demo', repo, adapter: 'orbi-0.7.41-release', status: 'available', problems: [] };
const second = { ...demo, id: 'second', label: 'Second', repo: 'Other/repository' };
const rejected = { ...demo, id: 'rejected', label: 'Rejected', repo: 'Other/repo', status: 'invalid_config' as const, problems: [{ source: 'config' as const, code: 'config_mismatch' as const }] };
const catalog = (entries: DeploymentCatalog['entries']): DeploymentCatalog => ({ state: 'configured', problems: [], entries });
const issue = (number: number, overrides: Partial<IssueSummary> = {}): IssueSummary => ({
  number, title: `Issue ${number}`, url: `https://github.com/${repo}/issues/${number}`,
  githubState: 'open', updatedAt: stamp, labels: [], ...classifyIssue('open', []), ...overrides,
});
const pageAt = (records: IssueSummary[], overrides: { state?: 'open' | 'closed' | 'all'; label?: string | null; hasNextPage?: boolean; repo?: string } = {}) => issuesList.output.parse({
  state: 'available', observedAt: stamp, lastSuccessfulAt: stamp, problems: [],
  data: { repo: overrides.repo ?? repo, page: 1, hasNextPage: overrides.hasNextPage ?? false, dependencyStatus: 'unknown', state: overrides.state ?? 'open', label: overrides.label ?? null, records },
});
const unavailable = (code: 'auth_denied' | 'rate_limited') => ({
  state: 'unavailable' as const, observedAt: stamp, lastSuccessfulAt: null, data: null, problems: [{ source: 'github' as const, code }],
});
const unit = (id: string, kind: InventoryUnit['kind'], activeState: string | null, subState: string | null): InventoryUnit =>
  ({ id, kind, runtime: activeState === null ? null : { loadState: 'loaded', activeState, subState }, unitFileState: 'enabled' } as InventoryUnit);
const family = (label: string, association: InventoryGroup['association'], deploymentId: string | null, units: InventoryUnit[]): InventoryGroup =>
  ({ label, kind: 'runner-family', association, deploymentId, units });
const inventory = (value: Partial<ServiceInventory> & Pick<ServiceInventory, 'state'>): ServiceInventory => servicesInventory.output.parse({
  observedAt: stamp,
  sources: [
    { source: 'runtime', state: 'complete', observedAt: stamp, problems: [] },
    { source: 'installed', state: 'complete', observedAt: stamp, problems: [] },
  ],
  problems: [], groups: [], ...value,
});
// Failed-first: orbi has a failed worker, orbi-demo is idle and orbi-core is transitional.
const hostA = inventory({ state: 'complete', groups: [
  family('orbi-demo', 'matched', 'demo', [unit('orbi-demo@1.service', 'service', 'inactive', 'dead'), unit('orbi-demo@1.timer', 'timer', 'active', 'waiting')]),
  family('orbi', 'unmatched', null, [unit('orbi@1.service', 'service', 'failed', 'failed'), unit('orbi@1.timer', 'timer', 'active', 'waiting')]),
  family('orbi-core', 'incompatible', null, [unit('orbi-core@1.service', 'service', 'activating', 'start')]),
] });
const props = (id = 'host-a'): PluginScreenProps => ({
  theme: { colors: { foreground: '#eee', foregroundMuted: '#aaa', surface0: '#111', surface1: '#222' } },
  host: { id, label: host.hosts.find(item => item.serverId === id)?.label ?? 'Host A' },
  layout: { compact: true, platform: 'ios' }, params: {},
} as PluginScreenProps);
beforeEach(() => {
  resetHostOverviewState();
  host.readCatalog.mockReset().mockResolvedValue(catalog([demo]));
  host.readInventory.mockReset().mockResolvedValue(inventory({ state: 'off' }));
  host.readIssues.mockReset().mockResolvedValue(pageAt([issue(42)]));
  host.readIssue.mockReset();
  host.readFleet.mockReset().mockResolvedValue({ state: 'available', observedAt: stamp, lastSuccessfulAt: stamp, problems: [] });
  host.openExternalUrl.mockReset().mockResolvedValue(undefined);
});
const settle = async () => { for (let n = 0; n < 3; n++) await act(async () => { await vi.advanceTimersByTimeAsync(2); }); };
async function render(params: PluginScreenProps['params'] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanups.push(() => client.clear());
  const openScreen = vi.fn();
  const tree = (id = 'host-a', route = 'fleet', next = params) => <QueryClientProvider client={client}><Shell {...props(id)} params={next} route={route} openScreen={openScreen} /></QueryClientProvider>;
  let renderer!: ReactTestRenderer;
  vi.useFakeTimers(); vi.setSystemTime(new Date(stamp));
  await act(async () => { renderer = create(tree()); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); });
  await settle();
  const press = async (label: string) => { await act(async () => renderer.root.findByProps({ accessibilityLabel: label }).props.onPress()); await settle(); };
  const switchTo = async (id: string, route = 'fleet', next = params) => { await act(async () => renderer.update(tree(id, route, next))); await settle(); };
  return { renderer, client, press, switchTo, openScreen };
}
const text = (renderer: ReactTestRenderer) => renderer.root.findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
const rowText = (row: ReactTestInstance) => row.findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
const row = (renderer: ReactTestRenderer, number: number) => renderer.root.findByProps({ testID: `orbi-work-issue-${number}` });
const contrast = (left: string, right: string) => {
  const [high, low] = [labelLuminance(left), labelLuminance(right)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
};

describe('Work first screen', () => {
  it('opens on Work with real issue rows, wrapping titles, label chips and read-only actions before services', async () => {
    const longTitle = 'Implement the repository work dashboard, keeping this deliberately long issue title wrapping across several lines on a phone';
    const labels = ['ai-ready', 'good first issue', 'help wanted', 'documentation', 'frontend', 'accessibility', 'needs review', 'backlog'];
    const colors = ['#00ff00', '#0d1117', '#808080', '#ffff00', '#0000ff', '#123456', '#abcdef', neutralLabelColor];
    const many = labels.map((name, index) => ({ name, color: colors[index] }));
    host.readIssues.mockResolvedValue(pageAt([issue(42, { title: longTitle, labels, labelDetails: many })]));
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, openScreen } = await render();
    const page = text(renderer);
    // The first viewport is Work for the configured repository: rows before any
    // service chrome, setup copy or technical detail.
    expect(page.startsWith('Work · Host A\nRepository: Demo (Example/project)')).toBe(true);
    expect(page.indexOf('Open issues')).toBeLessThan(page.indexOf('#42'));
    expect(page.indexOf('#42')).toBeLessThan(page.indexOf('Services (technical details)'));
    expect(page).not.toContain('Host A · Fleet');
    // Row identity: open-issue icon, number and the full title, never truncated.
    const open = row(renderer, 42);
    expect(rowText(open)).toContain(`#42 ${longTitle}`);
    expect(open.findByProps({ accessibilityLabel: 'Open issue' })).toBeDefined();
    const title = open.findAllByType('Text' as any).find(node => node.children.join('') === `#42 ${longTitle}`)!;
    expect(title.props.numberOfLines).toBeUndefined();
    expect(title.parent?.props.style).toMatchObject({ flexShrink: 1 });
    // Literal GitHub-style chips: repository colors, contrast ink, wrapping names.
    const chips = open.findAll(node => node.props.testID === 'orbi-label-chip');
    expect(chips.map(chip => chip.findByType('Text' as any).children.join(''))).toEqual(labels);
    for (const [index, chip] of chips.entries()) {
      expect(chip.props.style.backgroundColor).toBe(colors[index]);
      expect(chip.findByType('Text' as any).props.style.color).toBe(labelForeground(colors[index]));
      expect(contrast(chip.findByType('Text' as any).props.style.color, colors[index])).toBeGreaterThanOrEqual(4.5);
    }
    expect(chips[0].parent?.props.style).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
    // Read-only contextual actions with separate 44-unit targets.
    const inspect = open.findByProps({ accessibilityLabel: 'Inspect issue 42' });
    expect(inspect.props.accessibilityRole).toBe('button');
    expect(inspect.props.style({ pressed: false })).toMatchObject({ minHeight: 44 });
    expect(inspect.findAll(node => node.type === ('ExternalLink' as any))).toHaveLength(0);
    const link = open.findAll(node => node.type === ('ExternalLink' as any));
    expect(link).toHaveLength(1);
    expect(link[0].props.accessibilityLabel).toBe(`Open ${repo} issue 42 on GitHub`);
    const reads = host.readIssues.mock.calls.length;
    await act(async () => link[0].props.onPress());
    expect(host.openExternalUrl).toHaveBeenLastCalledWith(`https://github.com/${repo}/issues/42`);
    expect(host.readIssues).toHaveBeenCalledTimes(reads);
    await act(async () => inspect.props.onPress());
    expect(openScreen).toHaveBeenCalledWith({ screenId: 'issues', params: { deploymentId: 'demo', issue: '42' } });
    // No mutation affordance anywhere on Work.
    expect(renderer.root.findAll(node => typeof node.props.accessibilityLabel === 'string'
      && /^(Retry|Requeue|Merge|Approve|Restart|Stop service)$/.test(node.props.accessibilityLabel))).toHaveLength(0);
  });

  it('opens the selected issue detail from a Work row and keeps the page bounded', async () => {
    const detail = issuesGet.output.parse({
      state: 'available', observedAt: stamp, lastSuccessfulAt: stamp, problems: [],
      data: {
        issue: issue(42), mergeEvidence: 'unknown',
        reports: {
          selectedRunId: null, attribution: null, complete: false, problems: [],
          progress: { status: 'missing', attribution: null }, failure: { status: 'missing', attribution: null },
          scene: { status: 'missing', attribution: null }, baseCi: { status: 'missing', attribution: null },
          mergedReceipt: { status: 'missing', attribution: null }, prIdentity: { status: 'missing' },
        },
        dependencies: { complete: true, observedAt: stamp, records: [], problems: [] },
      },
    });
    host.readIssue.mockResolvedValue(detail);
    host.readIssues.mockResolvedValue(pageAt([issue(42)], { hasNextPage: true }));
    const { renderer, openScreen, switchTo } = await render();
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Inspect issue 42' }).props.onPress());
    expect(openScreen).toHaveBeenCalledWith({ screenId: 'issues', params: { deploymentId: 'demo', issue: '42' } });
    // The continuation names the bounded page without claiming a repository total.
    expect(text(renderer)).toContain('More issues are available; continue in Issues.');
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Continue browsing issues' }).props.onPress());
    expect(openScreen).toHaveBeenLastCalledWith({ screenId: 'issues', params: { deploymentId: 'demo' } });
    // The exact user path: the Issues screen opens with that number already selected.
    await switchTo('host-a', 'issues', { deploymentId: 'demo', issue: '42' });
    await settle();
    expect(host.readIssue).toHaveBeenLastCalledWith({ deploymentId: 'demo', issue: 42 });
    expect(text(renderer)).toContain('Issue #42');
    expect(text(renderer)).toContain('Dependencies: no open blockers observed');
  });

  it('shows one setup pointer without any issue read when no repository is configured or none is available', async () => {
    host.readCatalog.mockResolvedValue({ state: 'unconfigured', entries: [], problems: [] });
    const unconfigured = await render();
    expect(text(unconfigured.renderer)).toContain('Issue reads need a validated repository catalog, which this host does not have.');
    expect(text(unconfigured.renderer)).toContain('Set up repositories below explains the missing authorization.');
    expect(host.readIssues).not.toHaveBeenCalled();
    expect(unconfigured.renderer.root.findAllByProps({ testID: 'orbi-work-issues' })).toHaveLength(0);
    // Discovery-only host inventory is independent of the catalog.
    await unconfigured.press('Services (technical details)');
    expect(unconfigured.renderer.root.findAllByProps({ testID: 'orbi-host-services' })).toHaveLength(1);

    host.readCatalog.mockReset().mockResolvedValue({ state: 'invalid', entries: [], problems: [{ source: 'config', code: 'invalid_config' }] });
    const invalid = await render();
    expect(text(invalid.renderer)).toContain('this host configuration is invalid');
    expect(text(invalid.renderer)).toContain('config: invalid_config');
    expect(host.readIssues).not.toHaveBeenCalled();

    host.readCatalog.mockReset().mockResolvedValue(catalog([rejected]));
    const none = await render();
    expect(text(none.renderer)).toContain('No available configured repository.');
    expect(text(none.renderer)).toContain('config_mismatch');
    expect(host.readIssues).not.toHaveBeenCalled();
  });

  it('uses the available repository of a partial catalog and keeps rejected entries readable but unselectable', async () => {
    host.readCatalog.mockResolvedValue(catalog([rejected, demo]));
    const { renderer } = await render();
    expect(text(renderer)).toContain('Repository: Demo (Example/project)');
    expect(host.readIssues).toHaveBeenCalledWith({ deploymentId: 'demo', page: 1, state: 'open' });
    expect(text(renderer)).toContain('Rejected (Other/repo): invalid_config');
    // Only one available repository, so no selector is needed.
    expect(renderer.root.findAll(node => typeof node.props.accessibilityLabel === 'string'
      && node.props.accessibilityLabel.startsWith('Work repository '))).toHaveLength(0);
  });

  it('names unavailable GitHub reads with a concrete repair and never claims an empty list', async () => {
    host.readIssues.mockResolvedValue(unavailable('auth_denied'));
    const denied = await render();
    const deniedText = text(denied.renderer);
    expect(deniedText).toContain('Issues: unavailable');
    expect(deniedText).toContain('github: auth_denied');
    expect(deniedText).toContain("daemon user's existing gh authentication");
    expect(deniedText).not.toContain('No open issues found.');
    expect(denied.renderer.root.findAllByProps({ testID: 'orbi-work-empty' })).toHaveLength(0);
    expect(denied.renderer.root.findByProps({ accessibilityLabel: 'Refresh issues' }).props.disabled).toBe(false);

    host.readIssues.mockReset().mockResolvedValue(unavailable('rate_limited'));
    const limited = await render();
    expect(text(limited.renderer)).toContain('github: rate_limited');
    expect(text(limited.renderer)).toContain("wait for GitHub's retry/reset gate");
    expect(text(limited.renderer)).not.toContain('No open issues found.');
  });

  it('never claims a read in progress when a pending host goes offline', async () => {
    let finish!: (value: unknown) => void;
    host.readIssues.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { renderer, switchTo } = await render();
    // The read is in flight and has published nothing yet.
    expect(text(renderer)).not.toContain('#42 Issue 42');
    host.hosts[0].status = 'offline';
    await switchTo('host-a');
    const offline = text(renderer);
    expect(offline).toContain('Issues: unavailable');
    expect(offline).not.toContain('Issues: loading');
    expect(offline).toContain('Selected host is offline.');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Refresh issues' }).props.disabled).toBe(true);
    await act(async () => { finish(pageAt([issue(42)])); await settle(); });
    expect(text(renderer)).not.toContain('#42 Issue 42');
  });

  it('retains rows as stale after a failed refresh with Last seen and no absence or count claim', async () => {
    host.readIssues.mockResolvedValue(pageAt([issue(42), issue(43)]));
    const { renderer, press } = await render();
    expect(text(renderer)).toContain('#42 Issue 42');
    host.readIssues.mockRejectedValue(new Error('SECRET'));
    await press('Refresh issues');
    const visible = text(renderer);
    expect(visible).toContain('Issues: stale');
    expect(visible).toContain(`Last seen ${stamp}`);
    expect(visible).toContain('#42 Issue 42');
    expect(visible).toContain('filesystem: refresh_failed');
    expect(visible).not.toContain('No open issues found.');
    expect(visible).not.toContain('SECRET');
  });

  it('switches open, closed, all and exact-label filters server-side and discards a superseded late response', async () => {
    host.readIssues.mockImplementation(async input => pageAt([issue(input.page, {
      title: `${String(input.state ?? 'open').toUpperCase()}_${input.label ?? 'ALL'}_TITLE`,
      labels: input.label === undefined ? [] : [input.label],
      labelDetails: input.label === undefined ? [] : [{ name: input.label, color: '#00ff00' }],
      githubState: input.state === 'closed' ? 'closed' : 'open',
      ...classifyIssue(input.state === 'closed' ? 'closed' : 'open', input.label === undefined ? [] : [input.label]),
    })], { state: (input.state ?? 'open') as 'open' | 'closed' | 'all', label: input.label ?? null }));
    const { renderer, press, client } = await render();
    expect(text(renderer)).toContain('OPEN_ALL_TITLE');
    await press('Browse closed issues');
    expect(host.readIssues).toHaveBeenLastCalledWith({ deploymentId: 'demo', page: 1, state: 'closed' });
    expect(text(renderer)).toContain('CLOSED_ALL_TITLE');
    expect(text(renderer)).not.toContain('OPEN_ALL_TITLE');
    expect(row(renderer, 1).findByProps({ accessibilityLabel: 'Closed issue' })).toBeDefined();
    await press('Filter by label ai-ready');
    expect(host.readIssues).toHaveBeenLastCalledWith({ deploymentId: 'demo', page: 1, state: 'closed', label: 'ai-ready' });
    expect(text(renderer)).toContain('CLOSED_ai-ready_TITLE');
    expect(row(renderer, 1).findAll(node => node.props.testID === 'orbi-label-chip')
      .map(chip => chip.findByType('Text' as any).children.join(''))).toEqual(['ai-ready']);
    // Removing the label reuses the already observed unfiltered page rather than
    // reinterpreting the filtered one.
    await press('All labels');
    expect(text(renderer)).toContain('CLOSED_ALL_TITLE');
    expect(text(renderer)).not.toContain('CLOSED_ai-ready_TITLE');
    // A superseded read cannot publish into the newly selected filter.
    await press('Browse open issues');
    let finishLate!: (value: unknown) => void;
    host.readIssues.mockImplementationOnce(() => new Promise(resolve => { finishLate = resolve; }));
    await press('Filter by label ai-ready');
    await press('Filter by label ai-planning');
    expect(text(renderer)).toContain('OPEN_ai-planning_TITLE');
    const reads = host.readIssues.mock.calls.length;
    await act(async () => {
      finishLate(pageAt([issue(999, { title: 'LATE_OPEN_TITLE', labels: ['ai-ready'], labelDetails: [{ name: 'ai-ready', color: '#00ff00' }], ...classifyIssue('open', ['ai-ready']) })], { label: 'ai-ready' }));
      await settle();
    });
    expect(text(renderer)).not.toContain('LATE_OPEN_TITLE');
    expect(text(renderer)).toContain('OPEN_ai-planning_TITLE');
    expect(host.readIssues.mock.calls.length).toBe(reads);
    // Every filter keeps its own observation identity.
    expect(client.getQueryData(['paseo-orbi', 'host-a', 'demo', `issues.list:${repo}:closed::1`])).toBeDefined();
    expect(client.getQueryData(['paseo-orbi', 'host-a', 'demo', `issues.list:${repo}:closed:ai-ready:1`])).toBeDefined();
    expect(client.getQueryData(['paseo-orbi', 'host-a', 'demo', `issues.list:${repo}:open::1`])).toBeDefined();
    expect(client.getQueryData(['paseo-orbi', 'host-a', 'demo', `issues.list:${repo}:open:ai-planning:1`])).toBeDefined();
    // The superseded open+ai-ready generation never published retained data.
    expect(client.getQueryData(['paseo-orbi', 'host-a', 'demo', `issues.list:${repo}:open:ai-ready:1`])).toBeUndefined();
  });

  it('keeps host identity authoritative for rows, repository choice and a late previous-host response', async () => {
    host.readCatalog.mockResolvedValue(catalog([demo, second]));
    host.readInventory.mockResolvedValue(hostA);
    host.readIssues.mockImplementation(async input => pageAt([issue(42, { title: input.deploymentId === 'second' ? 'SECOND_REPOSITORY_TITLE' : 'HOST_A_TITLE' })]));
    const { renderer, press, switchTo } = await render();
    // The first available repository is the default; a second available entry is selectable.
    expect(host.readIssues).toHaveBeenLastCalledWith({ deploymentId: 'demo', page: 1, state: 'open' });
    await press('Work repository Second');
    expect(host.readIssues).toHaveBeenLastCalledWith({ deploymentId: 'second', page: 1, state: 'open' });
    expect(text(renderer)).toContain('SECOND_REPOSITORY_TITLE');
    // A late read from the previous host cannot publish into the next host.
    let finishLate!: (value: unknown) => void;
    host.readIssues.mockImplementationOnce(() => new Promise(resolve => { finishLate = resolve; }));
    await press('Browse closed issues');
    host.hosts.push({ serverId: 'host-b', label: 'Host B', status: 'online' });
    host.readIssues.mockImplementation(async () => pageAt([issue(42, { title: 'HOST_B_TITLE' })]));
    await switchTo('host-b');
    expect(text(renderer)).toContain('Work · Host B');
    expect(text(renderer)).toContain('HOST_B_TITLE');
    expect(text(renderer)).not.toContain('HOST_A_TITLE');
    expect(text(renderer)).not.toContain('SECOND_REPOSITORY_TITLE');
    // A host change remounts Work, so the previous repository choice is not inherited.
    expect(host.readIssues).toHaveBeenLastCalledWith({ deploymentId: 'demo', page: 1, state: 'open' });
    await act(async () => { finishLate(pageAt([issue(500, { title: 'LATE_HOST_A_TITLE' })])); await settle(); });
    expect(text(renderer)).not.toContain('LATE_HOST_A_TITLE');
    expect(text(renderer)).toContain('HOST_B_TITLE');
  });

  it('keeps the failed-first service inventory behind a technical-details disclosure with an attention summary', async () => {
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press, switchTo } = await render();
    const disclosure = () => renderer.root.findByProps({ accessibilityLabel: 'Services (technical details)' });
    expect(disclosure().props).toMatchObject({ accessibilityRole: 'button', accessibilityState: { expanded: false } });
    expect(disclosure().props.style({ pressed: false })).toMatchObject({ minHeight: 44 });
    expect(text(renderer)).toContain('Services: current · 1 of 3 groups needs attention');
    expect(renderer.root.findAllByProps({ testID: 'orbi-host-services' })).toHaveLength(0);
    await press('Services (technical details)');
    expect(renderer.root.findAllByProps({ testID: 'orbi-host-services' })).toHaveLength(1);
    const families = renderer.root.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('orbi-family-')).map(node => node.props.testID);
    expect(families).toEqual(['orbi-family-orbi', 'orbi-family-orbi-demo', 'orbi-family-orbi-core']);
    // Compact failed-first rows keep raw unit identity one disclosure deeper.
    const failed = renderer.root.findByProps({ testID: 'orbi-family-orbi' });
    const failedText = rowText(failed);
    expect(failedText).toContain('Slot 1 · Worker failed');
    expect(failedText).not.toContain('@');
    expect(failed.findAllByProps({ accessibilityLabel: 'Unit details for orbi' })).toHaveLength(0);
    await press('Expand orbi');
    expect(renderer.root.findByProps({ testID: 'orbi-family-orbi' }).findAllByProps({ accessibilityLabel: 'Unit details for orbi' })).toHaveLength(1);
    // A retained, offline or undecided inventory publishes no attention count.
    host.hosts[0].status = 'offline';
    await switchTo('host-a');
    const offline = text(renderer);
    expect(offline).toContain('Services: unavailable · current activity unknown');
    expect(offline).not.toMatch(/\d+ of \d+ (?:observed )?groups? needs? attention/);
    expect(text(renderer).indexOf('Work · Host A')).toBeGreaterThanOrEqual(0);
  });

  it('declares width-independent wrapping, 44-unit targets and screen-reader names for 360/390/430 phone layouts', async () => {
    const longLabel = 'A Very Long Repository Label That Must Wrap Instead Of Clipping On A Narrow Phone';
    const longRepo = 'VeryLongOrganizationNameForPhoneLayouts/very-long-repository-name-for-phone-layouts';
    host.readCatalog.mockResolvedValue(catalog([{ ...demo, label: longLabel, repo: longRepo }, { ...second, label: 'Second' }]));
    host.readIssues.mockResolvedValue(pageAt([issue(42, { title: 'x'.repeat(400), url: `https://github.com/${longRepo}/issues/42`, labels: ['a', 'b', 'c', 'd', 'e', 'f'],
      labelDetails: ['#00ff00', '#0d1117', '#808080', '#ffff00', '#0000ff', '#123456'].map((color, index) => ({ name: `label-${index}`, color })) })], { repo: longRepo }));
    // The component takes no pixel width: wrapping and shrink rules decide every
    // 360/390/430 CSS-px layout instead of fixed sizes or truncation.
    const { renderer } = await render();
    const work = renderer.root.findByProps({ testID: 'orbi-work' });
    expect(text(renderer)).toContain(`Repository: ${longLabel} (${longRepo})`);
    expect(text(renderer)).toContain('x'.repeat(400));
    expect(renderer.root.findByProps({ testID: 'orbi-work-heading' }).props.accessibilityRole).toBe('header');
    // Long repository selector names wrap inside a wrapping row.
    const repositories = renderer.root.findByProps({ testID: 'orbi-work-repositories' });
    expect(repositories.props.style).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
    for (const control of work.findAll(node => node.type === ('Pressable' as any))) {
      const style = typeof control.props.style === 'function' ? control.props.style({ pressed: false }) : control.props.style;
      expect(style).toMatchObject({ minHeight: 44 });
    }
    // The action row wraps instead of expanding past a 360 CSS-px viewport.
    const inspect = row(renderer, 42).findByProps({ accessibilityLabel: 'Inspect issue 42' });
    expect(inspect.parent?.props.style).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
    // Nothing in an issue row declares a fixed width or a line limit.
    for (const number of [42]) {
      const issueRow = row(renderer, number);
      expect(JSON.stringify(issueRow.props.style)).not.toMatch(/"width"|"height"/);
      for (const textNode of issueRow.findAllByType('Text' as any)) {
      expect(textNode.props.numberOfLines).toBeUndefined();
      // Large-text system scaling stays enabled: no row pins the font size shut.
      expect(textNode.props.allowFontScaling).not.toBe(false);
    }
    }
    // Every interactive name is unique and announced.
    for (const label of ['Inspect issue 42', `Open ${longRepo} issue 42 on GitHub`, 'Refresh issues', 'Services (technical details)',
      'Browse open issues', 'Browse closed issues', 'Browse all issues', 'All labels', 'Filter by label ai-ready']) {
      expect(renderer.root.findAllByProps({ accessibilityLabel: label }).length).toBeGreaterThanOrEqual(1);
    }
  });
});
