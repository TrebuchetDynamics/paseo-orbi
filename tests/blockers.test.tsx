import { describe, expect, it } from 'vitest';
import { failureGuidance, waitGuidance, attention, attentionText, BlockerDetails, BlockerPage, blockersList, blockersRead, artifactNames, type Blocker } from '../shared/blockers';
import guidance from './fixtures/blockers/guidance.json';
import { Failure } from '../shared/issues';
import { selectReports } from '../server/reports';
import { formatLocalTime } from '../client/time';

describe('Blockers', () => {
  it('failure_guidance_without_actions', () => {
    const expected = guidance;
    const reasons = Failure.shape.reason_code.options;
    const actions = Failure.shape.action_code.options;
    for (const reason_code of reasons) for (const action_code of actions) {
      const failure = Failure.parse({ schema: 1, outcome: 'blocked', reason_code, action_code, retry_safe: true });
      const guidance = failureGuidance({ status: 'available', data: failure, attribution: { repo: 'Example/project', issue: 4, commentId: 1, updatedAt: '2026-01-01T00:00:00Z' } });
      expect(guidance).toContain('Reported');
      expect(guidance).toContain(expected.reasons[reason_code]);
      expect(guidance).toContain(expected.actions[action_code]);
      expect(guidance).toContain('never permission');
      expect(guidance).not.toContain('CANARY');
    }
    for (const status of ['missing', 'invalid', 'unsupported'] as const) expect(failureGuidance({ status, attribution: null })).toContain(status);
    for (const state of ['waiting', 'resuming', 'merged', 'stale'] as const) expect(waitGuidance(state)).toContain(state);
    expect(waitGuidance('resuming')).toContain('not delivery success');
    const report = selectReports('Example/project', 4, [{ id: 1, user: { login: 'runner' }, updated_at: '2026-01-01T00:00:00Z', body: '<!-- orbi:run=12345678 -->\n<!-- orbi:comment=failure -->\n<!-- orbi:failure:v1 {"schema":1,"reason_code":"CANARY"} -->\nRAW_DIAGNOSTIC_CANARY' }], ['runner'], true);
    expect(report.failure.status).toBe('invalid');
    expect(failureGuidance(report.failure)).not.toContain('CANARY');
  });
});

import { afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));
import { join } from 'node:path';
import { fixture, type FixtureProfile } from './helpers/fixtures';
import { ConfigRepository } from '../server/config';
import { ReadPorts } from '../server/read-ports';
import { GitHubReader } from '../server/github';
import { BlockersReader } from '../server/blockers';
import { classifyIssue, type IssueSummary } from '../shared/issues';
import contribute from '../index.server';
import type { PluginServerContext } from '@getpaseo/plugin/server';
const cleanups: (() => unknown)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const repo = 'Example/project', run = '12345678', stamp = '2026-11-01T00:00:00Z';
const issue = (number = 4, labels = ['ai-blocked']): IssueSummary => ({ number, title: 'Synthetic blocker', githubState: 'open', updatedAt: stamp, labels, url: `https://github.com/${repo}/issues/${number}`, ...classifyIssue('open', labels) });
const raw = (number = 4, labels = ['ai-blocked']) => ({ number, title: 'Synthetic blocker', state: 'open', updated_at: stamp, labels: labels.map(name => ({ name })), body: 'TOKEN_PROMPT_CANARY' });
const block = (name: string, data: unknown, version = 1) => `<!-- orbi:${name}:v${version} ${JSON.stringify(data)} -->`;
const comments = (scene: unknown = guidance.scene) => [{ id: 1, user: { login: 'publisher-canary' }, updated_at: stamp, body: `<!-- orbi:run=${run} -->\n<!-- orbi:comment=failure -->\n${block('failure', guidance.failure)}\n${block('scene', scene)}\n${block('base-ci-red', guidance.base)}\n\nRAW_DIAGNOSTIC_CANARY` }];
const reports = (scene: unknown = guidance.scene) => selectReports(repo, 4, comments(scene), ['publisher-canary'], true);
const response = (data: unknown, status = 200) => `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}`;
async function setup(profile: FixtureProfile = 'release') {
  const f = await fixture(profile); cleanups.push(f.cleanup);
  const repository = await ConfigRepository.load(f.authorization);
  const ports = new ReadPorts(repository); cleanups.push(() => ports.dispose());
  let now = Date.parse(stamp), denied = false, scene: unknown = guidance.scene;
  vi.spyOn(ports, 'clock').mockImplementation(() => new Date(now));
  const process = vi.spyOn(ports, 'process').mockImplementation(async (_id, op) => {
    if (op.kind !== 'gh-api-get') throw new Error('mutation');
    if (denied) return response({}, 401);
    if (op.resource === 'issues') return response([raw()]);
    if (op.resource === 'issue') return response(raw(op.issue));
    if (op.resource === 'comments') return response(comments(scene));
    if (op.resource === 'pull') return response({ number: 42, html_url: `https://github.com/${repo}/pull/42`, state: 'open', merged_at: null, head: { sha: 'a'.repeat(40) }, base: { repo: { full_name: repo } } });
    if (op.resource === 'checks') return response({ check_runs: [] });
    return response([]);
  });
  const github = new GitHubReader(repository, ports), reader = new BlockersReader(repository, github, ports);
  return { ...f, ports, process, github, reader, repository, advance: () => { now += 60001; }, deny: (value: boolean) => { denied = value; }, scene: (value: unknown) => { scene = value; } };
}

it('retention_and_artifact_metadata', async () => {
  for (const profile of ['release', 'installed', 'v0748'] as const) {
    const f = await setup(profile);
    const scene = join(f.repoDir, '.worktrees', `orbi-Example-project-issue-4-${run}`);
    const directory = join(scene, '.orbi');
    await fs.mkdir(directory, { recursive: true });
    for (const name of artifactNames.slice(1)) await fs.writeFile(join(scene, name), 'ARTIFACT_CONTENT_CANARY');
    // All raw data setup precedes the read-only evidence boundary.
    const open = vi.spyOn(fs, 'open'), read = vi.spyOn(fs, 'readFile'), write = vi.spyOn(fs, 'writeFile');
    const stats = vi.spyOn(fs, 'lstat');
    const good = blockersRead.output.parse(await f.reader.read({ deploymentId: 'demo', issue: 4 }));
    expect(good.data?.artifacts.map(a => a.status)).toEqual(Array(5).fill('present'));
    expect(good.data?.artifacts[1]).toMatchObject({ size: 23, modifiedAt: expect.any(String) });
    expect(good.data?.retention).toEqual({ profile: f.entry.adapter, worktreeRetainHours: 72, keepFailedWorktrees: profile === 'release' ? null : true });
    expect(stats.mock.calls.every(([path]) => String(path).startsWith(join(f.repoDir, '.worktrees')))).toBe(true);
    expect(open).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect(JSON.stringify(good)).not.toMatch(/CANARY|\/tmp\/|repoDir|external|failing_checks/);
    stats.mockRestore(); open.mockRestore(); read.mockRestore(); write.mockRestore();
    await fs.rm(scene, { recursive: true });
    const missing = await f.reader.read({ deploymentId: 'demo', issue: 4 });
    expect(missing.data?.issue.number).toBe(4); expect(missing.data?.reports.failure.status).toBe('available');
    expect(missing.data?.artifacts.every(a => a.status === 'missing')).toBe(true);
    await fs.symlink(f.deployHome, scene);
    const escaping = await f.reader.read({ deploymentId: 'demo', issue: 4 });
    expect(escaping.data?.artifacts.every(a => a.status === 'invalid')).toBe(true);
    await fs.unlink(scene); await fs.mkdir(directory, { recursive: true });
    await fs.symlink(f.configPath, join(directory, 'test.log'));
    expect((await f.reader.read({ deploymentId: 'demo', issue: 4 })).data?.artifacts.find(a => a.name === '.orbi/test.log')?.status).toBe('invalid');
    const original = fs.lstat;
    const denied = vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]).includes('/.worktrees/')) throw Object.assign(new Error('SECRET'), { code: 'EACCES' });
      return original(...args);
    }) as typeof fs.lstat);
    expect((await f.reader.read({ deploymentId: 'demo', issue: 4 })).data?.artifacts.every(a => a.status === 'unreadable')).toBe(true);
    denied.mockRestore();
    for (const invalidScene of [{ ...guidance.scene, run_id: '87654321' }, { ...guidance.scene, pr_url: 'https://github.com/Other/repo/pull/42' }, { ...guidance.scene, path: '/escape' }]) {
      f.advance(); f.scene(invalidScene);
      const stat = vi.spyOn(f.ports, 'statArtifact');
      const mismatch = await f.reader.read({ deploymentId: 'demo', issue: 4 });
      expect(mismatch.data?.reports.scene.status).toBe('invalid');
      expect(mismatch.data?.artifacts.every(a => a.status === 'unattributed')).toBe(true);
      expect(stat).not.toHaveBeenCalled(); stat.mockRestore();
    }
    expect(f.process.mock.calls.every(([, op]) => op.kind === 'gh-api-get')).toBe(true);
    await expect(f.ports.statArtifact('demo', 0, run, 'worktree')).rejects.toThrow('unsafe_path');
    await expect(f.ports.statArtifact('demo', 4, '../escape', 'worktree')).rejects.toThrow('unsafe_path');
    await expect(f.ports.statArtifact('demo', 4, run, '../env' as any)).rejects.toThrow('unsafe_path');
  }
});

it('validates_only_profile_supported_retention_values', async () => {
  for (const profile of ['release', 'installed', 'v0748'] as const) {
    const f = await fixture(profile); cleanups.push(f.cleanup);
    for (const value of ['true', '0', '-1', '"72"', 'nan', 'inf']) {
      await fs.writeFile(f.configPath, f.toml + `worktree_retain_hours = ${value}\n`);
      expect((await ConfigRepository.load(f.authorization)).catalog().entries[0].status).toBe('invalid_config');
    }
    for (const value of ['"true"', '1', '[]']) {
      await fs.writeFile(f.configPath, f.toml + `keep_failed_worktrees = ${value}\n`);
      const config = await ConfigRepository.load(f.authorization);
      expect(config.catalog().entries[0].status).toBe(profile === 'release' ? 'available' : 'invalid_config');
      if (profile === 'release') expect(config.resolve('demo').keepFailedWorktrees).toBeNull();
    }
    await fs.writeFile(f.configPath, f.toml + 'worktree_retain_hours = 12.5\nkeep_failed_worktrees = false\n');
    expect((await ConfigRepository.load(f.authorization)).resolve('demo')).toMatchObject({ worktreeRetainHours: 12.5, keepFailedWorktrees: profile === 'release' ? null : false });
  }
});

it('distinguishes_waits_and_base_states_and_rejects_unknown_formal_metadata', () => {
  for (const [labels, classification, text] of [
    [['ai-blocked'], 'manual_attention', 'operator must assess'], [['ai-needs-detail'], 'manual_attention', 'operator must assess'],
    [['ai-fix-needed'], 'automatic_fix_pending', 'not a terminal failure'], [['ai-awaiting-merge'], 'maintainer_merge_wait', 'maintainer decides'],
  ] as const) {
    expect(attention(issue(4, [...labels]))).toBe(classification);
    expect(attentionText[classification]).toContain(text);
  }
  expect(attention({ githubState: 'closed', labels: ['ai-blocked'], state: 'Closed' })).toBe('github_terminal');
  expect(attention(issue(4, ['ai-human-review']))).toBe('not_candidate');
  for (const status of ['waiting', 'resuming', 'merged', 'stale'] as const) {
    const data = selectReports(repo, 4, [{ ...comments()[0], body: comments()[0].body.replace('"state":"resuming"', `"state":"${status}"`) }], ['publisher-canary'], true);
    expect(data.baseCi).toMatchObject({ status: 'available', data: { state: status } });
  }
  for (const data of [{ ...guidance.failure, reason_code: 'new_reason' }, { ...guidance.failure, action_code: 'execute' }, { ...guidance.failure, retry_safe: 'true' }, { ...guidance.failure, schema: 2 }]) {
    const parsed = selectReports(repo, 4, [{ ...comments()[0], body: `<!-- orbi:run=${run} -->\n<!-- orbi:comment=failure -->\n${block('failure', data)}\nRAW_DIAGNOSTIC_CANARY` }], ['publisher-canary'], true);
    expect(parsed.failure.status).toBe('invalid'); expect(failureGuidance(parsed.failure)).toContain('unknown');
  }
  const unsupported = selectReports(repo, 4, [{ ...comments()[0], body: `<!-- orbi:run=${run} -->\n<!-- orbi:comment=failure -->\n${block('failure', guidance.failure, 2)}` }], ['publisher-canary'], true);
  expect(unsupported.failure.status).toBe('unsupported');
});

it('registered_rpc_journey_handles_partial_stale_and_empty_complete_scope', async () => {
  const f = await setup();
  vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
  const handlers = new Map<unknown, (input: any) => Promise<any>>();
  cleanups.push(contribute({ handle: (contract: unknown, handler: (input: any) => Promise<any>) => handlers.set(contract, handler) } as unknown as PluginServerContext));
  vi.spyOn(ReadPorts.prototype, 'process').mockImplementation(f.process.getMockImplementation()!);
  const page = blockersList.output.parse(await handlers.get(blockersList)!({ deploymentId: 'demo', page: 1 }));
  expect(page).toMatchObject({ state: 'available', data: { complete: true, records: [{ reports: { selectedRunId: run }, attention: 'manual_attention' }] } });
  const detail = blockersRead.output.parse(await handlers.get(blockersRead)!({ deploymentId: 'demo', issue: 4 }));
  expect(detail.data?.artifacts.every(a => a.status === 'missing')).toBe(true);
  for (const page of [0, -1, 1.5, NaN, Infinity]) {
    expect(() => blockersList.input.parse({ deploymentId: 'demo', page })).toThrow();
    await expect(f.reader.list({ deploymentId: 'demo', page })).rejects.toThrow('unsafe_path');
  }
  expect(() => blockersRead.input.parse({ deploymentId: 'demo', issue: 4, path: '/escape' })).toThrow();
  await expect(f.reader.list({ deploymentId: 'rejected', page: 1 })).rejects.toThrow('deployment_unavailable');
  const good = await f.reader.list({ deploymentId: 'demo', page: 1 });
  f.advance(); f.deny(true);
  expect(await f.reader.list({ deploymentId: 'demo', page: 1 })).toMatchObject({ state: 'stale', lastSuccessfulAt: good.lastSuccessfulAt, data: { complete: false, records: [{ issue: { number: 4 }, reports: { complete: false } }] } });
  const initial = await setup(); initial.deny(true);
  expect(await initial.reader.list({ deploymentId: 'demo', page: 1 })).toMatchObject({ state: 'unavailable', data: null, problems: [{ code: 'auth_denied' }] });
  initial.advance(); initial.deny(false); initial.process.mockResolvedValue(response([]));
  expect(await initial.reader.list({ deploymentId: 'demo', page: 1 })).toMatchObject({ state: 'available', data: { complete: true, records: [] } });
  const partial = await setup();
  partial.process.mockImplementation(async (_id, op) => response(op.kind === 'gh-api-get' && op.resource === 'issues' ? [raw()] : {}, op.kind === 'gh-api-get' && op.resource === 'issues' ? 200 : 401));
  expect(await partial.reader.list({ deploymentId: 'demo', page: 1 })).toMatchObject({ state: 'partial', data: { complete: true, records: [{ reports: { complete: false, selectedRunId: null } }] }, problems: [{ code: 'auth_denied' }] });
  expect(JSON.stringify([page, detail, good])).not.toMatch(/CANARY|\/tmp\/|prompt|token/);
});

it('verified_pr_merge_makes_retained_failure_historical_even_with_open_issue_labels', async () => {
  const f = await setup();
  const process = f.process.getMockImplementation()!;
  f.process.mockImplementation(async (id, op, ...args) => op.kind === 'gh-api-get' && op.resource === 'pull'
    ? response({ number: 42, html_url: `https://github.com/${repo}/pull/42`, state: 'closed', merged_at: stamp, head: { sha: 'a'.repeat(40) }, base: { repo: { full_name: repo } } })
    : process(id, op, ...args));
  const result = blockersRead.output.parse(await f.reader.read({ deploymentId: 'demo', issue: 4 }));
  expect(result).toMatchObject({ state: 'available', data: {
    issue: { githubState: 'open', labels: ['ai-blocked'], state: 'Merged', provenance: 'verified' },
    attention: 'github_terminal', reports: { failure: { status: 'available' } },
  } });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<BlockerEvidence data={result.data!} theme={theme} deploymentId="demo" openScreen={vi.fn()} />); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); });
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain('historical');
  expect(text).toContain('PR merged_at');
  expect(text).not.toContain('Manual attention reported');
});

import './helpers/host';
import { host } from './helpers/host';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Shell } from '../client/shell';
import { BlockerEvidence } from '../client/blockers';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const theme = { colors: { foreground: '#eee', foregroundMuted: '#aaa', surface0: '#111' } } as any;
const props = { theme, host: { id: 'host-a', label: 'Host A' }, layout: { compact: true, platform: 'web' }, params: { deploymentId: 'demo' }, route: 'blockers', openScreen: vi.fn() } as unknown as React.ComponentProps<typeof Shell>;
function safeBlocker(number = 4): Blocker {
  const r = reports();
  return { issue: issue(number), attention: 'manual_attention', reports: { selectedRunId: run, attribution: r.attribution, complete: true, failure: r.failure, scene: r.scene, baseCi: r.baseCi.status === 'available' ? { ...r.baseCi, data: { state: r.baseCi.data.state, pr: r.baseCi.data.pr } } : r.baseCi } };
}
const available = <T,>(data: T) => ({ state: 'available' as const, data, observedAt: stamp, lastSuccessfulAt: stamp, problems: [] });
const realSetTimeout = globalThis.setTimeout;
async function renderScreen(initial = props) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  const mount = (p: typeof props) => <QueryClientProvider client={client}><Shell {...p} /></QueryClientProvider>;
  await act(async () => { renderer = create(mount(initial)); });
  const settle = async () => { await act(async () => { await new Promise(resolve => realSetTimeout(resolve, 10)); await vi.advanceTimersByTimeAsync(2); }); };
  await settle(); await settle();
  cleanups.push(async () => { await act(async () => renderer.unmount()); client.clear(); });
  return { renderer, client, settle, update: async (p: typeof props) => { await act(async () => renderer.update(mount(p))); await settle(); await settle(); } };
}
function catalog() {
  host.readCatalog.mockResolvedValue({ state: 'configured', problems: [], entries: [
    { id: 'demo', label: 'Demo', repo, adapter: 'orbi-0.7.41-release', status: 'available', problems: [] },
    { id: 'other', label: 'Other', repo: 'Example/other', adapter: 'orbi-0.7.41-release', status: 'available', problems: [] },
    { id: 'rejected', label: 'Rejected', repo: 'Other/rejected', adapter: 'unsupported', status: 'invalid_config', problems: [{ source: 'config', code: 'config_mismatch' }] },
  ] });
}
it('renders_each_formal_guidance_with_provenance_and_no_recovery_controls', async () => {
  const openScreen = vi.fn();
  let renderer!: ReactTestRenderer;
  const evidence = (data: Blocker) => <BlockerEvidence data={data} theme={theme} deploymentId="demo" openScreen={openScreen} />;
  await act(async () => { renderer = create(evidence(safeBlocker())); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); });
  for (const reason_code of Failure.shape.reason_code.options) for (const action_code of Failure.shape.action_code.options) {
    const data = safeBlocker();
    if (data.reports.failure.status === 'available') data.reports.failure.data = { schema: 1, outcome: 'fix_needed', reason_code, action_code, retry_safe: false };
    await act(async () => renderer.update(evidence(data)));
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain(guidance.reasons[reason_code]); expect(text).toContain(guidance.actions[action_code]);
    expect(text).toContain('never permission'); expect(text).toContain('issuecomment-1'); expect(text).toContain(formatLocalTime(stamp));
    // The only control is the reported-run navigation; nothing recovers or retries.
    expect(renderer.root.findAll(node => node.props.accessibilityRole === 'button').map(node => node.props.accessibilityLabel)).toEqual([`Inspect run ${run} in Runs`]);
  }
  for (const state of ['waiting', 'resuming', 'merged', 'stale'] as const) {
    const data = safeBlocker(); if (data.reports.baseCi.status === 'available') data.reports.baseCi.data.state = state;
    await act(async () => renderer.update(evidence(data)));
    expect(JSON.stringify(renderer.toJSON())).toContain(waitGuidance(state));
  }
  for (const status of ['missing', 'invalid', 'unsupported'] as const) {
    const data = safeBlocker(); data.reports.failure = { status, attribution: null };
    await act(async () => renderer.update(evidence(data)));
    expect(JSON.stringify(renderer.toJSON())).toContain(`metadata ${status}`);
    expect(JSON.stringify(renderer.toJSON())).toContain('No prose fallback');
  }
  expect(openScreen).not.toHaveBeenCalled();
});

it('shows_github_repair_steps_only_for_a_reported_problem', async () => {
  vi.useFakeTimers(); vi.setSystemTime(stamp); catalog();
  host.readBlockers.mockResolvedValue(available({ repo, page: 1, hasNextPage: false, complete: true, records: [safeBlocker()] }));
  const screen = await renderScreen();
  const text = () => JSON.stringify(screen.renderer.toJSON());
  const repair = {
    auth_denied: "Ask the operator to repair the daemon user's existing gh authentication or permissions, then Refresh.",
    rate_limited: "Wait for GitHub's retry/reset time, then Refresh.",
    network_failed: 'Repair access externally, then Refresh. Missing evidence never means none exist.',
    incomplete: 'Repair access externally, then Refresh. Missing evidence never means none exist.',
  } as const;
  // A complete read keeps the recovery-ownership line and the pinned schema link, without repair copy.
  expect(text()).toContain('Recovery stays Orbi/operator-owned.');
  expect(text()).toContain('Failure schema source (pinned v1)');
  for (const sentence of Object.values(repair)) expect(text()).not.toContain(sentence);
  for (const code of ['auth_denied', 'rate_limited', 'network_failed', 'incomplete'] as const) {
    host.readBlockers.mockResolvedValue({ ...available({ repo, page: 1, hasNextPage: false, complete: true, records: [safeBlocker()] }), state: 'partial', problems: [{ source: 'github', code }] });
    await act(async () => screen.renderer.root.findByProps({ testID: 'orbi-blockers' }).findAllByProps({ accessibilityLabel: 'Refresh' })[0].props.onPress());
    await screen.settle(); await screen.settle();
    const expected = repair[code];
    expect(text(), code).toContain(`github: ${code}`);
    expect(text().split(expected), code).toHaveLength(2);
    for (const [other, sentence] of Object.entries(repair)) if (sentence !== expected) expect(text(), `${code} / ${other}`).not.toContain(sentence);
    expect(text(), code).toContain('Recovery stays Orbi/operator-owned.');
  }
});

it('partial_stale_and_layout', async () => {
  const f = await setup();
  vi.useFakeTimers(); vi.setSystemTime(stamp); catalog();
  host.readBlockers.mockImplementation(input => f.reader.list(input));
  host.readBlocker.mockImplementation(input => f.reader.read(input));
  const screen = await renderScreen();
  const { renderer, settle } = screen;
  expect(JSON.stringify(renderer.toJSON())).toContain('config_mismatch');
  expect(renderer.root.findAll(node => node.props.accessibilityLabel === 'Select Rejected')).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain('Base CI resuming');
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Inspect blocker 4' }).props.onPress());
  // The detail read is real filesystem work; wait for it to leave Loading instead of
  // assuming a fixed number of timer ticks (a tight budget made this test flaky).
  for (let tick = 0; tick < 10 && JSON.stringify(renderer.toJSON()).includes('"Loading"'); tick++) await settle();
  expect(JSON.stringify(renderer.toJSON())).toContain('Artifact metadata only');
  expect(JSON.stringify(renderer.toJSON())).toContain('missing');
  expect(JSON.stringify(renderer.toJSON())).not.toMatch(/CANARY|\/tmp\//);
  const allowed = /^(Refresh|Inspect blocker \d+|Inspect issue by number|Issue number to inspect|Inspect run [0-9a-f]{8} in Runs|Previous blockers page|Next blockers page|Select .+|View services|Setup guide|Details for .+|Open (Work|Services|Runs))$/;
  for (const control of renderer.root.findAll(node => node.type === ('Pressable' as any) || node.type === ('TextInput' as any))) expect(control.props.accessibilityLabel).toMatch(allowed);
  for (const compact of [true, false]) for (const foreground of ['#eee', '#111']) {
    await screen.update({ ...props, layout: { ...props.layout, compact }, theme: { colors: { ...theme.colors, foreground } } as any });
    for (const text of renderer.root.findAllByType('Text' as any)) expect(text.props.style.color).toBe(foreground);
    expect(renderer.root.findByType('ScrollView' as any).props.contentContainerStyle.padding).toBe(compact ? 16 : 24);
  }
  f.advance(); f.deny(true);
  await act(async () => renderer.root.findByProps({ testID: 'orbi-blockers' }).findAllByProps({ accessibilityLabel: 'Refresh' })[0].props.onPress()); await settle(); await settle();
  let visible = JSON.stringify(renderer.toJSON());
  expect(visible).toContain('Stale'); expect(visible).toContain('auth_denied'); expect(visible).toContain(formatLocalTime(stamp));
  // #134: retained evidence shows local times, not raw ISO stamps.
  expect(visible).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  expect(visible).toContain('Synthetic blocker'); expect(visible).not.toContain('No blockers in');
  expect(visible).toContain("daemon user's existing gh authentication");
  f.advance(); f.deny(false);
  await act(async () => renderer.root.findByProps({ testID: 'orbi-blockers' }).findAllByProps({ accessibilityLabel: 'Refresh' })[0].props.onPress()); await settle(); await settle();
  expect(JSON.stringify(renderer.toJSON())).not.toContain('github: auth_denied');
  host.readBlockers.mockResolvedValue({ ...available({ repo, page: 1, hasNextPage: false, complete: true, records: [{ ...safeBlocker(), reports: { ...safeBlocker().reports, complete: false } }] }), state: 'partial', lastSuccessfulAt: null, problems: [{ source: 'github', code: 'incomplete' }] });
  await act(async () => renderer.root.findByProps({ testID: 'orbi-blockers' }).findAllByProps({ accessibilityLabel: 'Refresh' })[0].props.onPress()); await settle(); await settle();
  expect(JSON.stringify(renderer.toJSON())).toContain('Partial');
  expect(JSON.stringify(renderer.toJSON())).toContain('current run not established');
  // A complete empty scope is distinguishable from an initial failure on another selection.
  host.readBlockers.mockResolvedValue({ state: 'unavailable', data: null, observedAt: stamp, lastSuccessfulAt: null, problems: [{ source: 'github', code: 'auth_denied' }] });
  await screen.update({ ...props, params: { deploymentId: 'other' } });
  visible = JSON.stringify(renderer.toJSON()); expect(visible).toContain('Unavailable'); expect(visible).not.toContain('No blockers in');
  host.readBlockers.mockResolvedValue(available({ repo: 'Example/other', page: 1, hasNextPage: false, complete: true, records: [] }));
  await act(async () => renderer.root.findByProps({ testID: 'orbi-blockers' }).findAllByProps({ accessibilityLabel: 'Refresh' })[0].props.onPress()); await settle(); await settle();
  expect(JSON.stringify(renderer.toJSON())).toContain('No blockers in the complete observed scope');
});

it('ignores_late_issue_deployment_and_host_callbacks', async () => {
  vi.useFakeTimers(); vi.setSystemTime(stamp); catalog();
  host.readBlockers.mockResolvedValue(available({ repo, page: 1, hasNextPage: true, complete: true, records: [safeBlocker(4), safeBlocker(5)] }));
  let finish!: (value: unknown) => void;
  host.readBlocker.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(available({ ...safeBlocker(5), reports: { ...safeBlocker(5).reports, selectedRunId: '22222222' }, artifacts: [], retention: { profile: 'orbi-0.7.41-release', worktreeRetainHours: 72, keepFailedWorktrees: null } }));
  const screen = await renderScreen();
  await act(async () => screen.renderer.root.findByProps({ accessibilityLabel: 'Inspect blocker 4' }).props.onPress()); await screen.settle();
  await act(async () => screen.renderer.root.findByProps({ accessibilityLabel: 'Inspect blocker 5' }).props.onPress()); await screen.settle(); await screen.settle();
  await act(async () => finish(available({ ...safeBlocker(4), reports: { ...safeBlocker(4).reports, selectedRunId: 'deadbeef' } }))); await screen.settle();
  expect(JSON.stringify(screen.renderer.toJSON())).toContain('22222222'); expect(JSON.stringify(screen.renderer.toJSON())).not.toContain('deadbeef');
  let late!: (value: unknown) => void;
  host.readBlockers.mockImplementationOnce(() => new Promise(resolve => { late = resolve; })).mockResolvedValue(available({ repo, page: 1, hasNextPage: false, complete: true, records: [] }));
  await act(async () => screen.renderer.root.findByProps({ accessibilityLabel: 'Next blockers page' }).props.onPress()); await screen.settle();
  await screen.update({ ...props, params: { deploymentId: 'other' } });
  await act(async () => late(available({ repo: 'LATE_CALLBACK_CANARY', page: 2, hasNextPage: false, complete: true, records: [] }))); await screen.settle();
  expect(JSON.stringify(screen.renderer.toJSON())).not.toContain('LATE_CALLBACK_CANARY');
  let lateHost!: (value: unknown) => void;
  host.readBlockers.mockImplementationOnce(() => new Promise(resolve => { lateHost = resolve; }));
  await screen.update({ ...props, params: { deploymentId: 'demo' } });
  await act(async () => { screen.renderer.root.findByProps({ testID: 'orbi-blockers' }).findAllByProps({ accessibilityLabel: 'Refresh' })[0].props.onPress(); }); await screen.settle();
  host.hosts.push({ serverId: 'host-b', label: 'Host B', status: 'online' });
  cleanups.push(() => host.hosts.pop());
  host.readBlockers.mockResolvedValue(available({ repo: 'Host B evidence', page: 1, hasNextPage: false, complete: true, records: [] }));
  await screen.update({ ...props, host: { ...props.host, id: 'host-b' } });
  await act(async () => lateHost(available({ repo: 'LATE_HOST_CANARY', page: 1, hasNextPage: false, complete: true, records: [] }))); await screen.settle();
  expect(JSON.stringify(screen.renderer.toJSON())).toContain('Host B evidence'); expect(JSON.stringify(screen.renderer.toJSON())).not.toContain('LATE_HOST_CANARY');
});

it('paginates_only_candidate_states_without_scanning_unrelated_comments', async () => {
  const f = await setup();
  f.process.mockImplementation(async (_id, op) => {
    if (op.kind !== 'gh-api-get') throw new Error('mutation');
    if (op.resource === 'issues') return response([
      ...Array.from({ length: 21 }, (_, i) => raw(i + 1, [['ai-blocked'], ['ai-needs-detail'], ['ai-fix-needed'], ['ai-awaiting-merge']][i % 4])),
      raw(80, ['ai-human-review']), raw(81, ['ai-ready']), raw(82, ['ai-pr-opened']),
    ]);
    return response(comments());
  });
  const first = BlockerPage.parse((await f.reader.list({ deploymentId: 'demo', page: 1 })).data);
  expect(first.records).toHaveLength(20); expect(first.hasNextPage).toBe(true);
  expect(first.records.slice(0, 4).map(r => r.attention)).toEqual(['manual_attention', 'manual_attention', 'automatic_fix_pending', 'maintainer_merge_wait']);
  const second = BlockerPage.parse((await f.reader.list({ deploymentId: 'demo', page: 2 })).data);
  expect(second.records.map(r => r.issue.number)).toEqual([21]); expect(second.hasNextPage).toBe(false);
  expect(f.process.mock.calls.filter(([, op]) => op.kind === 'gh-api-get' && op.resource === 'comments').map(([, op]) => 'issue' in op ? op.issue : 0)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
});

it('looks_up_a_non_candidate_issue_without_page_membership_or_has_next_change', async () => {
  vi.useFakeTimers(); vi.setSystemTime(stamp); catalog();
  host.readBlockers.mockReset().mockResolvedValue(available({ repo, page: 1, hasNextPage: false, complete: true, records: [safeBlocker(4)] }));
  host.readBlocker.mockReset();
  const nonCandidate = (number: number, title: string) => blockersRead.output.parse(available(BlockerDetails.parse({
    issue: { ...issue(number, []), title },
    attention: 'not_candidate',
    reports: { selectedRunId: null, attribution: null, complete: false, failure: { status: 'missing', attribution: null },
      scene: { status: 'missing', attribution: null }, baseCi: { status: 'missing', attribution: null } },
    artifacts: artifactNames.map(name => ({ name, status: 'unattributed', size: null, modifiedAt: null })),
    retention: { profile: 'orbi-0.7.41-release', worktreeRetainHours: 72, keepFailedWorktrees: null },
  })));
  host.readBlocker.mockImplementation(async input => input.issue === 998 ? Promise.reject(new Error('NETWORK_SECRET')) : nonCandidate(input.issue, `LOOKED_UP_${input.issue}_TITLE`));
  const screen = await renderScreen();
  const { renderer, settle } = screen;
  const input = () => renderer.root.findByProps({ accessibilityLabel: 'Issue number to inspect' });
  const inspect = () => renderer.root.findByProps({ accessibilityLabel: 'Inspect issue by number' });
  const setInput = async (value: string) => { await act(async () => input().props.onChangeText(value)); await settle(); };
  const press = async () => { await act(async () => inspect().props.onPress()); await settle(); await settle(); };
  const text = () => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
  const candidateRows = () => renderer.root.findAll(node => typeof node.props.accessibilityLabel === 'string' && /^Inspect blocker \d+$/.test(node.props.accessibilityLabel)).map(node => node.props.accessibilityLabel);
  expect(text()).toContain('Blockers page 1; scope complete');
  expect(candidateRows()).toEqual(['Inspect blocker 4']);
  expect(renderer.root.findByProps({ accessibilityLabel: 'Next blockers page' }).props.disabled).toBe(true);
  for (const value of ['', '0', '007', '-1', '4.5', 'abc', String(Number.MAX_SAFE_INTEGER + 1)]) {
    await setInput(value);
    expect(inspect().props.disabled).toBe(true);
    await press();
    expect(host.readBlocker).not.toHaveBeenCalled();
  }
  await setInput('999');
  expect(inspect().props.disabled).toBe(false);
  await press();
  expect(host.readBlocker).toHaveBeenLastCalledWith({ deploymentId: 'demo', issue: 999 });
  expect(text()).toContain('Issue #999 — looked-up evidence; not blocker-scope membership or a page candidate claim.');
  expect(text()).toContain(attentionText.not_candidate);
  expect(text()).toContain('LOOKED_UP_999_TITLE');
  expect(text()).toContain('worktree: unattributed');
  // A failed lookup keeps the unavailable observation, never the previous issue's evidence.
  await setInput('998');
  await press();
  expect(host.readBlocker).toHaveBeenLastCalledWith({ deploymentId: 'demo', issue: 998 });
  expect(text()).toContain('refresh_failed');
  expect(text()).not.toContain('LOOKED_UP_999_TITLE');
  expect(text()).not.toContain('NETWORK_SECRET');
  // The candidate page and its scope statement are untouched by a lookup.
  expect(text()).toContain('Blockers page 1; scope complete');
  expect(candidateRows()).toEqual(['Inspect blocker 4']);
  expect(renderer.root.findByProps({ accessibilityLabel: 'Next blockers page' }).props.disabled).toBe(true);
});

it('ignores a late blocker lookup for a previous issue number', async () => {
  vi.useFakeTimers(); vi.setSystemTime(stamp); catalog();
  host.readBlockers.mockReset().mockResolvedValue(available({ repo, page: 1, hasNextPage: false, complete: true, records: [safeBlocker(4)] }));
  host.readBlocker.mockReset();
  const nonCandidate = (number: number, title: string) => blockersRead.output.parse(available(BlockerDetails.parse({
    issue: { ...issue(number, []), title },
    attention: 'not_candidate',
    reports: { selectedRunId: null, attribution: null, complete: false, failure: { status: 'missing', attribution: null },
      scene: { status: 'missing', attribution: null }, baseCi: { status: 'missing', attribution: null } },
    artifacts: artifactNames.map(name => ({ name, status: 'unattributed', size: null, modifiedAt: null })),
    retention: { profile: 'orbi-0.7.41-release', worktreeRetainHours: 72, keepFailedWorktrees: null },
  })));
  let finishSeven!: (value: unknown) => void;
  host.readBlocker.mockImplementationOnce(() => new Promise(resolve => { finishSeven = resolve; })).mockResolvedValueOnce(nonCandidate(8, 'LOOKED_UP_EIGHT_TITLE'));
  const screen = await renderScreen();
  const { renderer, settle } = screen;
  const setInput = async (value: string) => { await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Issue number to inspect' }).props.onChangeText(value)); await settle(); };
  const inspect = async () => { await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Inspect issue by number' }).props.onPress()); await settle(); await settle(); };
  const text = () => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
  await setInput('7'); await inspect();
  await setInput('8'); await inspect();
  expect(text()).toContain('LOOKED_UP_EIGHT_TITLE');
  await act(async () => finishSeven(nonCandidate(7, 'LATE_SEVEN_TITLE'))); await settle(); await settle();
  expect(text()).toContain('LOOKED_UP_EIGHT_TITLE');
  expect(text()).not.toContain('LATE_SEVEN_TITLE');
});

it('repository_change_separates_pending_blocker_rows_details_and_sources', async () => {
  vi.useFakeTimers(); vi.setSystemTime(stamp); catalog();
  const detail = (selectedRepo: string, title: string, runId: string) => BlockerDetails.parse({
    ...JSON.parse(JSON.stringify(safeBlocker()).replaceAll(repo, selectedRepo)),
    issue: { ...issue(), title, url: `https://github.com/${selectedRepo}/issues/4` },
    reports: { ...JSON.parse(JSON.stringify(safeBlocker().reports).replaceAll(repo, selectedRepo)), selectedRunId: runId },
    artifacts: [], retention: { profile: 'orbi-0.7.41-release', worktreeRetainHours: 72, keepFailedWorktrees: null },
  });
  const a = detail(repo, 'A_BLOCKER_TITLE', 'aaaaaaaa'), b = detail('Reassigned/project', 'B_BLOCKER_TITLE', 'bbbbbbbb');
  const page = (selectedRepo: string, data: BlockerDetails) => blockersList.output.parse(available({ repo: selectedRepo, page: 1, hasNextPage: false, complete: true,
    records: [{ issue: data.issue, attention: data.attention, reports: data.reports }] }));
  host.readBlockers.mockReset().mockResolvedValue(page(repo, a)); host.readBlocker.mockReset().mockResolvedValue(blockersRead.output.parse(available(a)));
  const screen = await renderScreen();
  const { renderer, settle } = screen;
  const text = () => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Inspect blocker 4' }).props.onPress()); await settle(); await settle();
  expect(text()).toContain('A_BLOCKER_TITLE'); expect(text()).toContain('Reported run: aaaaaaaa'); expect(text()).toContain('Artifact metadata only');
  let finishList!: (value: unknown) => void, finishDetail!: (value: unknown) => void;
  host.readBlockers.mockImplementationOnce(() => new Promise(resolve => { finishList = resolve; }));
  host.readBlocker.mockImplementationOnce(() => new Promise(resolve => { finishDetail = resolve; }));
  // Reassign the host-level catalog while retaining the real QueryClient,
  // catalog observation envelope and selection IDs: a client seam, never a
  // server startup reconfiguration.
  host.readCatalog.mockResolvedValue({ state: 'configured', problems: [], entries: [
    { id: 'demo', label: 'Demo', repo: 'Reassigned/project', status: 'available', problems: [] },
  ] });
  const catalogKey = ['paseo-orbi', 'host-a', 'catalog', 'deployments.list'];
  const reassigned = await act(async () => {
    const observation = screen.client.getQueryData<any>(catalogKey);
    screen.client.setQueryData(catalogKey, { ...observation, data: { ...observation.data,
      entries: observation.data.entries.map((entry: any) => entry.id === 'demo' ? { ...entry, repo: 'Reassigned/project' } : entry) } });
  });
  await settle(); await settle();
  expect(host.readBlockers).toHaveBeenCalledTimes(2);
  expect(host.readBlockers).toHaveBeenLastCalledWith(blockersList.input.parse({ deploymentId: 'demo', page: 1 }));
  expect(text()).toContain('Loading'); expect(text()).not.toContain('A_BLOCKER_TITLE'); expect(text()).not.toContain('aaaaaaaa');
  expect(text()).not.toContain(`https://github.com/${repo}/issues/4`); expect(text()).not.toContain('Artifact metadata only');
  await act(async () => finishList(page('Reassigned/project', b))); await settle(); await settle();
  expect(text()).toContain('B_BLOCKER_TITLE'); expect(text()).toContain('https://github.com/Reassigned/project/issues/4#issuecomment-1');
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Inspect blocker 4' }).props.onPress()); await settle();
  expect(host.readBlocker).toHaveBeenCalledTimes(2);
  expect(host.readBlocker).toHaveBeenLastCalledWith(blockersRead.input.parse({ deploymentId: 'demo', issue: 4 }));
  expect(text()).not.toContain('Artifact metadata only'); expect(text()).not.toContain('aaaaaaaa');
  await act(async () => finishDetail(blockersRead.output.parse(available(b)))); await settle(); await settle();
  expect(text()).toContain('Artifact metadata only'); expect(text()).toContain('Reported run: bbbbbbbb'); expect(text()).not.toContain('A_BLOCKER_TITLE');
  host.readBlockers.mockRejectedValue(new Error('transport unavailable')); host.readBlocker.mockRejectedValue(new Error('transport unavailable'));
  await act(async () => { for (const refresh of renderer.root.findByProps({ testID: 'orbi-blockers' }).findAllByProps({ accessibilityLabel: 'Refresh' })) await refresh.props.onPress(); }); await settle();
  expect(text()).toContain('Stale'); expect(text()).toContain('refresh_failed'); expect(text()).toContain('B_BLOCKER_TITLE');
  expect(text()).toContain('Artifact metadata only'); expect(text()).not.toContain('A_BLOCKER_TITLE'); expect(text()).not.toContain(`https://github.com/${repo}/issues/4`);
});

it('opens_a_complete_reported_run_in_runs_without_extra_reads', async () => {
  vi.useFakeTimers(); vi.setSystemTime(stamp); catalog();
  const openScreen = vi.fn();
  host.readBlockers.mockReset().mockResolvedValue(available({ repo, page: 1, hasNextPage: false, complete: true, records: [safeBlocker()] }));
  host.readBlocker.mockReset().mockResolvedValue(available({ ...safeBlocker(), artifacts: [], retention: { profile: 'orbi-0.7.41-release', worktreeRetainHours: 72, keepFailedWorktrees: null } }));
  const screen = await renderScreen({ ...props, openScreen });
  const { renderer, settle } = screen;
  const controls = () => renderer.root.findAll(node => node.props.accessibilityLabel === `Inspect run ${run} in Runs`);
  const text = () => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
  expect(controls()).toHaveLength(1); // list evidence is activatable on its own
  expect(text()).toContain(`Reported run: ${run}; complete report read`);
  expect(host.readBlocker).not.toHaveBeenCalled();
  await act(async () => controls()[0].props.onPress()); await settle();
  expect(openScreen).toHaveBeenCalledWith({ screenId: 'runs', params: { deploymentId: 'demo', issue: '4', runId: run } });
  expect(host.readBlocker).not.toHaveBeenCalled(); // navigation adds no read
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Inspect blocker 4' }).props.onPress()); await settle(); await settle();
  expect(controls()).toHaveLength(2); // list + loaded detail evidence
  await act(async () => controls()[1].props.onPress()); await settle();
  expect(openScreen).toHaveBeenLastCalledWith({ screenId: 'runs', params: { deploymentId: 'demo', issue: '4', runId: run } });
  expect(openScreen).toHaveBeenCalledTimes(2);
  // Incomplete report reads keep today's plain wording and no activation.
  let direct!: ReactTestRenderer;
  const incomplete: Blocker = { ...safeBlocker(), reports: { ...safeBlocker().reports, complete: false, selectedRunId: null } };
  await act(async () => { direct = create(<BlockerEvidence data={incomplete} theme={theme} deploymentId="demo" openScreen={openScreen} />); });
  cleanups.push(async () => { await act(async () => direct.unmount()); });
  expect(direct.root.findAll(node => node.props.accessibilityRole === 'button')).toHaveLength(0);
  expect(direct.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n')).toContain('Reported run: unknown; incomplete — retained evidence may be stale; current run not established');
  expect(openScreen).toHaveBeenCalledTimes(2);
});

const blockerWith = (number: number, attention: Blocker['attention']): Blocker => ({ ...safeBlocker(number), attention });
const rowNumbers = (renderer: ReactTestRenderer) => renderer.root.findAll(node => typeof node.props.accessibilityLabel === 'string' && /^Inspect blocker \d+$/.test(node.props.accessibilityLabel))
  .map(node => Number(node.props.accessibilityLabel.slice('Inspect blocker '.length)));
const screenText = (renderer: ReactTestRenderer) => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
const countLabel = (label: string, count: number, total: number) => `${label}: ${count} of ${total} records on this observed page`;

it('summarises_the_observed_page_by_attention_class_and_orders_rows', async () => {
  vi.useFakeTimers(); vi.setSystemTime(stamp); catalog();
  // Deliberately not in attention-priority order; two manual rows keep their observed order.
  const records = [blockerWith(4, 'github_terminal'), blockerWith(5, 'maintainer_merge_wait'), blockerWith(6, 'manual_attention'), blockerWith(7, 'automatic_fix_pending'), blockerWith(8, 'manual_attention')];
  host.readBlockers.mockReset().mockResolvedValue(available({ repo, page: 1, hasNextPage: false, complete: true, records }));
  const { renderer, settle } = await renderScreen();
  const text = () => screenText(renderer);
  expect(rowNumbers(renderer)).toEqual([6, 8, 7, 5, 4]);
  // The summary describes this observed page only, with manual attention first.
  expect(text()).toContain('Attention on this observed page (at most 20 candidates), not a repository total.');
  expect(renderer.root.findAll(node => node.props.accessibilityLabel === 'Attention on this observed blockers page, not a repository total')).toHaveLength(1);
  const order = ['Manual attention: 2', 'Automatic fix pending: 1', 'Maintainer merge wait: 1', 'GitHub terminal: 1'].map(entry => text().indexOf(entry));
  expect(order.every(index => index >= 0)).toBe(true);
  expect([...order].sort((left, right) => left - right)).toEqual(order);
  for (const label of [countLabel('Manual attention', 2, 5), countLabel('Automatic fix pending', 1, 5), countLabel('Maintainer merge wait', 1, 5), countLabel('GitHub terminal', 1, 5)]) {
    expect(renderer.root.findAll(node => node.props.accessibilityLabel === label)).toHaveLength(1);
  }
  // Each row keeps today's evidence text and both existing controls.
  for (const guidance of [attentionText.manual_attention, attentionText.automatic_fix_pending, attentionText.maintainer_merge_wait, attentionText.github_terminal]) expect(text()).toContain(guidance);
  expect(renderer.root.findAllByType('Text' as any).filter(node => node.props.children === 'Inspect artifact metadata')).toHaveLength(5);
  expect(renderer.root.findAll(node => node.props.accessibilityLabel === `Inspect run ${run} in Runs`)).toHaveLength(5);
  // A refresh of the same observed page keeps every row in place.
  await act(async () => { for (const refresh of renderer.root.findByProps({ testID: 'orbi-blockers' }).findAllByProps({ accessibilityLabel: 'Refresh' })) await refresh.props.onPress(); }); await settle(); await settle();
  expect(rowNumbers(renderer)).toEqual([6, 8, 7, 5, 4]);
  expect(text()).toContain('Manual attention: 2');
});

it('keeps_an_incomplete_page_summary_page_scoped_and_not_an_empty_success', async () => {
  vi.useFakeTimers(); vi.setSystemTime(stamp); catalog();
  const records = [blockerWith(9, 'github_terminal'), blockerWith(10, 'manual_attention'), blockerWith(11, 'manual_attention')];
  host.readBlockers.mockReset().mockResolvedValue(available({ repo, page: 1, hasNextPage: false, complete: false, records }));
  const { renderer } = await renderScreen();
  const text = () => screenText(renderer);
  expect(rowNumbers(renderer)).toEqual([10, 11, 9]);
  expect(text()).toContain('Blockers page 1; scope incomplete / retained membership');
  expect(text()).toContain('Attention on this observed page (at most 20 candidates), not a repository total;');
  expect(text()).toContain('incomplete / retained membership');
  expect(text()).toContain('these counts describe only the records listed here.');
  expect(text()).not.toContain('No blockers in');
  expect(text()).toContain('Manual attention: 2');
  expect(text()).toContain('GitHub terminal: 1');
  expect(text()).toContain('Automatic fix pending: 0');
  expect(renderer.root.findAll(node => node.props.accessibilityLabel === countLabel('Automatic fix pending', 0, 3))).toHaveLength(1);
});

it('shows_no_attention_counts_on_an_empty_complete_page', async () => {
  vi.useFakeTimers(); vi.setSystemTime(stamp); catalog();
  host.readBlockers.mockReset().mockResolvedValue(available({ repo, page: 1, hasNextPage: false, complete: true, records: [] }));
  const { renderer } = await renderScreen();
  const text = () => screenText(renderer);
  expect(text()).toContain('No blockers in the complete observed scope');
  expect(text()).not.toContain('Attention on this observed page');
  expect(text()).not.toContain('Manual attention:');
  expect(renderer.root.findAll(node => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.includes('records on this observed page'))).toHaveLength(0);
});
