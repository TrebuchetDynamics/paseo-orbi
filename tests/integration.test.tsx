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
    const issue = (n: number) => ({ number: n, title: `Issue ${n}`, state: n === 99 ? 'closed' : 'open', updated_at: stamp, labels: [{ name: n === 4 ? 'ai-blocked' : 'ai-in-progress' }], body: 'BODY_SECRET_CANARY' });
    if (op.resource === 'issues') return response([42, 420, 4, ...(op.state === 'open' ? [] : [99, ...(op.page === 1 ? Array.from({ length: 96 }, (_, i) => 1000 + i) : [])])].map(issue));
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
  for (const [name, mock] of Object.entries({ 'deployments.list': host.readCatalog, 'services.inventory': host.readInventory, 'fleet.read': host.readFleet, 'issues.list': host.readIssues, 'issues.get': host.readIssue, 'runs.list': host.readRuns, 'runs.read': host.readRun, 'blockers.list': host.readBlockers, 'blockers.read': host.readBlocker })) {
    mock.mockReset().mockImplementation(input => handlers.get(name)!(input));
  }
  const screens = new Map<string, React.ComponentType<PluginScreenProps>>();
  const removed = vi.fn(), openScreen = vi.fn();
  const stopClient = clientEntry({ addScreen: (screen: any) => { screens.set(screen.id, screen.Component); return removed; }, addSidebarHeaderItem: () => removed, openScreen } as unknown as PluginClientContext);
  cleanups.push(stopClient);
  expect([...screens.keys()]).toEqual(['fleet', 'issues', 'runs', 'blockers']);
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
  // Host inventory is not opted in here: the Overview keeps the #24 catalog
  // semantics and adds no discovered family or repository action.
  expect(host.readInventory).toHaveBeenCalledTimes(1);
  expect(text()).toContain('Host service check: off');
  expect(text()).toContain('undecided');
  expect(text()).not.toContain('Observed unit families');
  expect(text()).not.toContain('last successful check');
  expect(text().indexOf('Your Linux user services')).toBeLessThan(text().indexOf('Demo (Example/project)'));
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'Refresh host services' })).toHaveLength(0);
  await press('Set up service access');
  expect(text()).toContain('PASEO_ORBI_HOST_INVENTORY=1');
  expect(text()).toContain('Connected clients on this host can then see Orbi unit names');
  expect(text()).not.toContain('View repository');
  partial = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(31000); }); await settle();
  expect(text()).toContain('partial'); expect(text()).toContain('systemd: process_failed');
  expect(text()).toContain('Occupancy: unknown'); partial = false;
  await press('Active work for Demo'); expect(openScreen).toHaveBeenCalledWith({ screenId: 'issues', params: { deploymentId: 'demo' } });
  await act(async () => renderer.update(tree('issues'))); await settle();
  expect(text()).toContain('Issue 42');
  await press('Inspect issue 42'); expect(text()).toContain('Dependencies: no open blockers observed'); expect(text()).toContain('Reported run: 22222222; reports complete');
  // Same deployment ID on another online host must remount local selection,
  // while a cancelled old-host detail cannot publish late into either generation.
  expect(host.readCatalog).toHaveBeenCalledTimes(2); // initial + the 30-second poll, no second owner on Issues
  expect(renderer.root.findByProps({ accessibilityLabel: 'Next page' }).props.disabled).toBe(false);
  await press('Next page'); expect(text()).toContain('Page 2.');
  await press('Inspect issue 42');
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
  const aPage = query.getQueryData<any>(['paseo-orbi', 'host-b', 'demo', 'issues.list:Example/project:1']);
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
  expect(text()).toContain('stale'); expect(text()).toContain('process_failed');
  const calls = processPort.mock.calls.length;
  await act(async () => renderer.update(tree('blockers', { ...second, host: { id: 'host-b', label: 'Host B' } } as PluginScreenProps))); await settle();
  expect(text()).toContain('Selected host is offline'); expect(text()).not.toContain('test.log: present'); expect(processPort).toHaveBeenCalledTimes(calls);
  failed = false; malformed = false;
  await act(async () => renderer.update(tree('blockers', second)));
  await act(async () => { await vi.advanceTimersByTimeAsync(61000); }); await settle();
  await press('Inspect blocker 4');
  expect(text()).toContain('complete report read'); expect(text()).toContain('test.log: present'); expect(text()).not.toContain('process_failed');
  expect(JSON.stringify(transported)).not.toMatch(/CANARY|publisher-canary|\/tmp\/|configPath|engineSourcePath|repoDir|deployHome/);
  expect(await Promise.all([snapshot(a.root), snapshot(b.root)])).toEqual(before);
  expect(processPort.mock.calls.every(([, op, deadline]) => ['systemctl-show', 'journalctl', 'gh-api-get'].includes(op.kind) && (deadline === undefined || deadline <= 10000))).toBe(true);
  await act(async () => renderer.unmount()); cleanups.pop();
  expect(host.listeners.size).toBe(0);
  query.clear(); expect(vi.getTimerCount()).toBe(0);
  const finalCalls = processPort.mock.calls.length;
  await vi.advanceTimersByTimeAsync(61000); expect(processPort).toHaveBeenCalledTimes(finalCalls);
  stopClient(); expect(removed).toHaveBeenCalledTimes(5);
  await stopServer(); expect(dispose).toHaveBeenCalled();
});

it.each(pins)('source_profile $fixture fails closed before telemetry', async pin => {
  const f = await fixture(pin.fixture as 'release' | 'installed'); cleanups.push(f.cleanup);
  const profile = pin.adapter as SourceProfile;
  expect(profiles[profile].commit).toBe(pin.commit);
  expect(await fingerprint(f.source, profile)).toBe(pin.fingerprint);
  await writeFile(join(f.source, 'src/orbi/config.py'), '# changed unsupported source\n');
  vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
  const processPort = vi.spyOn(ReadPorts.prototype, 'process');
  const reads = vi.spyOn(ReadPorts.prototype, 'read');
  const handlers = new Map<string, (input: any) => Promise<any>>();
  cleanups.push(serverEntry({ handle: (c: any, h: any) => handlers.set(c.name, h) } as unknown as PluginServerContext));
  expect((await handlers.get('deployments.list')!({})).entries[0].status).toBe('unsupported_source_profile');
  for (const [name, input] of [
    ['fleet.read', {}], ['issues.list', { page: 1 }], ['issues.get', { issue: 42 }],
    ['runs.list', {}], ['runs.read', { issue: 42, runId: '22222222' }],
    ['blockers.list', { page: 1 }], ['blockers.read', { issue: 4 }],
  ] as const) await expect(handlers.get(name)!({ deploymentId: 'demo', ...input })).rejects.toThrow('deployment_unavailable');
  expect(processPort).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled();
});

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
