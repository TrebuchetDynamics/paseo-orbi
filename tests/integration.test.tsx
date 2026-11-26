import './helpers/host';
import { host } from './helpers/host';
import { afterEach, expect, it, vi } from 'vitest';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PluginScreenProps, PluginClientContext } from '@getpaseo/plugin/client';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { mkdir, writeFile, readFile, readdir, lstat, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import serverEntry from '../index.server';
import clientEntry from '../index.client';
import { issuesList, issuesGet } from '../shared/issues';
import { servicesInventory } from '../shared/services';
import { blockersList } from '../shared/blockers';
import { ReadError, ReadPorts } from '../server/read-ports';
import { fixture } from './helpers/fixtures';
import records from './fixtures/runs/records.json';
import guidance from './fixtures/blockers/guidance.json';
import pins from './fixtures/integration/source-profiles.json';
import { fingerprint, profiles, type SourceProfile } from '../server/compatibility';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  host.hosts.splice(1);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});
const response = (data: unknown, status = 200) => `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}`;
const stamp = '2026-11-14T23:00:00Z';
async function snapshot(root: string): Promise<unknown[]> {
  return Promise.all((await readdir(root)).sort().map(async name => {
    const path = join(root, name), info = await lstat(path);
    return [name, info.mode, info.size, info.mtimeMs, info.ctimeMs, info.ino,
      info.isDirectory() ? await snapshot(path) : createHash('sha256').update(await readFile(path)).digest('hex')];
  }));
}

it('four_views_read_only_journey', async () => {
  vi.stubEnv('PASEO_ORBI_HOST_INVENTORY', '0');
  const a = await fixture('release'), b = await fixture('installed');
  cleanups.push(a.cleanup, b.cleanup);
  await writeFile(b.configPath, b.toml.replace('Example/project', 'Other/repository'));
  await a.save([a.entry, { ...b.entry, id: 'second', label: 'Second', repo: 'Other/repository' }]);
  for (const [f, repo] of [[a, 'Example/project'], [b, 'Other/repository']] as const) {
    await mkdir(join(f.repoDir, '.orbi'));
    await writeFile(join(f.repoDir, '.orbi/health.json'), JSON.stringify({ runs: [], last_pickup_ts: 1794697100, alerted: [] }));
    for (const [issue, run] of [[42, '22222222'], [420, '33333333'], [4, '12345678'], [99, '11111111']] as const) {
      const scene = join(f.repoDir, '.worktrees', `orbi-${repo.replace('/', '-')}-issue-${issue}-${run}`);
      await mkdir(join(scene, '.orbi'), { recursive: true }); await mkdir(join(scene, '.pi-session'));
      await writeFile(join(scene, '.orbi/run-state.json'), JSON.stringify({ repo, issue, run_id: run, branch: `orbi/${repo.replace('/', '-')}-issue-${issue}`, created_at: stamp, worktree: '/PATH_SECRET_CANARY' }));
      await writeFile(join(scene, '.pi-session/one.jsonl'), [records.session, records.message].map(r => JSON.stringify(r)).join('\n') + '\n');
      for (const name of ['test.log', 'plan.md', 'verify.md']) await writeFile(join(scene, '.orbi', name), 'ARTIFACT_SECRET_CANARY');
    }
  }
  const before = await Promise.all([snapshot(a.root), snapshot(b.root)]);
  let failed = false, malformed = false, partial = false;
  // Inject only the external process/network port. Configuration, hash gate,
  // filesystem ports, adapters, registrations, schemas and QueryClient are real.
  const processPort = vi.spyOn(ReadPorts.prototype, 'process').mockImplementation(async (id, op) => {
    if (failed || (partial && op.kind === 'systemctl-show' && op.slot === 2 && op.unit === 'timer')) throw new ReadError('process_failed');
    const repo = id === 'demo' ? 'Example/project' : 'Other/repository';
    if (op.kind === 'systemctl-show') return 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=static\nResult=success\nExecMainStatus=0\nEnvironment=ENV_SECRET_CANARY\n';
    if (op.kind === 'journalctl') return JSON.stringify({ ...records.journal, MESSAGE: records.journal.MESSAGE.replace('Example/project', repo) }) + '\n';
    // Filler issues keep the default open page full for pagination without
    // becoming active runs: only the two attributed worktrees are in progress.
    const issue = (n: number) => ({ number: n, title: `Issue ${n}`, state: n === 99 ? 'closed' : 'open', updated_at: stamp, labels: [{ name: n === 4 ? 'ai-blocked' : n >= 1000 ? 'backlog' : 'ai-in-progress' }], body: 'BODY_SECRET_CANARY' });
    // Open browse pages stay full so pagination is exercised on the default state;
    // only the wider states expose the closed issue 99.
    if (op.resource === 'issues') {
      const head = op.page === 1 ? [42, 420, 4, ...(op.state === 'open' ? [] : [99])] : [];
      const fillers = op.page === 1 ? Array.from({ length: op.state === 'open' ? 97 : 96 }, (_, i) => 1000 + i) : [1007];
      return response([...head, ...fillers].map(issue));
    }
    if (op.resource === 'issue') return response(issue(op.issue));
    if (op.resource === 'comments') {
      const run = op.issue === 42 ? '22222222' : op.issue === 420 ? '33333333' : op.issue === 4 ? '12345678' : '11111111';
      const block = (name: string, data: unknown) => `<!-- orbi:${name}:v1 ${JSON.stringify(data)} -->`;
      const body = `<!-- orbi:run=${run} -->\n` + (op.issue === 4
        ? '<!-- orbi:comment=failure -->\n' + block('failure', malformed ? { schema: 1, reason_code: 'INVALID_SECRET_CANARY' } : guidance.failure)
        : '<!-- orbi:comment=started -->') + '\n' + block('scene', { ...guidance.scene, run_id: run, pr_url: `https://github.com/${repo}/pull/42` }) + '\nRAW_SECRET_CANARY';
      return response([{ id: 1, user: { login: 'publisher-canary' }, updated_at: stamp, body }]);
    }
    if (op.resource === 'dependencies') return response([]);
    if (op.resource === 'pull') return response({ ...records.pull, number: op.pr, html_url: `https://github.com/${repo}/pull/${op.pr}`, base: { repo: { full_name: repo } } });
    if (op.resource === 'checks') return response({ check_runs: [records.check] });
    throw new Error('unexpected operation');
  });
  const dispose = vi.spyOn(ReadPorts.prototype, 'dispose');
  vi.stubEnv('PASEO_ORBI_CONFIG', a.authorization);
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const transported: unknown[] = [];
  const stopServer = serverEntry({ handle: (contract: any, handler: any) => {
    handlers.set(contract.name, async input => {
      const result = contract.output.parse(await handler(contract.input.parse(input)));
      transported.push(result); return result;
    });
  } } as PluginServerContext);
  cleanups.push(stopServer);
  for (const [name, mock] of Object.entries({ 'deployments.list': host.readCatalog, 'services.inventory': host.readInventory, 'fleet.read': host.readFleet, 'issues.list': host.readIssues, 'issues.get': host.readIssue, 'runs.list': host.readRuns, 'runs.read': host.readRun, 'blockers.list': host.readBlockers, 'blockers.read': host.readBlocker, 'workspace.shortcut': host.readShortcut })) {
    mock.mockReset().mockImplementation(input => handlers.get(name)!(input));
  }
  const screens = new Map<string, React.ComponentType<PluginScreenProps>>();
  const removed = vi.fn(), openScreen = vi.fn();
  const stopClient = clientEntry({ addScreen: (screen: any) => { screens.set(screen.id, screen.Component); return removed; }, addSidebarHeaderItem: () => removed, openScreen } as unknown as PluginClientContext);
  cleanups.push(stopClient);
  // Stable route ids plus the host-scoped Services screen.
  expect([...screens.keys()]).toEqual(['fleet', 'services', 'issues', 'runs', 'blockers']);
  expect((await handlers.get('deployments.list')!({}) as any).entries.map((e: any) => e.status)).toEqual(['available', 'available']);
  vi.useFakeTimers(); vi.setSystemTime(new Date(stamp));
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } }); cleanups.push(() => query.clear());
  const props: PluginScreenProps = { theme: { colors: { foreground: '#eee', foregroundMuted: '#aaa', surface0: '#111', surface1: '#222', surface2: '#333', border: '#555', accent: '#abc', accentForeground: '#000', statusSuccess: '#0f0', statusWarning: '#ff0', statusDanger: '#f00' } }, host: { id: 'host-a', label: 'Host A' }, layout: { compact: true, platform: 'ios' }, params: { deploymentId: 'demo' } };
  let renderer!: ReactTestRenderer;
  const tree = (route: string, p = props) => { const Screen = screens.get(route)!; return <QueryClientProvider client={query}><Screen {...p} /></QueryClientProvider>; };
  await act(async () => { renderer = create(tree('fleet')); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); });
  // Fake timers deliver React Query's batched notifications one tick per round.
  // Keep flushing while this client still has an in-flight read (bounded), so a
  // host service check that lands first cannot starve the next screen's read.
  const settle = async () => {
    for (let n = 0; n < 20; n++) {
      await act(async () => { await pause(10); await vi.advanceTimersByTimeAsync(5); });
      if (query.isFetching() === 0) break;
    }
    await act(async () => { await pause(10); await vi.advanceTimersByTimeAsync(5); });
  };
  const text = () => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
  const press = async (label: string) => { await act(async () => renderer.root.findByProps({ accessibilityLabel: label }).props.onPress()); await settle(); };
  await settle();
  expect(text()).toContain('Configured capacity: 2; Occupancy: unknown'); expect(text()).toContain('Second (Other/repository)');
  // Mounting the detail is not an operator request: no shortcut inspection is made.
  expect(text()).toContain('Workspace shortcut: Not inspected');
  expect(host.readShortcut).not.toHaveBeenCalled();
  // Persistent Work / Services / Runs navigation, then the configured Work
  // surface. Host inventory is not opted in here, so no service row exists.
  expect(text().startsWith('Work\nServices\nRuns\n')).toBe(true);
  expect(host.readInventory).toHaveBeenCalledTimes(1);
  // The persistent navigation already names the surface: no duplicate inner title.
  expect(text()).not.toContain('Work · Host A');
  expect(text()).toContain('Repository: Demo (Example/project)');
  expect(text()).toContain('Issues: Current');
  expect(text()).toContain('#42 Issue 42');
  // The readable health line and its separate View services action precede the
  // issue rows; the configured-repository detail stays below them.
  expect(text().indexOf('Service check off')).toBeLessThan(text().indexOf('#42 Issue 42'));
  expect(text().indexOf('#42 Issue 42')).toBeLessThan(text().indexOf('Configured repositories'));
  expect(text()).toContain('Service check off · current activity unknown');
  expect(renderer.root.findAllByProps({ testID: 'orbi-work-health' })).toHaveLength(1);
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'View services' })).toHaveLength(1);
  expect(renderer.root.findAllByProps({ testID: 'orbi-host-services' })).toHaveLength(0);
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'Refresh services' })).toHaveLength(0);
  expect(text()).not.toContain('View repository');
  expect(text().indexOf('Fleet — read-only')).toBeGreaterThan(text().indexOf('#42 Issue 42'));
  partial = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(31000); }); await settle();
  expect(text()).toContain('Partial'); expect(text()).toContain('systemd: process_failed');
  expect(text()).toContain('Occupancy: unknown'); partial = false;
  await press('Active work for Demo'); expect(openScreen).toHaveBeenCalledWith({ screenId: 'issues', params: { deploymentId: 'demo' } });
  await act(async () => renderer.update(tree('issues'))); await settle();
  expect(text()).toContain('#42 Issue 42');
  await press('Inspect issue 42'); expect(text()).toContain('Dependencies: no open blockers observed'); expect(text()).toContain('Reported run: 22222222; reports complete');
  // Same deployment ID on another online host must remount local selection,
  // while a cancelled old-host detail cannot publish late into either generation.
  expect(host.readCatalog).toHaveBeenCalledTimes(2); // initial + the 30-second poll, no second owner on Issues
  expect(renderer.root.findByProps({ accessibilityLabel: 'Next page' }).props.disabled).toBe(false);
  await press('Next page'); expect(text()).toContain('Page 2.');
  // Issue 42 is not on this page; a by-number lookup keeps one local detail
  // observation that the host switch below must discard with the whole surface.
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Issue number to inspect' }).props.onChangeText('42'));
  await press('Inspect issue by number');
  expect(text()).toContain('Issue #42 — detail read by number; not a browse-page membership claim.');
  const oldDetail = query.getQueryData(['paseo-orbi', 'host-a', 'demo', 'issues.get:Example/project:42']);
  expect(oldDetail).toMatchObject({ data: { issue: { number: 42 }, reports: { selectedRunId: '22222222' } } });
  expect(text()).toContain('Dependencies: no open blockers observed');
  const result = await handlers.get('issues.get')!({ deploymentId: 'demo', issue: 42 });
  let finishDetail!: (value: unknown) => void;
  host.readIssue.mockImplementationOnce(() => new Promise(resolve => { finishDetail = resolve; }));
  let pending!: Promise<unknown>;
  await act(async () => { pending = renderer.root.findByProps({ testID: 'orbi-issues' }).findByProps({ accessibilityLabel: 'Refresh selected issue' }).props.onPress(); }); await settle();
  host.hosts.push({ serverId: 'host-b', label: 'Host A', status: 'online' });
  const otherHost = { ...props, host: { id: 'host-b', label: 'Host A' } } as PluginScreenProps;
  await act(async () => renderer.update(tree('issues', otherHost))); await settle();
  expect(text()).toContain('Page 1.'); expect(text()).not.toContain('Page 2.'); expect(text()).not.toContain('Dependencies: no open blockers observed');
  expect(host.readCatalog).toHaveBeenCalledTimes(3);
  await act(async () => { finishDetail(result); await pending; }); await settle();
  expect(text()).not.toContain('Dependencies: no open blockers observed');
  expect(query.getQueryData(['paseo-orbi', 'host-a', 'demo', 'issues.get:Example/project:42'])).toEqual(oldDetail);
  expect(query.getQueryData(['paseo-orbi', 'host-b', 'demo', 'issues.get:Example/project:42'])).toBeUndefined();
  await press('Inspect issue 42'); expect(text()).toContain('Dependencies: no open blockers observed');
  await act(async () => renderer.update(tree('issues', { ...otherHost, params: { deploymentId: 'second' } }))); await settle();
  expect(text()).not.toContain('Dependencies: no open blockers observed');
  await act(async () => renderer.update(tree('issues', otherHost))); await settle();
  await press('Inspect issue 42'); expect(text()).toContain('Dependencies: no open blockers observed');
  // Catalog reassignment is a client seam, not a server startup reconfiguration.
  // Supply distinguishable B data at the typed transport seam with B pending.
  const aPage = query.getQueryData<any>(['paseo-orbi', 'host-b', 'demo', 'issues.list:Example/project:open::1']);
  const bPage = issuesList.output.parse(JSON.parse(JSON.stringify(aPage).replaceAll('Example/project', 'Reassigned/project')));
  bPage.data!.records.forEach(issue => { issue.title = `Reassigned issue ${issue.number}`; });
  const bDetail = issuesGet.output.parse(JSON.parse(JSON.stringify(result).replaceAll('Example/project', 'Reassigned/project')));
  bDetail.data!.issue.title = 'Reassigned issue 42'; bDetail.data!.reports.selectedRunId = 'bbbbbbbb';
  let finishRepositoryList!: (value: unknown) => void, finishRepositoryDetail!: (value: unknown) => void;
  host.readIssues.mockImplementationOnce(() => new Promise(resolve => { finishRepositoryList = resolve; }));
  host.readIssue.mockImplementationOnce(() => new Promise(resolve => { finishRepositoryDetail = resolve; }));
  const listCalls = host.readIssues.mock.calls.length, issueCalls = host.readIssue.mock.calls.length;
  const catalogKey = ['paseo-orbi', 'host-b', 'catalog', 'deployments.list'];
  const catalogObservation = query.getQueryData<any>(catalogKey);
  await act(async () => { query.setQueryData(catalogKey, { ...catalogObservation, data: { ...catalogObservation.data,
    entries: catalogObservation.data.entries.map((entry: any) => entry.id === 'demo' ? { ...entry, repo: 'Reassigned/project' } : entry) } }); }); await settle();
  expect(text()).not.toContain('Dependencies: no open blockers observed');
  expect(text()).not.toContain('Issue 42'); expect(text()).not.toContain('Reported run: 22222222');
  expect(text()).toContain('Loading');
  expect(renderer.root.findAll(node => node.type === ('ExternalLink' as any))).toHaveLength(0);
  expect(host.readIssues).toHaveBeenCalledTimes(listCalls + 1);
  expect(host.readIssues).toHaveBeenLastCalledWith(issuesList.input.parse({ deploymentId: 'demo', page: 1 }));
  await act(async () => finishRepositoryList(bPage)); await settle();
  expect(text()).toContain('Reassigned issue 42');
  await press('Inspect issue 42');
  expect(host.readIssue).toHaveBeenCalledTimes(issueCalls + 1);
  expect(host.readIssue).toHaveBeenLastCalledWith(issuesGet.input.parse({ deploymentId: 'demo', issue: 42 }));
  expect(text()).not.toContain('Reported run: 22222222');
  await act(async () => finishRepositoryDetail(bDetail)); await settle();
  expect(text()).toContain('Reported run: bbbbbbbb');
  expect(renderer.root.findByProps({ accessibilityLabel: 'Open Reassigned/project issue 42 on GitHub' })).toBeDefined();
  await act(async () => renderer.update(tree('issues', { ...props, params: { deploymentId: 'second' } }))); await settle();
  expect(text()).not.toContain('Dependencies: no open blockers observed');
  host.hosts.splice(1);
  await act(async () => renderer.update(tree('runs'))); await settle();
  expect(text()).toContain('22222222'); expect(text()).toContain('33333333'); expect(text()).not.toContain('11111111');
  await press('Inspect run 42 22222222'); expect(text()).toContain('session-42'); expect(text()).toContain('unit tests');
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Issue number for history' }).props.onChangeText('99'));
  await press('Inspect issue history'); expect(text()).toContain('11111111'); expect(text()).toContain('history');
  const detailCalls = host.readRun.mock.calls.length;
  await act(async () => renderer.update(tree('runs', { ...props, params: { deploymentId: 'second' } }))); await settle();
  expect(renderer.root.findByProps({ accessibilityLabel: 'Issue number for history' }).props.value).toBe('');
  expect(text()).not.toContain('Detail evidence — loaded only on selection');
  expect(text()).not.toContain('Issue #99 history');
  expect(host.readRun).toHaveBeenCalledTimes(detailCalls);
  await act(async () => renderer.update(tree('blockers'))); await settle();
  await press('Inspect blocker 4'); expect(text()).toContain('test.log: present'); expect(text()).toContain('complete report read');
  // Selected deployment changes use the other supported profile, never shared data.
  const second = { ...props, params: { deploymentId: 'second' } };
  await act(async () => renderer.update(tree('blockers', second))); await settle();
  await press('Inspect blocker 4'); expect(text()).toContain('Other/repository'); expect(text()).toContain('keep_failed_worktrees: true');
  malformed = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(31000); }); await settle();
  expect(text()).toContain('invalid');
  failed = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(61000); }); await settle();
  expect(text()).toContain('Stale'); expect(text()).toContain('process_failed');
  const calls = processPort.mock.calls.length;
  await act(async () => renderer.update(tree('blockers', { ...second, host: { id: 'host-b', label: 'Host B' } } as PluginScreenProps))); await settle();
  expect(text()).toContain('Selected host is offline'); expect(text()).not.toContain('test.log: present'); expect(processPort).toHaveBeenCalledTimes(calls);
  failed = false; malformed = false;
  await act(async () => renderer.update(tree('blockers', second)));
  await act(async () => { await vi.advanceTimersByTimeAsync(61000); }); await settle();
  await press('Inspect blocker 4');
  expect(text()).toContain('complete report read'); expect(text()).toContain('test.log: present'); expect(text()).not.toContain('process_failed');
  // One normal observation interval and explicit detail selection inspect nothing.
  expect(host.readShortcut).not.toHaveBeenCalled();
  expect(JSON.stringify(transported)).not.toMatch(/CANARY|publisher-canary|\/tmp\/|configPath|engineSourcePath|repoDir|deployHome/);
  expect(await Promise.all([snapshot(a.root), snapshot(b.root)])).toEqual(before);
  expect(processPort.mock.calls.every(([, op, deadline]) => ['systemctl-show', 'journalctl', 'gh-api-get'].includes(op.kind) && (deadline === undefined || deadline <= 10000))).toBe(true);
  await act(async () => renderer.unmount()); cleanups.pop();
  expect(host.listeners.size).toBe(0);
  query.clear(); expect(vi.getTimerCount()).toBe(0);
  const finalCalls = processPort.mock.calls.length;
  await vi.advanceTimersByTimeAsync(61000); expect(processPort).toHaveBeenCalledTimes(finalCalls);
  stopClient(); expect(removed).toHaveBeenCalledTimes(6);
  await stopServer(); expect(dispose).toHaveBeenCalled();
});

it('services_screen_shows_off_without_a_feature_read_or_enabling_action', async () => {
  vi.stubEnv('PASEO_ORBI_HOST_INVENTORY', '0');
  const f = await fixture('release'); cleanups.push(f.cleanup);
  vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
  const processPort = vi.spyOn(ReadPorts.prototype, 'process');
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const stopServer = serverEntry({ handle: (contract: any, handler: any) => {
    handlers.set(contract.name, async input => contract.output.parse(await handler(contract.input.parse(input))));
  } } as PluginServerContext);
  cleanups.push(stopServer);
  for (const [name, mock] of Object.entries({ 'deployments.list': host.readCatalog, 'services.inventory': host.readInventory, 'fleet.read': host.readFleet, 'issues.list': host.readIssues, 'runs.list': host.readRuns, 'blockers.list': host.readBlockers })) {
    mock.mockReset().mockImplementation(input => handlers.get(name)!(input));
  }
  const screens = new Map<string, React.ComponentType<PluginScreenProps>>();
  const stopClient = clientEntry({ addScreen: (screen: any) => { screens.set(screen.id, screen.Component); return vi.fn(); }, addSidebarHeaderItem: () => vi.fn(), openScreen: vi.fn() } as unknown as PluginClientContext);
  cleanups.push(stopClient);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } }); cleanups.push(() => query.clear());
  const theme = { colors: { foreground: '#eee', foregroundMuted: '#aaa', surface0: '#111', surface1: '#222', surface2: '#333', border: '#555', accent: '#abc', accentForeground: '#000', statusSuccess: '#0f0', statusWarning: '#ff0', statusDanger: '#f00' } };
  vi.useFakeTimers(); vi.setSystemTime(new Date(stamp));
  let renderer!: ReactTestRenderer;
  const Screen = screens.get('services')!;
  await act(async () => { renderer = create(<QueryClientProvider client={query}><Screen theme={theme} host={{ id: 'host-a', label: 'Host A' }} layout={{ compact: true, platform: 'ios' }} params={{}} /></QueryClientProvider>); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); });
  for (let n = 0; n < 20; n++) { await act(async () => { await pause(10); await vi.advanceTimersByTimeAsync(5); }); if (query.isFetching() === 0) break; }
  const text = () => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
  // Bounded wait for the real catalog and inventory reads to settle.
  for (let n = 0; n < 200 && !text().includes('Service check off · activity unknown'); n++) {
    await act(async () => { await pause(5); await vi.advanceTimersByTimeAsync(5); });
  }
  // The opt-in inventory answers off; the screen reports the undecided state and
  // never offers an enabling Refresh, a service row or a repository action.
  expect(text()).toContain('Services · Host A');
  expect(text()).toContain('Service check off · activity unknown');
  expect(renderer.root.findAllByProps({ testID: 'orbi-host-services' })).toHaveLength(1);
  expect(renderer.root.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('orbi-family-'))).toHaveLength(0);
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'Refresh services' })).toHaveLength(0);
  expect(text()).not.toContain('PASEO_ORBI_HOST_INVENTORY=1');
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Set up service access' }).props.onPress());
  expect(text()).toContain('PASEO_ORBI_HOST_INVENTORY=1');
  expect(text()).toContain('Refresh cannot enable access');
  expect(text()).not.toContain('View repository');
  // Work / Services / Runs navigation stays available; Services is selected.
  expect(renderer.root.findByProps({ accessibilityLabel: 'Open Services' }).props.accessibilityState).toMatchObject({ selected: true });
  expect(renderer.root.findByProps({ accessibilityLabel: 'Open Work' }).props.accessibilityState).toMatchObject({ selected: false });
  // No repository, GitHub or process read: only the opted-out inventory answer.
  expect(host.readInventory).toHaveBeenCalledTimes(1);
  expect(host.readFleet).not.toHaveBeenCalled();
  expect(host.readIssues).not.toHaveBeenCalled();
  expect(host.readRuns).not.toHaveBeenCalled();
  expect(host.readBlockers).not.toHaveBeenCalled();
  expect(processPort).not.toHaveBeenCalled();
});

it('runs_without_linked_repositories_shows_one_runs_notice_and_reads_no_runs', async () => {
  vi.stubEnv('PASEO_ORBI_HOST_INVENTORY', '0');
  // No PASEO_ORBI_CONFIG: the real server entry answers a confirmed unconfigured
  // catalog, so this is the assembled shell + schema + QueryClient path.
  vi.stubEnv('PASEO_ORBI_CONFIG', undefined);
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const stopServer = serverEntry({ handle: (contract: any, handler: any) => {
    handlers.set(contract.name, async input => contract.output.parse(await handler(contract.input.parse(input))));
  } } as PluginServerContext);
  cleanups.push(stopServer);
  for (const [name, mock] of Object.entries({ 'deployments.list': host.readCatalog, 'runs.list': host.readRuns, 'runs.read': host.readRun })) {
    mock.mockReset().mockImplementation(input => handlers.get(name)!(input));
  }
  const screens = new Map<string, React.ComponentType<PluginScreenProps>>();
  const stopClient = clientEntry({ addScreen: (screen: any) => { screens.set(screen.id, screen.Component); return vi.fn(); }, addSidebarHeaderItem: () => vi.fn(), openScreen: vi.fn() } as unknown as PluginClientContext);
  cleanups.push(stopClient);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } }); cleanups.push(() => query.clear());
  const theme = { colors: { foreground: '#eee', foregroundMuted: '#aaa', surface0: '#111', surface1: '#222', surface2: '#333', border: '#555', accent: '#abc', accentForeground: '#000', statusSuccess: '#0f0', statusWarning: '#ff0', statusDanger: '#f00' } };
  vi.useFakeTimers(); vi.setSystemTime(new Date(stamp));
  let renderer!: ReactTestRenderer;
  const Screen = screens.get('runs')!;
  await act(async () => { renderer = create(<QueryClientProvider client={query}><Screen theme={theme} host={{ id: 'host-a', label: 'Host A' }} layout={{ compact: true, platform: 'ios' }} params={{}} /></QueryClientProvider>); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); });
  const text = () => renderer.root.findAllByType('Text' as any).map(node => node.children.join(''));
  const shown = () => text().join('\n');
  const visible = () => JSON.stringify(renderer.toJSON());
  // Bounded wait for the real catalog read and its QueryClient delivery.
  for (let n = 0; n < 200 && !shown().includes('Link a repository to see its runs.'); n++) {
    await act(async () => { await pause(5); await vi.advanceTimersByTimeAsync(5); });
  }
  // One runs-specific instruction, one Setup guide, no GitHub-issues boilerplate.
  expect(text().filter(line => line === 'Link a repository to see its runs.')).toHaveLength(1);
  expect(shown()).not.toContain('Repositories aren’t linked. Link repositories to see GitHub issues.');
  expect(shown()).not.toContain('select a repository to browse');
  expect(shown()).not.toContain('Selected host:');
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'Setup guide' })).toHaveLength(1);
  expect(renderer.root.findAll(node => node.props.accessibilityLabel?.startsWith('Select '))).toHaveLength(0);
  // A confirmed unconfigured host reads no runs and offers no catalog Refresh.
  expect(host.readRuns).not.toHaveBeenCalled(); expect(host.readRun).not.toHaveBeenCalled();
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'Refresh' })).toHaveLength(0);
  expect(host.readCatalog).toHaveBeenCalledTimes(1);
  // The one guide explains the operator procedure and applies nothing.
  await act(async () => { renderer.root.findByProps({ accessibilityLabel: 'Setup guide' }).props.onPress(); });
  expect(renderer.root.findByProps({ accessibilityLabel: 'Repository setup guide' }).findAllByType('Text' as any)
    .map(node => node.children.join('')).join('\n')).toMatch(/PASEO_ORBI_CONFIG[\s\S]*explicitly reload[\s\S]*does not configure authorization/);
  expect(host.readCatalog).toHaveBeenCalledTimes(1);
  expect(host.readRuns).not.toHaveBeenCalled();
  expect(visible()).not.toContain('SECRET_CANARY');
  await act(async () => renderer.unmount());
  query.clear(); expect(vi.getTimerCount()).toBe(0);
});

it('service_details_lead_with_the_service_and_slot_status_before_setup', async () => {
  vi.stubEnv('PASEO_ORBI_HOST_INVENTORY', '1');
  // Synthetic, unlinked host evidence: one loaded idle worker and one waiting
  // timer. Without PASEO_ORBI_CONFIG the catalog is confirmed unconfigured, so
  // the shared repository notice and its guide exist on the Services list.
  const hostInventory = vi.spyOn(ReadPorts.prototype, 'hostInventory').mockImplementation(async operation => operation === 'runtime'
    ? 'orbi-unclaimed@1.service loaded inactive dead Orbi Runner\norbi-unclaimed@1.timer loaded active waiting Orbi Timer\n'
    : 'orbi-unclaimed@1.service enabled\norbi-unclaimed@1.timer enabled\n');
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const stopServer = serverEntry({ handle: (contract: any, handler: any) => {
    handlers.set(contract.name, async input => contract.output.parse(await handler(contract.input.parse(input))));
  } } as PluginServerContext);
  cleanups.push(stopServer);
  for (const [name, mock] of Object.entries({ 'deployments.list': host.readCatalog, 'services.inventory': host.readInventory })) {
    mock.mockReset().mockImplementation(input => handlers.get(name)!(input));
  }
  host.readControl.mockReset();
  const screens = new Map<string, React.ComponentType<PluginScreenProps>>();
  const stopClient = clientEntry({ addScreen: (screen: any) => { screens.set(screen.id, screen.Component); return vi.fn(); }, addSidebarHeaderItem: () => vi.fn(), openScreen: vi.fn() } as unknown as PluginClientContext);
  cleanups.push(stopClient);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } }); cleanups.push(() => query.clear());
  const theme = { colors: { foreground: '#eee', foregroundMuted: '#aaa', surface0: '#111', surface1: '#222', surface2: '#333', border: '#555', accent: '#abc', accentForeground: '#000', statusSuccess: '#0f0', statusWarning: '#ff0', statusDanger: '#f00' } };
  vi.useFakeTimers(); vi.setSystemTime(new Date(stamp));
  const Screen = screens.get('services')!;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={query}><Screen theme={theme} host={{ id: 'host-a', label: 'Host A' }} layout={{ compact: true, platform: 'ios' }} params={{}} /></QueryClientProvider>); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); });
  const text = () => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
  // Bounded wait for the real catalog and inventory reads to settle.
  for (let n = 0; n < 200 && !text().includes('orbi-unclaimed'); n++) await act(async () => { await pause(5); await vi.advanceTimersByTimeAsync(5); });
  const press = async (label: string) => {
    await act(async () => renderer.root.findByProps({ accessibilityLabel: label }).props.onPress());
    for (let n = 0; n < 20 && query.isFetching() > 0; n++) await act(async () => { await pause(5); await vi.advanceTimersByTimeAsync(5); });
  };
  // The shared repository notice and guide belong to the list.
  expect(text()).toContain('Repositories aren’t linked. Link repositories to see GitHub issues.');
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'Setup guide' })).toHaveLength(1);
  const reads = host.readInventory.mock.calls.length;
  const processCalls = hostInventory.mock.calls.length;
  await press('Details for orbi-unclaimed');
  const page = text();
  // Name, then the failed-first slot facts, then the association note.
  expect(page.indexOf('orbi-unclaimed')).toBeLessThan(page.indexOf('Slot 1 · Worker idle · Timer waiting'));
  expect(page.indexOf('Slot 1 · Worker idle · Timer waiting')).toBeLessThan(page.indexOf('Not linked to a repository.'));
  // Neither the setup notice and guide nor raw units occupy the default view.
  expect(renderer.root.findAllByProps({ testID: 'orbi-setup' })).toHaveLength(0);
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'Setup guide' })).toHaveLength(0);
  expect(page).not.toContain('Repositories aren’t linked.');
  expect(page).not.toContain('orbi-unclaimed@1.service');
  expect(renderer.root.findAllByProps({ testID: 'orbi-service-units' })).toHaveLength(0);
  const toggle = () => renderer.root.findByProps({ accessibilityLabel: 'View diagnostics' });
  expect(toggle().props.accessibilityState).toMatchObject({ expanded: false });
  // The accessible expanded state and the existing evidence agree, with no
  // additional read and no mutation.
  await press('View diagnostics');
  expect(toggle().props.accessibilityState).toMatchObject({ expanded: true });
  expect(text()).toContain('The timer schedules a check. The worker runs it. They are two parts of the same slot, not two workers.');
  expect(text()).toContain('Discovered on this host only; no configured deployment claims this unit name');
  expect(text()).toContain('orbi-unclaimed@1.service: inactive/dead, load loaded');
  expect(host.readInventory.mock.calls.length).toBe(reads);
  expect(hostInventory.mock.calls.length).toBe(processCalls);
  expect(host.readControl).not.toHaveBeenCalled();
  // Back returns to the same permanent list with its one notice.
  await press('Back to services');
  expect(renderer.root.findByProps({ testID: 'orbi-services-heading' }).props.children).toBe('Services · Host A');
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'Setup guide' })).toHaveLength(1);
  expect(renderer.root.findByProps({ accessibilityLabel: 'Details for orbi-unclaimed' })).toBeDefined();
});

it('keeps another repository’s rejection and repair notice off an available service’s details', async () => {
  vi.stubEnv('PASEO_ORBI_HOST_INVENTORY', '1');
  // Mixed configured catalog: one available deployment whose units this host
  // observed, plus one rejected deployment whose source profile no longer matches
  // its pinned compatibility fingerprint. Both go through the real server gate.
  const available = await fixture('release'), rejected = await fixture('installed');
  cleanups.push(available.cleanup, rejected.cleanup);
  await writeFile(rejected.configPath, rejected.toml.replace('Example/project', 'Other/repository').replace('unit_name = "demo"', 'unit_name = "second"'));
  await writeFile(join(rejected.source, 'src/orbi/config.py'), '# changed unsupported source\n');
  await available.save([available.entry, { ...rejected.entry, id: 'second', label: 'Second', repo: 'Other/repository' }]);
  vi.stubEnv('PASEO_ORBI_CONFIG', available.authorization);
  vi.spyOn(ReadPorts.prototype, 'hostInventory').mockResolvedValue(
    'orbi-demo@1.service loaded inactive dead Orbi Runner\norbi-demo@1.timer loaded active waiting Orbi Timer\n');
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const stopServer = serverEntry({ handle: (contract: any, handler: any) => {
    handlers.set(contract.name, async input => contract.output.parse(await handler(contract.input.parse(input))));
  } } as PluginServerContext);
  cleanups.push(stopServer);
  for (const [name, mock] of Object.entries({ 'deployments.list': host.readCatalog, 'services.inventory': host.readInventory })) {
    mock.mockReset().mockImplementation(input => handlers.get(name)!(input));
  }
  host.readControl.mockReset();
  const screens = new Map<string, React.ComponentType<PluginScreenProps>>();
  const stopClient = clientEntry({ addScreen: (screen: any) => { screens.set(screen.id, screen.Component); return vi.fn(); }, addSidebarHeaderItem: () => vi.fn(), openScreen: vi.fn() } as unknown as PluginClientContext);
  cleanups.push(stopClient);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } }); cleanups.push(() => query.clear());
  const theme = { colors: { foreground: '#eee', foregroundMuted: '#aaa', surface0: '#111', surface1: '#222', surface2: '#333', border: '#555', accent: '#abc', accentForeground: '#000', statusSuccess: '#0f0', statusWarning: '#ff0', statusDanger: '#f00' } };
  vi.useFakeTimers(); vi.setSystemTime(new Date(stamp));
  const Screen = screens.get('services')!;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={query}><Screen theme={theme} host={{ id: 'host-a', label: 'Host A' }} layout={{ compact: true, platform: 'ios' }} params={{}} /></QueryClientProvider>); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); });
  const text = () => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
  const flush = async () => { for (let n = 0; n < 20 && query.isFetching() > 0; n++) await act(async () => { await pause(5); await vi.advanceTimersByTimeAsync(5); }); };
  const waitFor = async (condition: () => boolean) => { for (let n = 0; n < 200 && !condition(); n++) await act(async () => { await pause(5); await vi.advanceTimersByTimeAsync(5); }); };
  const press = async (label: string) => { await act(async () => renderer.root.findByProps({ accessibilityLabel: label }).props.onPress()); await flush(); };
  await waitFor(() => text().includes('Other/repository') && text().includes('orbi-demo'));
  const repair = 'Ask the operator to repair the authorized configuration/source profile and reload this plugin.';
  // The list names the rejected repository, its problem and its repair guidance.
  expect(text()).toContain('Second (Other/repository): unsupported_source_profile');
  expect(text()).toContain('compatibility: unsupported_source_profile');
  expect(text()).toContain(repair);
  await press('Details for Example/project');
  const details = text();
  // The available service keeps its own association and the host catalog block ...
  expect(details).toContain('Matches configured deployment Demo (Example/project) by unit name.');
  expect(renderer.root.findAllByProps({ testID: 'orbi-catalog' })).toHaveLength(1);
  // ... while the unrelated repository's rejection, problem and instruction are absent.
  expect(details).not.toContain('Other/repository');
  expect(details).not.toContain('Second (');
  expect(details).not.toContain('unsupported_source_profile');
  expect(details).not.toContain(repair);
  // Back on the list the same rejected entry and its guidance are still visible.
  await press('Back to services');
  expect(renderer.root.findByProps({ testID: 'orbi-services-heading' }).props.children).toBe('Services · Host A');
  expect(text()).toContain('Second (Other/repository): unsupported_source_profile');
  expect(text()).toContain(repair);
});

it('keeps a deferred catalog read pending instead of a failed or unauthorized repository link', async () => {
  vi.stubEnv('PASEO_ORBI_HOST_INVENTORY', '1');
  const f = await fixture(); cleanups.push(f.cleanup);
  vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
  // Host inventory arrives first: one family the host config claims (matched, no
  // catalog entry yet) and one it does not (unmatched, no confirmed absence).
  vi.spyOn(ReadPorts.prototype, 'hostInventory').mockImplementation(async operation => operation === 'runtime'
    ? 'orbi-demo@1.service loaded inactive dead Demo Worker\norbi-demo@1.timer loaded active waiting Demo Timer\norbi-unclaimed@1.service loaded inactive dead Unclaimed Worker\n'
    : 'orbi-demo@1.service enabled\norbi-demo@1.timer enabled\norbi-unclaimed@1.service enabled\n');
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const stopServer = serverEntry({ handle: (contract: any, handler: any) => {
    handlers.set(contract.name, async input => contract.output.parse(await handler(contract.input.parse(input))));
  } } as PluginServerContext);
  cleanups.push(stopServer);
  // The real catalog handler answers only after the pending read is inspected.
  let releaseCatalog!: () => void;
  const catalogGate = new Promise<void>(resolve => { releaseCatalog = resolve; });
  host.readCatalog.mockReset().mockImplementation(async input => { await catalogGate; return handlers.get('deployments.list')!(input); });
  host.readInventory.mockReset().mockImplementation(input => handlers.get('services.inventory')!(input));
  host.readControl.mockReset();
  const screens = new Map<string, React.ComponentType<PluginScreenProps>>();
  const stopClient = clientEntry({ addScreen: (screen: any) => { screens.set(screen.id, screen.Component); return vi.fn(); }, addSidebarHeaderItem: () => vi.fn(), openScreen: vi.fn() } as unknown as PluginClientContext);
  cleanups.push(stopClient);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } }); cleanups.push(() => query.clear());
  const theme = { colors: { foreground: '#eee', foregroundMuted: '#aaa', surface0: '#111', surface1: '#222', surface2: '#333', border: '#555', accent: '#abc', accentForeground: '#000', statusSuccess: '#0f0', statusWarning: '#ff0', statusDanger: '#f00' } };
  vi.useFakeTimers(); vi.setSystemTime(new Date(stamp));
  const Screen = screens.get('services')!;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={query}><Screen theme={theme} host={{ id: 'host-a', label: 'Host A' }} layout={{ compact: true, platform: 'ios' }} params={{}} /></QueryClientProvider>); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); });
  const text = () => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
  const flush = async () => { for (let n = 0; n < 50; n++) await act(async () => { await pause(5); await vi.advanceTimersByTimeAsync(5); }); };
  const waitFor = async (condition: () => boolean) => { for (let n = 0; n < 200 && !condition(); n++) await act(async () => { await pause(5); await vi.advanceTimersByTimeAsync(5); }); };
  await waitFor(() => text().includes('orbi-demo') && text().includes('orbi-unclaimed'));
  expect(text()).toContain('Catalog: Loading');
  const press = async (label: string) => {
    await act(async () => renderer.root.findByProps({ accessibilityLabel: label }).props.onPress());
    await flush();
  };
  const note = () => renderer.root.findByProps({ testID: 'orbi-service-association' }).props.children;
  const repositoryActions = () => renderer.root.findAll(node => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith('View repository'));
  const pendingCopy = 'Repository link not yet confirmed: this host’s repository catalog has not been read yet.';
  // Matched family without an entry yet: not confirmed, not absent, not unauthorized.
  await press('Details for orbi-demo');
  expect(note()).toBe(pendingCopy);
  expect(text()).not.toContain('not in the current authorized catalog');
  expect(text()).not.toContain('restore authorization');
  expect(text()).not.toContain('could not be read');
  // Pending evidence unlocks no repository action.
  expect(repositoryActions()).toHaveLength(0);
  await press('View diagnostics');
  expect(text()).toContain('Repository link not yet confirmed: this host’s repository catalog has not been read yet, so no repository link is confirmed');
  await press('Back to services');
  // Unmatched family: still not a confirmed absence.
  await press('Details for orbi-unclaimed');
  expect(note()).toBe(pendingCopy);
  expect(text()).not.toContain('Not linked to a repository.');
  await press('Back to services');
  // The read settles: the same view shows its supported result.
  await act(async () => { releaseCatalog(); });
  await waitFor(() => text().includes('Example/project'));
  await press('Details for Example/project');
  expect(note()).toBe('Matches configured deployment Demo (Example/project) by unit name.');
  await press('Back to services');
  await press('Details for orbi-unclaimed');
  expect(note()).toBe('Not linked to a repository.');
  expect(host.readControl).not.toHaveBeenCalled();
});

it('validated catalog enables bounded exact-repo issue reads while discovery-only inventory stays independent', async () => {
  vi.stubEnv('PASEO_ORBI_HOST_INVENTORY', '1');
  const f = await fixture(); cleanups.push(f.cleanup);
  vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
  const operations: Array<{ id: string; operation: { kind: string; resource?: string; state?: string; page?: number } }> = [];
  const processPort = vi.spyOn(ReadPorts.prototype, 'process').mockImplementation(async (id, operation) => {
    operations.push({ id, operation });
    if (operation.kind !== 'gh-api-get' || operation.resource !== 'issues') throw new Error('unexpected operation');
    return response([{ number: 42, title: 'Issue 42', state: 'open', updated_at: stamp, labels: [{ name: 'ai-ready' }] }]);
  });
  const hostInventory = vi.spyOn(ReadPorts.prototype, 'hostInventory').mockResolvedValue(
    'orbi-demo@1.service loaded active running Orbi Runner\norbi-demo@1.timer loaded active waiting Orbi Timer\n');
  const stops: Array<() => Promise<void>> = [];
  cleanups.push(async () => { for (const stop of stops.splice(0)) await stop(); });
  const register = () => {
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    stops.push(serverEntry({ handle: (contract: { name: string }, handler: (input: unknown) => Promise<unknown>) => { handlers.set(contract.name, handler); } } as unknown as PluginServerContext));
    return handlers;
  };
  // Operator-reviewed catalog through the supported startup path: the exact
  // repository association is the TOML source_repos value, never a service slug.
  const configured = register();
  expect(await configured.get('deployments.list')!({})).toMatchObject({
    state: 'configured', entries: [{ id: 'demo', repo: f.entry.repo, status: 'available' }],
  });
  expect(f.toml).toContain(`source_repos = ["${f.entry.repo}"]`);
  const page = issuesList.output.parse(await configured.get('issues.list')!({ deploymentId: 'demo', page: 1 }));
  expect(page).toMatchObject({
    state: 'available',
    data: { repo: f.entry.repo, page: 1, hasNextPage: false, records: [{ number: 42, labels: ['ai-ready'], state: 'Ready candidate' }] },
  });
  // Browse defaults to server-side open state, never one all-state page filtered locally.
  expect(operations).toEqual([{ id: 'demo', operation: { kind: 'gh-api-get', resource: 'issues', state: 'open', page: 1 } }]);
  expect(processPort.mock.calls[0]?.[2]).toBe(10000);
  // Bounded page scope: the typed contract refuses out-of-range pages before any read.
  expect(issuesList.input.parse({ deploymentId: 'demo', page: 10 })).toEqual({ deploymentId: 'demo', page: 10, state: 'open' });
  expect(issuesList.input.parse({ deploymentId: 'demo', page: 1, state: 'closed', label: 'good first issue' })).toEqual({ deploymentId: 'demo', page: 1, state: 'closed', label: 'good first issue' });
  for (const invalid of [{ state: 'merged' }, { label: 'bad,label' }, { label: 'x'.repeat(101) }]) expect(() => issuesList.input.parse({ deploymentId: 'demo', page: 1, ...invalid })).toThrow();
  for (const invalid of [0, 11]) expect(() => issuesList.input.parse({ deploymentId: 'demo', page: invalid })).toThrow();
  // Discovery-only inventory works with the catalog and never resolves a repository.
  const inventory = servicesInventory.output.parse(await configured.get('services.inventory')!({}));
  expect(inventory).toMatchObject({ state: 'complete', groups: [{ label: 'orbi-demo', association: 'matched', deploymentId: 'demo' }] });
  expect(processPort).toHaveBeenCalledTimes(1);
  await stops.pop()!();
  // Without a validated catalog there is no issue-read capability; the discovery
  // inventory still answers independently of PASEO_ORBI_CONFIG.
  vi.stubEnv('PASEO_ORBI_CONFIG', undefined);
  const unconfigured = register();
  expect(await unconfigured.get('deployments.list')!({})).toEqual({ state: 'unconfigured', entries: [], problems: [] });
  const githubReads = processPort.mock.calls.length;
  await expect(unconfigured.get('issues.list')!({ deploymentId: 'demo', page: 1 })).rejects.toThrow('deployment_unavailable');
  expect(processPort.mock.calls.length).toBe(githubReads);
  const independent = servicesInventory.output.parse(await unconfigured.get('services.inventory')!({}));
  expect(independent).toMatchObject({ state: 'complete', groups: [{ label: 'orbi-demo' }] });
  expect(processPort.mock.calls.length).toBe(githubReads);
  expect(hostInventory).toHaveBeenCalledTimes(4);
});

it.each(pins)('source_profile $fixture fails closed before telemetry', async pin => {
  const f = await fixture(pin.fixture as NonNullable<Parameters<typeof fixture>[0]>); cleanups.push(f.cleanup);
  const profile = pin.adapter as SourceProfile;
  expect(profiles[profile].commit).toBe(pin.commit);
  expect(await fingerprint(f.source, profile)).toBe(pin.fingerprint);
  const mutated = { v0748: 'src/orbi/question.py', v0765: 'src/orbi/labels.toml' }[pin.fixture] ?? 'src/orbi/config.py';
  await writeFile(join(f.source, mutated), '# changed unsupported source\n');
  vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
  const processPort = vi.spyOn(ReadPorts.prototype, 'process');
  const reads = vi.spyOn(ReadPorts.prototype, 'read');
  const handlers = new Map<string, (input: any) => Promise<any>>();
  cleanups.push(serverEntry({ handle: (c: any, h: any) => handlers.set(c.name, h) } as unknown as PluginServerContext));
  expect((await handlers.get('deployments.list')!({})).entries[0].status).toBe('unsupported_source_profile');
  for (const [name, input] of [
    ['fleet.read', {}], ['issues.list', { page: 1 }], ['issues.get', { issue: 42 }],
    ['runs.list', {}], ['runs.read', { issue: 42, runId: '22222222' }],
    ['blockers.list', { page: 1 }], ['blockers.read', { issue: 4 }], ['workspace.shortcut', {}],
  ] as const) await expect(handlers.get(name)!({ deploymentId: 'demo', ...input })).rejects.toThrow('deployment_unavailable');
  expect(processPort).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled();
});

it.each(['v0748', 'v0765'] as const)('%s deployment answers every Work, Services, Issues, Runs and Blockers read', async profile => {
  vi.stubEnv('PASEO_ORBI_HOST_INVENTORY', '1');
  const f = await fixture(profile); cleanups.push(f.cleanup);
  await mkdir(join(f.repoDir, '.orbi'));
  await writeFile(join(f.repoDir, '.orbi/health.json'), JSON.stringify({ runs: [], last_pickup_ts: 1794697100, alerted: [] }));
  vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
  // Only the external process port is injected; configuration, hash gate and RPC
  // contracts are real, so an unsupported engine checkout could never reach here.
  vi.spyOn(ReadPorts.prototype, 'process').mockImplementation(async (_id, operation) => {
    if (operation.kind === 'systemctl-show') return 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=static\nResult=success\nExecMainStatus=0\n';
    if (operation.kind === 'journalctl') return '';
    if (operation.kind === 'gh-api-get' && operation.resource === 'issues') return response([]);
    throw new Error(`unexpected operation ${operation.kind}`);
  });
  const handlers = new Map<string, (input: any) => Promise<any>>();
  cleanups.push(serverEntry({ handle: (c: any, h: any) => handlers.set(c.name, h) } as unknown as PluginServerContext));
  const adapter = profile === 'v0748' ? 'orbi-0.7.48-release' : 'orbi-0.7.65-release';
  expect((await handlers.get('deployments.list')!({})).entries[0]).toMatchObject({ id: 'demo', repo: 'Example/project', adapter, status: 'available' });
  // Work: the configured-repository detail and its issue rows.
  expect(await handlers.get('fleet.read')!({ deploymentId: 'demo' })).toMatchObject({ state: 'available', data: { repo: 'Example/project', profile: adapter } });
  expect(issuesList.output.parse(await handlers.get('issues.list')!({ deploymentId: 'demo', page: 1 }))).toMatchObject({ state: 'available', data: { repo: 'Example/project', records: [] } });
  // Services, Runs and Blockers answer for the same deployment.
  expect(servicesInventory.output.parse(await handlers.get('services.inventory')!({}))).toMatchObject({ state: 'complete' });
  expect(await handlers.get('runs.list')!({ deploymentId: 'demo' })).toMatchObject({ state: 'available', data: [] });
  expect(blockersList.output.parse(await handlers.get('blockers.list')!({ deploymentId: 'demo', page: 1 }))).toMatchObject({ state: 'available', data: { repo: 'Example/project', records: [] } });
}, 60000);

it('artifact_contract', async () => {
  // Read the candidate tracked file set, NOT a directory copy containing ignored
  // node_modules or an old HEAD archive. New delivery files must be staged first.
  const tracked = execFileSync('timeout', ['10', 'git', 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const runtime = tracked.filter(path => /^(client|server|shared)\//.test(path));
  for (const required of ['paseo-plugin.json', 'index.client.tsx', 'index.server.ts', 'OVERVIEW.md', 'package.json', 'package-lock.json', 'server/compatibility.ts']) expect(tracked).toContain(required);
  expect(runtime.length).toBeGreaterThan(0);
  const root = await mkdtemp(join(tmpdir(), 'paseo-orbi-artifact-'));
  try {
    const candidate = join(root, 'candidate'); await mkdir(candidate);
    for (const path of tracked) {
      const target = join(candidate, path);
      await mkdir(join(target, '..'), { recursive: true }); await copyFile(path, target);
    }
    const pkg = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(join(candidate, 'package-lock.json'), 'utf8'));
    expect(lock.packages[''].dependencies).toEqual(pkg.dependencies);
    expect(lock.packages[''].devDependencies).toEqual(pkg.devDependencies);
    const manifest = JSON.parse(await readFile(join(candidate, 'paseo-plugin.json'), 'utf8'));
    expect(manifest.build).toEqual([['npm', 'ci', '--omit=dev', '--ignore-scripts']]);
    const env = { ...process.env, npm_config_cache: join(root, 'cache'), npm_config_userconfig: join(root, 'npmrc'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
    const packed = JSON.parse(execFileSync('timeout', ['30', 'npm', 'pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: candidate, env, encoding: 'utf8' }))[0].files.map((f: { path: string }) => f.path);
    for (const path of ['paseo-plugin.json', 'index.client.tsx', 'index.server.ts', 'OVERVIEW.md', 'package.json', ...runtime]) expect(packed).toContain(path);
    // npm deliberately excludes package-lock.json: the tracked Git copy, not
    // this tarball inspection, proves manifest preparation.
    const output = execFileSync('timeout', ['120', ...manifest.build[0]], { cwd: candidate, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.info(`Isolated tracked candidate: npm ci --omit=dev --ignore-scripts\n${output}exit=0`);
    expect(JSON.parse(await readFile(join(candidate, 'node_modules/smol-toml/package.json'), 'utf8')).version).toBe('1.9.1');
    const installed = (await Promise.all((await readdir(join(candidate, 'node_modules'))).filter(n => !n.startsWith('.')).map(async name => name.startsWith('@')
      ? (await readdir(join(candidate, 'node_modules', name))).map(child => `${name}/${child}`) : [name]))).flat();
    expect(installed).toEqual(['smol-toml']);
    const parsed = execFileSync('timeout', ['10', process.execPath, '--input-type=module', '-e', "import { parse } from 'smol-toml'; console.log(parse('schema = 1').schema)"], { cwd: candidate, encoding: 'utf8' });
    expect(parsed.trim()).toBe('1');
    expect(await readFile(join(candidate, 'package-lock.json'), 'utf8')).toBe(await readFile('package-lock.json', 'utf8'));
  } finally { await rm(root, { recursive: true, force: true }); }
}, 150000);
