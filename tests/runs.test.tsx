import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, writeFile, readFile, readdir, lstat, chmod, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, type FixtureProfile } from './helpers/fixtures';
import { ConfigRepository } from '../server/config';
import { ReadPorts } from '../server/read-ports';
import { GitHubReader } from '../server/github';
import { projectEvents } from '../server/events';
import { runsList, runsRead, RunSummary } from '../shared/runs';
import { deploymentsList } from '../shared/common';
import contribute from '../index.server';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { RunsReader } from '../server/runs';

it('exact_membership_and_retained_history', async () => {
  const fixture = await membershipFixture();
  const first = await fixture.reader.list({ deploymentId: 'demo' });
  expect(first.data?.map(row => [row.issue, row.runId])).toEqual([[42, '22222222'], [420, '33333333']]);
  expect(first.data?.[0].stage).toBeNull(); // newest report has no progress; never borrow an older run
  fixture.incomplete();
  expect((await fixture.reader.list({ deploymentId: 'demo' })).state).toBe('stale');
  fixture.terminal();
  expect((await fixture.reader.list({ deploymentId: 'demo' })).data).toEqual([]);
  const history = await fixture.reader.list({ deploymentId: 'demo', issue: 42 });
  expect(history.data?.some(row => row.runId === '11111111' && row.membership === 'history')).toBe(true);
  expect(history.data?.every(row => row.issue === 42)).toBe(true);
});

const records = JSON.parse(await readFile(new URL('./fixtures/runs/records.json', import.meta.url), 'utf8'));
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
const response = (data: unknown, code = 200) => `HTTP/2.0 ${code} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}`;
const repo = 'Example/project';
const comment = (run: string, extra = '', id = 1) => ({ id, user: { login: 'publisher-canary' }, updated_at: `2026-10-15T06:20:${String(id).padStart(2, '0')}Z`, body: `<!-- orbi:run=${run} -->\n${extra || '<!-- orbi:comment=started -->'}` });
const progress = '<!-- orbi:progress:v1 {"step":"checks","reported_at":"2026-10-15T06:20:00Z","activity":null} -->';
const scene = '<!-- orbi:scene:v1 {"schema":1,"run_id":"22222222","base_branch":"main","base_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pr_url":"https://github.com/Example/project/pull/7","external":"","review_round":1} -->';
function issue(number: number, labels = ['ai-in-progress']) { return { number, title: `Issue ${number}`, labels: labels.map(name => ({ name })), state: 'open', updated_at: '2026-10-15T06:20:00Z' }; }
async function membershipFixture(profile: FixtureProfile = 'release', journal = records.journal) {
  const files = await fixture(profile); cleanups.push(files.cleanup);
  const repository = await ConfigRepository.load(files.authorization);
  const ports = new ReadPorts(repository); cleanups.push(() => ports.dispose());
  let now = Date.parse('2026-10-15T06:20:00Z'), failed = false, terminal = false;
  const clock = vi.spyOn(ports, 'clock').mockImplementation(() => new Date(now));
  const tree = (n = 42, run = '22222222') => join(files.repoDir, '.worktrees', `orbi-Example-project-issue-${n}-${run}`);
  const saveRun = async (n: number, run: string, extra = {}) => {
    await mkdir(join(tree(n, run), '.orbi'), { recursive: true });
    await mkdir(join(tree(n, run), '.pi-session'), { recursive: true });
    await writeFile(join(tree(n, run), '.orbi/run-state.json'), JSON.stringify({ repo, issue: n, run_id: run, branch: `orbi/Example-project-issue-${n}`, created_at: '2026-10-15T06:00:00Z', worktree: '/DO_NOT_FOLLOW_CANARY', ...extra }));
    await writeFile(join(tree(n, run), '.pi-session/one.jsonl'), [records.session, records.message].map(r => JSON.stringify(r)).join('\n') + '\n');
  };
  await saveRun(42, '11111111'); await saveRun(42, '22222222'); await saveRun(420, '33333333'); await saveRun(99, '44444444');
  let comments = [comment('11111111', progress), comment('22222222', '', 2)];
  let checks: unknown[] = [records.check];
  const processPort = vi.spyOn(ports, 'process').mockImplementation(async (_id, op) => {
    if (op.kind === 'journalctl') return op.slot === 1 ? JSON.stringify(journal) + '\n' : '';
    if (op.kind !== 'gh-api-get') throw new Error('unexpected operation');
    if (op.resource === 'issues') return failed ? response({}, 500) : response(terminal ? [issue(42, ['ai-in-progress', 'ai-blocked']), { ...issue(420), state: 'closed' }, issue(99, ['ai-ready'])] : [issue(42), issue(420), issue(99, ['ai-ready'])]);
    if (op.resource === 'comments') return response(op.issue === 42 ? comments : [comment('33333333', progress)]);
    if (op.resource === 'pull') return response(records.pull);
    if (op.resource === 'checks') return response({ check_runs: checks });
    return response([]);
  });
  const github = new GitHubReader(repository, ports), reader = new RunsReader(repository, ports, github);
  return { ...files, reader, repository, ports, github, tree, saveRun, processPort, clock,
    advance: () => { now += 30001; }, incomplete: () => { now += 30001; failed = true; }, terminal: () => { now += 30001; failed = false; terminal = true; },
    setComments: (next: typeof comments) => { now += 30001; comments = next; }, setChecks: (next: unknown[]) => { now += 30001; checks = next; } };
}

it('keeps initial incomplete scope empty, never borrows old progress, and validates state attribution before sessions', async () => {
  const f = await membershipFixture(); f.incomplete();
  expect(await f.reader.list({ deploymentId: 'demo' })).toMatchObject({ state: 'unavailable', data: null });
  f.terminal();
  const history = await f.reader.list({ deploymentId: 'demo', issue: 42 });
  expect(history.data?.map(r => [r.runId, r.stage, r.membership])).toEqual([['11111111', null, 'history'], ['22222222', null, 'history']]);
  const spy = vi.spyOn(f.ports, 'sessions');
  for (const extra of [{ issue: 420 }, { repo: 'Foreign/repo' }, { run_id: 'ffffffff' }, { branch: 'untrusted-branch' }]) {
    await f.saveRun(42, '22222222', extra);
    const row = (await f.reader.read({ deploymentId: 'demo', issue: 42, runId: '22222222' })).data?.summary;
    expect(row).toMatchObject({ branch: null, sessions: [] });
  }
  expect(spy).not.toHaveBeenCalled();
  await expect(f.reader.list({ deploymentId: 'unknown' })).rejects.toThrow('deployment_unavailable');
});

async function snapshot(root: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), stat = await lstat(path);
    result.push([name, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino, stat.isDirectory() ? await snapshot(path) : createHash('sha256').update(await readFile(path)).digest('hex')]);
  }
  return result;
}
it.each(['release', 'installed', 'v0748'] as const)('projects retained events only for supported retention profiles: %s', async profile => {
  const f = await membershipFixture(profile, { ...records.journal, MESSAGE: 'INFO [22222222] worktree_retained run_id=22222222 issue=42' });
  const detail = await f.reader.read({ deploymentId: 'demo', issue: 42, runId: '22222222' });
  expect(detail.data?.events.map(row => row.event)).toEqual(profile === 'release' ? [] : ['worktree_retained']);
});

it('bounded_private_event_projection', async () => {
  const f = await membershipFixture('installed');
  const path = join(f.tree(), '.pi-session/one.jsonl');
  const header = JSON.stringify(records.session) + '\n';
  const message = JSON.stringify(records.message) + '\n';
  const oversized = JSON.stringify({ type: 'message', prompt: 'PROMPT_SECRET_CANARY'.repeat(20000) }) + '\n';
  await writeFile(path, header + oversized + message + '{"incomplete":"TAIL_SECRET_CANARY');
  const before = await snapshot(join(f.repoDir, '.worktrees'));
  const detail = await f.reader.read({ deploymentId: 'demo', issue: 42, runId: '22222222' });
  const activity = detail.data?.summary.sessions[0];
  expect(activity).toMatchObject({ sessionId: 'session-42', state: 'available', kind: 'command', at: records.message.timestamp, problems: [{ code: 'incomplete' }] });
  expect(detail.data?.events).toEqual([{ at: new Date(Number(BigInt(records.journal.__REALTIME_TIMESTAMP) / 1000n)).toISOString(), event: 'run_start', runId: '22222222', issue: 42 }]);
  expect(JSON.stringify(detail)).not.toMatch(/CANARY|PRIVATE_|command=|arguments|thinking|errorMessage/);
  expect(await snapshot(join(f.repoDir, '.worktrees'))).toEqual(before); // atime deliberately excluded
  const range = vi.spyOn(f.ports, 'sessionRange');
  await f.reader.list({ deploymentId: 'demo', issue: 42 });
  expect(range.mock.calls.every(call => call[5] <= 262144)).toBe(true);
  expect(range.mock.calls.some(call => call[4] > 0)).toBe(true);
  // Finish a partial record, then append a new complete event: no private fragment survives.
  await writeFile(path, header + message);
  const truncated = await f.reader.read({ deploymentId: 'demo', issue: 42, runId: '22222222' });
  expect(truncated.data?.summary.sessions[0]).toMatchObject({ kind: 'command', problems: [] });
  await rename(path, path + '.old');
  await writeFile(path, header.replace('session-42', 'session-new') + message.replace('bash', 'read'));
  expect((await f.reader.read({ deploymentId: 'demo', issue: 42, runId: '22222222' })).data?.summary.sessions[0]).toMatchObject({ sessionId: 'session-new', kind: 'read' });
  await writeFile(path, message); // no complete session identity
  expect((await f.reader.read({ deploymentId: 'demo', issue: 42, runId: '22222222' })).data?.summary.sessions[0]).toMatchObject({ sessionId: null, state: 'unavailable', at: null, kind: null });
  const malformedRecords = ['{bad}', '42', '[]', '{}',
    ...[[], {}, { role: 42 }, { role: 'assistant', content: [null] }, { role: 'assistant', content: [{ type: 'toolCall' }] }]
      .map(message => JSON.stringify({ type: 'message', message }))];
  for (const malformed of malformedRecords) {
    await writeFile(path, header + malformed + '\n' + message);
    expect((await f.reader.read({ deploymentId: 'demo', issue: 42, runId: '22222222' })).data?.summary.sessions[0]).toMatchObject({ state: 'unavailable', at: null, kind: null, problems: expect.arrayContaining([{ source: 'filesystem', code: 'invalid_response' }]) });
  }
  await writeFile(path, header + JSON.stringify({ type: 'message', prompt: 'x'.repeat(70000) }) + '\n' + message);
  expect((await f.reader.read({ deploymentId: 'demo', issue: 42, runId: '22222222' })).data?.summary.sessions[0]?.problems.length).toBeGreaterThan(0);
  const scope = { repo, issue: 42, runId: '22222222', unit: 'orbi-demo@1.service', retained: true };
  const event = (MESSAGE: string, extra = {}) => JSON.stringify({ ...records.journal, MESSAGE, ...extra });
  const validEnd = 'INFO [22222222] run_end run=22222222 issue=Example/project#42 role=ticket result=ok elapsed=1s';
  const cleanup = 'INFO [22222222] worktree_retained run_id=22222222 issue=42 reason="ERROR_SECRET_CANARY"';
  const rejects = [
    validEnd + ' run=22222222', validEnd + ' issue=Example/project#42', validEnd + ' free text SECRET',
    validEnd.replace('run=22222222', 'run=ffffffff'), validEnd.replace('#42', '#420'), validEnd.replace('run_end', 'run_failed'),
    validEnd.replace('run_end', 'heartbeat'), validEnd.replace('[22222222]', '[ffffffff]'), cleanup.replace('issue=42', 'issue=420'),
    validEnd + ' action="unterminated', validEnd + ' run_id=22222222',
  ];
  const projected = projectEvents([event(validEnd), event(cleanup), event(cleanup.replace('retained', 'cleaned')), ...rejects.map(line => event(line)), event(validEnd, { _SYSTEMD_USER_UNIT: 'evil.service' }), event(validEnd, { __REALTIME_TIMESTAMP: 'at=SECRET' }), '{bad}', 'x'.repeat(65537)].join('\n'), scope);
  expect(projected.events.map(e => e.event)).toEqual(['run_end', 'worktree_retained', 'worktree_cleaned']);
  expect(JSON.stringify(projected)).not.toContain('SECRET');
  expect(projected.problems).toEqual(expect.arrayContaining([{ source: 'journal', code: 'incomplete' }, { source: 'journal', code: 'invalid_response' }]));
  expect(projectEvents(event(cleanup), { ...scope, retained: false }).events).toEqual([]);
  const duplicateJson = event(validEnd).replace('"MESSAGE":', '"MESSAGE":"SECRET", "MESS\\u0041GE":');
  expect(projectEvents(duplicateJson, scope).events).toEqual([]);
  expect(projectEvents(event(validEnd + ' action="escaped\\\\nSECRET"'), scope).events).toHaveLength(1);
  const capped = projectEvents(Array.from({ length: 201 }, () => event(validEnd)).join('\n'), scope);
  expect(capped.events).toHaveLength(200); expect(Buffer.byteLength(JSON.stringify(capped.events))).toBeLessThanOrEqual(65536);
  expect(capped.problems).toContainEqual({ source: 'journal', code: 'read_limit' });
  // Capture actual argv through the real process port, not an invented command seam.
  f.processPort.mockRestore();
  const bin = join(f.root, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'journalctl'), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)))`); await chmod(join(bin, 'journalctl'), 0o755);
  vi.stubEnv('PATH', bin);
  expect(JSON.parse(await f.ports.process('demo', { kind: 'journalctl', slot: 1 }))).toEqual(['--user', '-u', 'orbi-demo@1.service', '--no-pager', '--since', '-1 hour', '-n', '200', '-o', 'json']);
  await writeFile(join(bin, 'journalctl'), `#!${process.execPath}\nsetInterval(() => {}, 1000);`);
  const pending = f.ports.process('demo', { kind: 'journalctl', slot: 1 });
  const rejection = expect(pending).rejects.toThrow('disposed');
  await f.ports.dispose(); await rejection;
  expect((f.ports as unknown as { children: Map<unknown, unknown> }).children.size).toBe(0);
  await expect(f.ports.process('demo', { kind: 'journalctl', slot: 1 })).rejects.toThrow('disposed');
});

it('bounds exact discovery without choosing a filename/mtime winner and rejects symlinks', async () => {
  const f = await membershipFixture();
  await mkdir(join(f.repoDir, '.worktrees/orbi-Example-project-issue-42-not-a-run'));
  await mkdir(join(f.repoDir, '.worktrees/orbi-Other-project-issue-42-88888888'));
  await symlink(f.tree(), join(f.repoDir, '.worktrees/orbi-Example-project-issue-42-99999999'));
  expect(await f.ports.worktrees('demo', 42)).toEqual([{ issue: 42, runId: '11111111' }, { issue: 42, runId: '22222222' }]);
  for (let n = 0; n < 17; n++) await writeFile(join(f.tree(), `.pi-session/${n}.jsonl`), '{}\n');
  await expect(f.ports.sessions('demo', 42, '22222222')).rejects.toThrow('read_limit');
  for (let n = 0; n < 201; n++) await mkdir(join(f.repoDir, '.worktrees', `orbi-Example-project-issue-42-${n.toString(16).padStart(8, '0')}`));
  await expect(f.ports.worktrees('demo', 42)).rejects.toThrow('read_limit');
  await expect(f.ports.sessionRange('demo', 42, '22222222', '../escape.jsonl', 0, 20)).rejects.toThrow('unsafe_path');
});

it('looks up only trusted exact-repo PR identity and qualifies only checks for the observed head', async () => {
  const f = await membershipFixture();
  const input = { deploymentId: 'demo', issue: 42, runId: '22222222' };
  const get = vi.spyOn(f.github, 'getPullRequestEvidence');
  await f.reader.read(input); expect(get).not.toHaveBeenCalled();
  f.setComments([comment('22222222', scene)]);
  expect((await f.reader.read(input)).data?.pr).toMatchObject({ number: 7, head: { sha: 'a'.repeat(40) }, checksState: 'passed', checks: [{ name: 'unit tests', status: 'completed', conclusion: 'success', url: records.check.html_url }] });
  for (const [check, state] of [
    [{ ...records.check, head_sha: 'b'.repeat(40) }, 'stale_head'],
    [{ ...records.check, status: 'in_progress', conclusion: null }, 'pending'],
    [{ ...records.check, conclusion: 'failure' }, 'failed'],
    [{ ...records.check, head_sha: undefined }, 'missing'],
  ] as const) {
    f.setChecks([check]); expect((await f.reader.read(input)).data?.pr?.checksState).toBe(state);
  }
  // The documented notice conclusion must not reject the page as inaccessible.
  f.setChecks([{ ...records.check, conclusion: 'notice' }]);
  const notice = await f.reader.read(input);
  expect(notice.data?.pr?.checksState).not.toBe('inaccessible');
  expect(notice.data?.pr?.checks).toEqual([{ name: 'unit tests', status: 'completed', conclusion: 'notice', url: records.check.html_url }]);
  expect(notice.problems).not.toContainEqual({ source: 'github', code: 'invalid_response' });
  // Strict wire validation: an undocumented conclusion is still rejected.
  f.setChecks([{ ...records.check, conclusion: 'undocumented' }]);
  const undocumented = await f.reader.read(input);
  expect(undocumented.data?.pr?.checksState).toBe('inaccessible');
  expect(undocumented.problems).toContainEqual({ source: 'github', code: 'invalid_response' });
  f.setChecks([]); expect((await f.reader.read(input)).data?.pr?.checksState).toBe('missing');
  f.setChecks([{ ...records.check, html_url: 'https://evil.invalid/SECRET' }]);
  expect((await f.reader.read(input)).data?.pr?.checks[0].url).toBeNull();
  // Invalid/missing/newer identity and historical runs never borrow an old PR.
  get.mockClear();
  const selectedReports = await f.github.readIssueReports('demo', 42);
  vi.spyOn(f.github, 'readIssueReports').mockResolvedValueOnce({ ...selectedReports, prIdentity: { status: 'conflict' } });
  expect((await f.reader.read(input)).data?.prIdentity.status).toBe('conflict'); expect(get).not.toHaveBeenCalled();
  await f.reader.read({ ...input, runId: '11111111' }); expect(get).not.toHaveBeenCalled();
  f.setComments([comment('22222222', scene.replace('Example/project/pull', 'Foreign/project/pull'))]);
  const invalid = await f.reader.read(input); expect(invalid.data?.prIdentity.status).toBe('invalid'); expect(get).not.toHaveBeenCalled();
  f.advance(); f.processPort.mockImplementation(async (_id, op) => {
    if (op.kind === 'gh-api-get' && op.resource === 'comments') return response([comment('22222222', scene)]);
    if (op.kind === 'gh-api-get' && op.resource === 'pull') return response(records.pull);
    if (op.kind === 'gh-api-get' && op.resource === 'checks') return response({}, 401);
    return '';
  });
  expect((await f.reader.read(input)).data?.pr?.checksState).toBe('inaccessible');
  expect(JSON.stringify(await f.reader.read(input))).not.toContain('CHECK_OUTPUT_CANARY');
});

it('registers strict Runs RPCs, resolves catalog IDs and retains rejected diagnostics', async () => {
  const f = await membershipFixture(); vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
  const handlers = new Map<unknown, (input: any) => Promise<unknown>>();
  const cleanup = contribute({ handle: (contract: unknown, handler: (input: any) => Promise<unknown>) => handlers.set(contract, handler) } as unknown as PluginServerContext); cleanups.push(cleanup);
  vi.spyOn(ReadPorts.prototype, 'process').mockImplementation(async (_id, op) => op.kind === 'gh-api-get' ? response(op.resource === 'issues' ? [issue(42)] : op.resource === 'comments' ? [comment('22222222', progress)] : []) : '');
  const catalog = await handlers.get(deploymentsList)!({}); expect(JSON.stringify(catalog)).not.toContain(f.repoDir);
  const listed = runsList.output.parse(await handlers.get(runsList)!({ deploymentId: 'demo' }));
  expect(listed.data?.[0]).toMatchObject({ issue: 42, runId: '22222222', stage: 'checks' });
  const detail = runsRead.output.parse(await handlers.get(runsRead)!({ deploymentId: 'demo', issue: 42, runId: '22222222' }));
  expect(detail.data?.summary.sessions[0].kind).toBe('command');
  expect(JSON.stringify(detail)).not.toMatch(/CANARY|repoDir|arguments|message|worktree/);
  expect(() => runsRead.input.parse({ deploymentId: 'demo', issue: 42, runId: '22222222', path: '/tmp' })).toThrow();
  await expect(handlers.get(runsList)!({ deploymentId: 'rejected' })).rejects.toThrow('deployment_unavailable');
});

import './helpers/host';
import { host } from './helpers/host';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Shell } from '../client/shell';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const screenProps = { theme: { colors: { foreground: '#eee', foregroundMuted: '#aaa', surface0: '#111' } }, host: { id: 'host-a', label: 'Host A' }, layout: { compact: true, platform: 'web' }, params: { deploymentId: 'demo' }, route: 'runs', openScreen: vi.fn() } as unknown as React.ComponentProps<typeof Shell>;
const row: RunSummary = { deploymentId: 'demo', repo, issue: 42, runId: '22222222', membership: 'scope', lifecycle: 'Implementing', stage: 'checks', failure: null, branch: 'orbi/Example-project-issue-42', createdAt: '2026-10-15T06:00:00Z', pushedHead: 'a'.repeat(40), reviewedHead: 'b'.repeat(40), sessions: [{ sessionId: 'session-42', at: '2026-10-15T06:01:00Z', kind: 'command', state: 'available', problems: [] }], problems: [] };
const observation = <T,>(data: T) => ({ state: 'available' as const, observedAt: new Date().toISOString(), lastSuccessfulAt: new Date().toISOString(), data, problems: [] });
const pr = (checksState: string) => ({ summary: row, prIdentity: { status: 'available', runId: row.runId, number: 7, url: records.pull.html_url, source: 'scene' }, events: [], pr: { number: 7, url: records.pull.html_url, state: 'open', merged_at: null, head: { sha: 'a'.repeat(40) }, checksState, checks: [] } });
it('checks_and_selection_lifecycle', async () => {
  vi.useFakeTimers();
  host.hosts = [{ serverId: 'host-a', label: 'Host A', status: 'online' }, { serverId: 'host-b', label: 'Host B', status: 'online' }];
  host.readCatalog.mockResolvedValue({ state: 'configured', entries: [{ id: 'demo', label: 'Demo', repo, status: 'available', problems: [] }, { id: 'bad', label: 'Rejected', repo: 'Other/repo', status: 'invalid_config', problems: [{ source: 'config', code: 'config_mismatch' }] }], problems: [] });
  host.readRuns.mockReset().mockResolvedValue(observation([row]));
  host.readRun.mockReset().mockResolvedValue(observation(pr('stale_head')));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={client}><Shell {...screenProps} /></QueryClientProvider>); });
  const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2); }); };
  const press = async (label: string) => { await act(async () => { renderer.root.findAll(node => node.type === ('Pressable' as any) && node.props.accessibilityLabel === label)[0].props.onPress(); }); await settle(); await settle(); };
  const visible = () => JSON.stringify(renderer.toJSON());
  await settle(); await settle();
  expect(visible()).toContain('config_mismatch'); expect(visible()).toContain('no attachment or steering');
  expect(visible()).toContain('Stage checks are not test results');
  expect(host.readRun).not.toHaveBeenCalled();
  await press('Inspect run 42 22222222');
  expect(visible()).toContain('stale_head'); expect(visible()).toContain('head.sha');
  await act(async () => { await vi.advanceTimersByTimeAsync(30001); });
  expect(host.readRuns.mock.calls.length).toBeGreaterThan(1); expect(host.readRun).toHaveBeenCalledTimes(1);
  // Detail does not silently refresh when the app/host resumes after 30s.
  await act(async () => { for (const listener of host.listeners) listener('background'); });
  await act(async () => { await vi.advanceTimersByTimeAsync(31000); });
  await act(async () => { for (const listener of host.listeners) listener('active'); });
  await settle(); await settle();
  expect(host.readRun).toHaveBeenCalledTimes(1);
  host.hosts[0].status = 'offline';
  await act(async () => renderer.update(<QueryClientProvider client={client}><Shell {...screenProps} /></QueryClientProvider>));
  await act(async () => { await vi.advanceTimersByTimeAsync(31000); });
  host.hosts[0].status = 'online';
  await act(async () => renderer.update(<QueryClientProvider client={client}><Shell {...screenProps} /></QueryClientProvider>));
  await settle(); await settle();
  expect(host.readRun).toHaveBeenCalledTimes(1);
  await press('Show active scope');
  await press('Inspect run 42 22222222');
  expect(host.readRun).toHaveBeenCalledTimes(2); // explicit reselection reloads cached detail
  for (const state of ['pending', 'missing', 'failed', 'inaccessible']) {
    host.readRun.mockResolvedValue(observation(pr(state)));
    await act(async () => { renderer.root.findByProps({ testID: 'orbi-runs' }).findAllByProps({ accessibilityLabel: 'Refresh' })[1].props.onPress(); });
    await settle(); await settle(); expect(visible()).toContain(state); expect(visible()).not.toContain('Head checks: passed');
  }
  // A late response for a deselected issue cannot revive its detail.
  let resolveOld!: (value: unknown) => void;
  host.readRun.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  await act(async () => { renderer.root.findByProps({ testID: 'orbi-runs' }).findAllByProps({ accessibilityLabel: 'Refresh' })[1].props.onPress(); });
  await settle();
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Issue number for history' }).props.onChangeText('420'));
  host.readRuns.mockResolvedValue(observation([{ ...row, issue: 420, runId: '33333333', membership: 'history' }]));
  await press('Inspect issue history');
  await act(async () => resolveOld(observation(pr('passed')))); await settle();
  expect(visible()).not.toContain('Head checks'); expect(host.readRuns).toHaveBeenLastCalledWith({ deploymentId: 'demo', issue: 420 });
  expect(visible()).toContain('not active membership');
  // Host switch tears down selection, even when deployment ID is unchanged.
  await press('Inspect run 420 33333333');
  let resolveHost!: (value: unknown) => void;
  host.readRun.mockImplementationOnce(() => new Promise(resolve => { resolveHost = resolve; }));
  await act(async () => { renderer.root.findByProps({ testID: 'orbi-runs' }).findAllByProps({ accessibilityLabel: 'Refresh' })[1].props.onPress(); }); await settle();
  await act(async () => renderer.update(<QueryClientProvider client={client}><Shell {...screenProps} host={{ ...screenProps.host, id: 'host-b' }} /></QueryClientProvider>));
  await settle(); await settle();
  await act(async () => resolveHost(observation(pr('passed')))); await settle();
  expect(visible()).not.toContain('Head checks');
  for (const text of renderer.root.findAllByType('Text' as any)) expect(text.props.style.color).toBe('#eee');
  await act(async () => renderer.unmount()); client.clear();
  expect(host.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  host.hosts = [{ serverId: 'host-a', label: 'Host A', status: 'online' }];
});

it('shows_github_repair_steps_only_next_to_a_reported_problem', async () => {
  vi.useFakeTimers();
  host.hosts = [{ serverId: 'host-a', label: 'Host A', status: 'online' }];
  host.readCatalog.mockReset().mockResolvedValue({ state: 'configured', entries: [{ id: 'demo', label: 'Demo', repo, status: 'available', problems: [] }], problems: [] });
  host.readRuns.mockReset().mockResolvedValue(observation([row]));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2); }); };
  await act(async () => { renderer = create(<QueryClientProvider client={client}><Shell {...screenProps} /></QueryClientProvider>); });
  await settle(); await settle();
  cleanups.push(async () => { await act(async () => renderer.unmount()); client.clear(); });
  const nodes = () => renderer.root.findAllByType('Text' as any);
  const lines = () => nodes().map(node => node.children.map(child => typeof child === 'string' ? child : '').join(''));
  const text = () => lines().join('\n');
  const auth = "Ask the operator to repair the daemon user's existing gh authentication or permissions, then Refresh.";
  // A successful read keeps the one scope line and the cadence, and suggests no repair.
  expect(text()).toContain('Read-only observations, not proof a process is alive. Stage checks are not test results. External Pi sessions are not Paseo agents: no attachment or steering.');
  expect(text()).toContain('Summary refresh: 30 seconds while foreground/connected.');
  expect(text()).not.toMatch(/auth_denied|rate_limited|reset gate/);
  // No unavailable activity is reported while a complete session is attributed.
  expect(text()).not.toContain('Check the session writer externally and Refresh; do not infer idle.');
  // A reported problem prints its repair sentence once, directly after the alert evidence.
  host.readRuns.mockResolvedValue({ ...observation([row]), state: 'partial', problems: [{ source: 'github', code: 'auth_denied' }] });
  await act(async () => { renderer.root.findByProps({ testID: 'orbi-runs' }).findAllByProps({ accessibilityLabel: 'Refresh' })[0].props.onPress(); });
  await settle(); await settle();
  const reported = lines();
  const index = reported.indexOf('github: auth_denied');
  expect(index).toBeGreaterThanOrEqual(0);
  expect(nodes()[index].props.accessibilityRole).toBe('alert');
  expect(reported[index + 1]).toBe(auth);
  expect(reported.filter(line => line === auth)).toHaveLength(1);
  // Unavailable activity earns the session-writer step next to its own evidence line.
  host.readRuns.mockResolvedValue(observation([{ ...row, sessions: [] }]));
  await act(async () => { renderer.root.findByProps({ testID: 'orbi-runs' }).findAllByProps({ accessibilityLabel: 'Refresh' })[0].props.onPress(); });
  await settle(); await settle();
  const activity = lines();
  const unavailable = activity.findIndex(line => line.startsWith('Activity unavailable — no attributed session evidence.'));
  expect(activity[unavailable]).toBe('Activity unavailable — no attributed session evidence. Check the session writer externally and Refresh; do not infer idle.');
  expect(activity).not.toContain(auth); // the earlier repair sentence is gone with its problem
  expect(activity).not.toContain('github: auth_denied');
  await act(async () => renderer.unmount()); client.clear();
  expect(vi.getTimerCount()).toBe(0);
  host.hosts = [{ serverId: 'host-a', label: 'Host A', status: 'online' }];
});

it('navigation_params_preselect_history_and_open_only_an_observed_run_once', async () => {
  vi.useFakeTimers();
  host.hosts = [{ serverId: 'host-a', label: 'Host A', status: 'online' }];
  host.readCatalog.mockResolvedValue({ state: 'configured', entries: [
    { id: 'demo', label: 'Demo', repo, status: 'available', problems: [] },
    { id: 'other', label: 'Other', repo: 'Other/repo', status: 'available', problems: [] }], problems: [] });
  host.readRuns.mockReset().mockImplementation(async (input: { deploymentId: string }) => observation(input.deploymentId === 'other' ? [] : [{ ...row, membership: 'history' as const }]));
  host.readRun.mockReset().mockResolvedValue(observation(pr('passed')));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  const tree = (params: Record<string, string>) => <QueryClientProvider client={client}><Shell {...screenProps} params={params} /></QueryClientProvider>;
  const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2); }); };
  const mount = async (params: Record<string, string>) => {
    if (renderer) await act(async () => renderer.unmount());
    client.clear();
    await act(async () => { renderer = create(tree(params)); });
    await settle(); await settle();
  };
  const update = async (params: Record<string, string>) => { await act(async () => renderer.update(tree(params))); await settle(); await settle(); };
  cleanups.push(async () => { if (renderer) await act(async () => renderer.unmount()); client.clear(); });
  const visible = () => JSON.stringify(renderer.toJSON());
  const issueInput = () => renderer.root.findByProps({ accessibilityLabel: 'Issue number for history' });
  const press = async (label: string) => { await act(async () => { renderer.root.findAll(node => node.type === ('Pressable' as any) && node.props.accessibilityLabel === label)[0].props.onPress(); }); await settle(); await settle(); };

  // A valid pair preselects that issue's history and opens the observed run once.
  await mount({ deploymentId: 'demo', issue: '42', runId: '22222222' });
  expect(issueInput().props.value).toBe('42');
  expect(host.readRuns).toHaveBeenLastCalledWith({ deploymentId: 'demo', issue: 42 });
  expect(host.readRun).toHaveBeenCalledTimes(1);
  expect(host.readRun).toHaveBeenLastCalledWith({ deploymentId: 'demo', issue: 42, runId: '22222222' });
  expect(visible()).toContain('Issue #42 history'); expect(visible()).toContain('Detail evidence — loaded only on selection');
  // One-shot: leaving the detail and a later summary refresh never re-open it.
  await press('Show active scope');
  await act(async () => { await vi.advanceTimersByTimeAsync(30001); });
  await settle(); await settle();
  expect(visible()).not.toContain('Detail evidence — loaded only on selection');
  expect(host.readRun).toHaveBeenCalledTimes(1);
  await press('Inspect run 42 22222222'); // an explicit selection still loads detail evidence
  expect(host.readRun).toHaveBeenCalledTimes(2);

  // Absent or invalid params render today's Runs screen and select nothing.
  host.readRun.mockClear();
  for (const params of [
    { deploymentId: 'demo', issue: '0', runId: '22222222' },
    { deploymentId: 'demo', issue: '042', runId: '22222222' },
    { deploymentId: 'demo', issue: '4.5', runId: '22222222' },
    { deploymentId: 'demo', issue: '9007199254740992', runId: '22222222' },
    { deploymentId: 'demo', issue: '42', runId: 'ABCDEF12' },
    { deploymentId: 'demo', issue: '42', runId: '2222222' },
    { deploymentId: 'demo', issue: '42' },
    { deploymentId: 'demo', runId: '22222222' },
  ] as Record<string, string>[]) {
    await mount(params);
    expect(issueInput().props.value).toBe('');
    expect(host.readRuns).toHaveBeenLastCalledWith({ deploymentId: 'demo' });
    expect(visible()).toContain('Observed active issue scope — no current/live run inferred');
    expect(visible()).not.toContain('Issue #42 history');
    expect(visible()).not.toContain('Requested run');
    expect(host.readRun).not.toHaveBeenCalled();
  }

  // A run id that the observed history does not contain is never selected or looked up.
  host.readRuns.mockImplementation(async () => observation([{ ...row, runId: '33333333', membership: 'history' as const }]));
  await mount({ deploymentId: 'demo', issue: '42', runId: '22222222' });
  expect(issueInput().props.value).toBe('42');
  expect(host.readRuns).toHaveBeenLastCalledWith({ deploymentId: 'demo', issue: 42 });
  expect(host.readRun).not.toHaveBeenCalled();
  expect(visible()).toContain('Inspect run 42 33333333');
  expect(visible()).toContain('Requested run 22222222 is not in the observed history of issue #42; nothing is selected. Refresh after the writer records it; no lookup is guessed.');
  expect(visible()).not.toContain('Detail evidence — loaded only on selection');
  await press('Show active scope'); // a new filter clears the stale navigation notice
  expect(visible()).not.toContain('Requested run 22222222');

  // Changing deployment clears the selection and never carries the run identity across.
  host.readRuns.mockImplementation(async (input: { deploymentId: string }) => observation(input.deploymentId === 'other' ? [] : [{ ...row, membership: 'history' as const }]));
  await mount({ deploymentId: 'demo', issue: '42', runId: '22222222' });
  expect(host.readRun).toHaveBeenCalledTimes(1);
  await update({ deploymentId: 'other' });
  expect(issueInput().props.value).toBe('');
  expect(host.readRuns).toHaveBeenLastCalledWith({ deploymentId: 'other' });
  expect(host.readRun).toHaveBeenCalledTimes(1);
  expect(visible()).toContain('Observed active issue scope');
  expect(visible()).not.toContain('Issue #42 history');
  expect(visible()).not.toContain('Detail evidence — loaded only on selection');
});

it('unconfigured_runs_shows_one_runs_notice_and_guide_without_a_selector_or_read', async () => {
  vi.useFakeTimers();
  host.hosts = [{ serverId: 'host-a', label: 'Host A', status: 'online' }];
  host.readCatalog.mockReset().mockResolvedValue({ state: 'unconfigured', entries: [], problems: [] });
  host.readRuns.mockClear(); host.readRun.mockClear(); host.readFleet.mockClear();
  host.readRuns.mockResolvedValue(observation([]));
  const openScreen = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2); }); };
  await act(async () => { renderer = create(<QueryClientProvider client={client}><Shell {...screenProps} params={{}} openScreen={openScreen} /></QueryClientProvider>); });
  await settle(); await settle();
  const lines = () => renderer.root.findAllByType('Text' as any).map(node => node.children.join(''));
  const text = () => lines().join('\n');
  const visible = () => JSON.stringify(renderer.toJSON());
  // One runs-specific instruction replaces the GitHub-issues setup message.
  expect(lines().filter(line => line === 'Link a repository to see its runs.')).toHaveLength(1);
  expect(visible()).not.toContain('Repositories aren’t linked. Link repositories to see GitHub issues.');
  // No impossible selection prompt and no repeated host line on Runs.
  expect(text()).not.toContain('select a repository to browse');
  expect(text()).not.toContain('Selected host:');
  expect(renderer.root.findAll(node => node.props.accessibilityLabel === 'Setup guide')).toHaveLength(1);
  // A confirmed unconfigured host never reads runs, and rereading startup
  // configuration cannot repair it, so no catalog Refresh is offered either.
  expect(host.readRuns).not.toHaveBeenCalled(); expect(host.readRun).not.toHaveBeenCalled();
  expect(host.readFleet).not.toHaveBeenCalled();
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'Refresh' })).toHaveLength(0);
  expect(host.readCatalog).toHaveBeenCalledTimes(1);
  // The one guide explains the operator procedure and applies nothing.
  await act(async () => { renderer.root.findByProps({ accessibilityLabel: 'Setup guide' }).props.onPress(); });
  await settle();
  const guide = renderer.root.findByProps({ accessibilityLabel: 'Repository setup guide' })
    .findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
  expect(guide).toContain('PASEO_ORBI_CONFIG');
  expect(guide).toContain('does not configure authorization');
  expect(host.readCatalog).toHaveBeenCalledTimes(1);
  expect(host.readRuns).not.toHaveBeenCalled();
  await act(async () => renderer.unmount()); client.clear();
  expect(host.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it('runs_catalog_loading_invalid_rejected_and_unavailable_are_never_mislabeled_unconfigured', async () => {
  vi.useFakeTimers();
  host.hosts = [{ serverId: 'host-a', label: 'Host A', status: 'online' }];
  host.readRuns.mockClear(); host.readRun.mockClear();
  host.readRuns.mockResolvedValue(observation([]));
  const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2); }); };
  const states: Array<[string, () => void, string]> = [
    ['loading', () => host.readCatalog.mockReset().mockImplementationOnce(() => new Promise(() => {})), 'Loading the selected host catalog.'],
    ['invalid', () => host.readCatalog.mockReset().mockResolvedValue({ state: 'invalid', entries: [], problems: [{ source: 'config', code: 'invalid_config' }] }), 'Issue reads are unavailable'],
    ['rejected', () => host.readCatalog.mockReset().mockResolvedValue({ state: 'configured', entries: [{ id: 'demo', label: 'Demo', repo, status: 'invalid_config', problems: [{ source: 'config', code: 'config_mismatch' }] }], problems: [] }), 'config_mismatch'],
    ['unavailable', () => host.readCatalog.mockReset().mockRejectedValue(new Error('SECRET_CANARY')), 'Catalog unavailable. Reconnect the selected host'],
  ];
  for (const [state, arrange, copy] of states) {
    arrange();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<QueryClientProvider client={client}><Shell {...screenProps} params={{}} openScreen={vi.fn()} /></QueryClientProvider>); });
    await settle(); await settle();
    const visible = () => JSON.stringify(renderer.toJSON());
    const lines = () => renderer.root.findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
    // The shared loading/repair copy stays; none of these states is a fresh
    // confirmed-unconfigured catalog, so the runs instruction never appears.
    expect(visible(), state).toContain(copy);
    expect(visible(), state).not.toContain('Link a repository to see its runs.');
    expect(lines(), state).not.toContain('select a repository to browse');
    expect(visible(), state).not.toContain('SECRET_CANARY');
    expect(host.readRuns, state).not.toHaveBeenCalled();
    await act(async () => renderer.unmount()); client.clear();
  }
  // A confirmed unconfigured catalog whose next read fails is an unavailable
  // read, not a fresh unconfigured confirmation: the runs instruction is withdrawn.
  host.readCatalog.mockReset().mockResolvedValueOnce({ state: 'unconfigured', entries: [], problems: [] }).mockRejectedValue(new Error('SECRET_CANARY'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={client}><Shell {...screenProps} params={{}} openScreen={vi.fn()} /></QueryClientProvider>); });
  await settle(); await settle();
  const visible = () => JSON.stringify(renderer.toJSON());
  const lines = () => renderer.root.findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
  expect(visible()).toContain('Link a repository to see its runs.');
  await act(async () => { await vi.advanceTimersByTimeAsync(31000); }); await settle(); await settle();
  expect(visible()).toContain('Catalog read failed. Reconnect the selected host');
  expect(visible()).not.toContain('Link a repository to see its runs.');
  expect(lines()).not.toContain('select a repository to browse');
  expect(visible()).not.toContain('SECRET_CANARY');
  expect(host.readRuns).not.toHaveBeenCalled();
  await act(async () => renderer.unmount()); client.clear();
  expect(host.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it('configured_runs_keeps_a_usable_selector_and_a_valid_deployment_link', async () => {
  vi.useFakeTimers();
  host.hosts = [{ serverId: 'host-a', label: 'Host A', status: 'online' }];
  host.readCatalog.mockReset().mockResolvedValue({ state: 'configured', entries: [
    { id: 'demo', label: 'Demo', repo, status: 'available', problems: [] },
    { id: 'bad', label: 'Rejected', repo: 'Other/repo', status: 'invalid_config', problems: [{ source: 'config', code: 'config_mismatch' }] }], problems: [] });
  host.readRuns.mockClear(); host.readRun.mockClear();
  host.readRuns.mockResolvedValue(observation([]));
  host.readRun.mockResolvedValue(observation(pr('passed')));
  const openScreen = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2); }); };
  const visible = () => JSON.stringify(renderer.toJSON());
  const mount = async (params: Record<string, string>) => {
    if (renderer) await act(async () => renderer.unmount());
    client.clear();
    await act(async () => { renderer = create(<QueryClientProvider client={client}><Shell {...screenProps} params={params} openScreen={openScreen} /></QueryClientProvider>); });
    await settle(); await settle();
  };
  cleanups.push(async () => { if (renderer) { await act(async () => renderer.unmount()); client.clear(); } });
  const text = () => renderer.root.findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
  await mount({});
  // Available repositories but no selection: the selector stays usable and only
  // an available entry can be selected.
  expect(text()).toContain('Runs — select a repository to browse');
  expect(renderer.root.findAll(node => node.props.accessibilityLabel === 'Select Demo')).toHaveLength(1);
  expect(renderer.root.findAll(node => node.props.accessibilityLabel === 'Select Rejected')).toHaveLength(0);
  expect(host.readRuns).not.toHaveBeenCalled();
  await act(async () => { renderer.root.findAll(node => node.props.accessibilityLabel === 'Select Demo')[0].props.onPress(); });
  expect(openScreen).toHaveBeenCalledWith({ screenId: 'runs', params: { deploymentId: 'demo' } });
  // A valid deployment deep link still opens the runs read for that repository.
  await mount({ deploymentId: 'demo' });
  expect(text()).toContain('Observed active issue scope');
  expect(host.readRuns).toHaveBeenCalledWith({ deploymentId: 'demo' });
  expect(visible()).not.toContain('Link a repository to see its runs.');
});

it('selected_runs_names_the_shown_repository_and_switches_between_available_ones', async () => {
  vi.useFakeTimers();
  host.hosts = [{ serverId: 'host-a', label: 'Host A', status: 'online' }];
  const demo = { id: 'demo', label: 'Demo', repo, status: 'available', problems: [] };
  const other = { id: 'other', label: 'Other', repo: 'Example/other', status: 'available', problems: [] };
  const catalog = (...entries: unknown[]) => host.readCatalog.mockReset().mockResolvedValue({ state: 'configured', entries, problems: [] });
  catalog(demo, other);
  host.readRuns.mockClear(); host.readRun.mockClear();
  host.readRuns.mockResolvedValue(observation([]));
  const openScreen = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2); }); };
  const mount = async (params: Record<string, string>) => {
    if (renderer) await act(async () => renderer.unmount());
    client.clear();
    await act(async () => { renderer = create(<QueryClientProvider client={client}><Shell {...screenProps} params={params} openScreen={openScreen} /></QueryClientProvider>); });
    await settle(); await settle();
  };
  cleanups.push(async () => { if (renderer) { await act(async () => renderer.unmount()); client.clear(); } });
  const text = () => renderer.root.findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
  const selector = (label: string) => renderer.root.findAll(node => node.props.accessibilityLabel === label);
  await mount({ deploymentId: 'demo' });
  // The heading names the repository that is shown, not a prompt to select one.
  expect(text()).toContain('Runs · Demo (Example/project)');
  expect(text()).not.toContain('select a repository to browse');
  // Two available repositories keep a keyboard-reachable switch, with the shown one selected.
  expect(selector('Select Demo')).toHaveLength(1); expect(selector('Select Other')).toHaveLength(1);
  expect(selector('Select Demo')[0].props).toMatchObject({ accessibilityRole: 'button', accessibilityState: { selected: true, disabled: false, busy: false } });
  expect(selector('Select Other')[0].props).toMatchObject({ accessibilityRole: 'button', accessibilityState: { selected: false } });
  await act(async () => { selector('Select Other')[0].props.onPress(); });
  expect(openScreen).toHaveBeenCalledWith({ screenId: 'runs', params: { deploymentId: 'other' } });
  // One available repository has nothing to switch to: no list at all.
  catalog(demo);
  await mount({ deploymentId: 'demo' });
  expect(text()).toContain('Runs · Demo (Example/project)');
  expect(text()).not.toContain('select a repository to browse');
  expect(selector('Select Demo')).toHaveLength(0);
});

it('selected_issues_and_blockers_name_the_shown_repository_too', async () => {
  vi.useFakeTimers();
  host.hosts = [{ serverId: 'host-a', label: 'Host A', status: 'online' }];
  host.readCatalog.mockReset().mockResolvedValue({ state: 'configured', entries: [
    { id: 'demo', label: 'Demo', repo, status: 'available', problems: [] }], problems: [] });
  host.readBlockers.mockReset().mockResolvedValue({ state: 'unavailable', data: null, observedAt: new Date().toISOString(), lastSuccessfulAt: null, problems: [] });
  for (const route of ['issues', 'blockers'] as const) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let renderer!: ReactTestRenderer;
    const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2); }); };
    await act(async () => { renderer = create(<QueryClientProvider client={client}><Shell {...screenProps} route={route} params={{ deploymentId: 'demo' }} openScreen={vi.fn()} /></QueryClientProvider>); });
    await settle(); await settle();
    const text = () => renderer.root.findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
    const heading = route === 'issues' ? 'Issues' : 'Blockers';
    expect(text(), route).toContain(`${heading} · Demo (Example/project)`);
    expect(text(), route).not.toContain('select a repository to browse');
    expect(renderer.root.findAll(node => node.props.accessibilityLabel === 'Select Demo'), route).toHaveLength(0);
    await act(async () => renderer.unmount()); client.clear();
  }
});

it('projects complete tool-result activity, including incremental reads, without exposing output', async () => {
  const f = await membershipFixture();
  const input = { deploymentId: 'demo', issue: 42, runId: '22222222' };
  await f.reader.read(input);
  const path = join(f.tree(), '.pi-session/one.jsonl');
  const completedAt = '2026-10-15T06:19:00Z';
  const result = { type: 'message', timestamp: completedAt, message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'TOOL_OUTPUT_SECRET_CANARY' }], isError: true } };
  await writeFile(path, await readFile(path, 'utf8') + JSON.stringify(result) + '\n');
  const detail = await f.reader.read(input);
  expect(detail.data?.summary.sessions[0]).toMatchObject({ sessionId: 'session-42', at: completedAt, kind: 'command', state: 'available' });
  expect(JSON.stringify(detail)).not.toContain('TOOL_OUTPUT_SECRET_CANARY');
});

it('omits journal timestamps outside the RPC timestamp range instead of breaking detail serialization', () => {
  const line = JSON.stringify({ ...records.journal, __REALTIME_TIMESTAMP: '999999999999999999' });
  const projected = projectEvents(line, { repo, issue: 42, runId: '22222222', unit: 'orbi-demo@1.service', retained: false });
  expect(projected.events).toEqual([]);
  expect(projected.problems).toContainEqual({ source: 'journal', code: 'invalid_response' });
});
