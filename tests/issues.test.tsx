import { describe, expect, it } from 'vitest';
import { classifyIssue } from '../shared/issues';
import { selectReports } from '../server/reports';

describe('Issues', () => {
  it('blocked_over_ready_and_closed_not_merged', () => {
    expect(classifyIssue('open', ['ai-ready', 'ai-blocked']).state).toBe('Blocked');
    expect(classifyIssue('closed', ['ai-ready']).state).toBe('Closed');
    expect(classifyIssue('closed', ['ai-merged']).provenance).toBe('reported');
  });
  it('newest_run_without_progress', () => {
    const comments = [
      { id: 1, updated_at: '2026-01-01T00:00:00Z', user: { login: 'runner' }, body: '<!-- orbi:run=11111111 -->\n<!-- orbi:progress:v1 {"step":"implement","reported_at":"2026-01-01T00:00:00Z","activity":null} -->' },
      { id: 2, updated_at: '2026-01-02T00:00:00Z', user: { login: 'runner' }, body: '<!-- orbi:run=22222222 -->\n<!-- orbi:comment=started -->' },
    ];
    const result = selectReports('owner/repo', 4, comments, ['runner'], true);
    expect(result.selectedRunId).toBe('22222222');
    expect(result.attribution).toEqual({ repo: 'owner/repo', issue: 4, commentId: 2, updatedAt: '2026-01-02T00:00:00Z' });
    expect(result.progress.status).toBe('missing');
  });
});

import { afterEach, vi } from 'vitest';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { ReportSelection, IssueDetail, IssuePage, issuesList, issuesGet, issueStates } from '../shared/issues';
import { GitHubReader } from '../server/github';
import { ReadPorts, type ProcessOperation } from '../server/read-ports';
import { ConfigRepository } from '../server/config';
import { fixture } from './helpers/fixtures';
import contribute from '../index.server';
import { deploymentsList } from '../shared/common';
import { fleetRead } from '../shared/fleet';
import { runsList, runsRead } from '../shared/runs';
import { blockersList, blockersRead, waitGuidance } from '../shared/blockers';
import { servicesInventory } from '../shared/services';
import type { PluginServerContext } from '@getpaseo/plugin/server';
const reports = JSON.parse(await readFile(new URL('./fixtures/github/reports.json', import.meta.url), 'utf8'));
const rest = JSON.parse(await readFile(new URL('./fixtures/github/rest.json', import.meta.url), 'utf8'));
const repo = 'Example/project', run = reports.run;
const marker = (id = run) => `<!-- orbi:run=${id} -->`;
const block = (name: string, data: unknown, version = 1) => `<!-- orbi:${name}:v${version} ${JSON.stringify(data)} -->`;
const kind = (value: string) => `<!-- orbi:comment=${value} -->`;
function comment(id: number, body: string, login = 'runner', updated_at = `2026-10-15T06:20:${String(id).padStart(2, '0')}Z`) { return { id, body, user: { login }, updated_at, author_association: 'OWNER' }; }
const select = (comments: unknown[], complete = true) => ReportSelection.parse(selectReports(repo, 4, comments, ['runner'], complete));
const response = (data: unknown, status = 200, headers: Record<string, string> = {}) => `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n${JSON.stringify(data)}`;
const cleanups: (() => unknown)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fakeReader() {
  let now = Date.parse('2026-10-15T06:20:00Z');
  const process = vi.fn<ReadPorts['process']>().mockResolvedValue(response([]));
  const resolve = vi.fn((id: string) => { if (id !== 'demo') throw new Error('deployment_unavailable'); return { repo, trustedPublisherLogins: ['runner'] } as unknown as ReturnType<ConfigRepository['resolve']>; });
  const reader = new GitHubReader({ resolve }, { process, clock: () => new Date(now) });
  return { reader, process, advance: (ms = 30001) => { now += ms; }, now: () => now };
}

describe('lifecycle_and_pagination', () => {
  it('covers every lifecycle combination and authoritative closed/merged facts', () => {
    const labels = ['ai-merged', 'ai-blocked', 'ai-needs-detail', 'ai-epic', 'ai-awaiting-merge', 'ai-pr-opened', 'ai-fix-needed', 'ai-in-progress', 'ai-planning', 'ai-paused', 'ai-ready'];
    const states = ['Merged', 'Blocked', 'Needs detail', 'Coordination', 'Reviewing', 'Reviewing', 'Reviewing', 'Implementing', 'Planning', 'Paused', 'Ready candidate'];
    for (let bits = 0; bits < 2 ** labels.length; bits++) {
      const present = labels.filter((_, i) => bits & 2 ** i);
      const first = labels.findIndex(label => present.includes(label));
      const expected = first < 0 ? 'Other' : states[first];
      expect(classifyIssue('open', present).state).toBe(expected);
      expect(classifyIssue('closed', present).state).toBe(present.includes('ai-merged') ? 'Merged' : 'Closed');
      expect(classifyIssue('open', present, true)).toMatchObject({ state: 'Merged', provenance: 'verified' });
      expect(classifyIssue('open', present).warning).toBe(present.length > 1);
    }
    expect(classifyIssue('open', ['ai-human-review']).state).toBe('Other');
  });
  it('browses all-state pages, excludes PRs and never treats errors as empty/ready', async () => {
    const f = fakeReader();
    f.process.mockResolvedValueOnce(response([rest.issue, { ...rest.issue, number: 9, pull_request: { url: 'https://example.invalid' } }]));
    const first = await f.reader.listIssues('demo', 1);
    expect(first.state).toBe('available');
    expect(IssuePage.parse(first.data).records.map(r => r.number)).toEqual([4]);
    expect(first.data?.records[0]).toMatchObject({ state: 'Blocked', warning: true, provenance: 'github' });
    expect(first.data?.dependencyStatus).toBe('unknown');
    expect(f.process.mock.calls[0][1]).toEqual({ kind: 'gh-api-get', resource: 'issues', state: 'all', page: 1 });
    f.advance(); f.process.mockResolvedValueOnce(response({}, 401));
    const stale = await f.reader.listIssues('demo', 1);
    expect(stale).toMatchObject({ state: 'stale', data: first.data, lastSuccessfulAt: first.lastSuccessfulAt, problems: [{ code: 'auth_denied' }] });
    const unavailable = await f.reader.listIssues('demo', 2);
    expect(unavailable).toMatchObject({ state: 'available', data: { records: [] } }); // separate observed page, not stale page 1
    const denied = fakeReader(); denied.process.mockResolvedValue(response({}, 401));
    expect(await denied.reader.listIssues('demo', 1)).toMatchObject({ state: 'unavailable', data: null, problems: [{ code: 'auth_denied' }] });
    expect(JSON.stringify(first)).not.toContain('BODY_CANARY');
  });
  it('collects complete open membership across pages; capped/failed initial reads establish nothing', async () => {
    const f = fakeReader();
    const page = Array.from({ length: 100 }, (_, i) => ({ ...rest.issue, number: i + 1 }));
    f.process.mockResolvedValueOnce(response(page)).mockResolvedValueOnce(response([{ ...rest.issue, number: 101 }]));
    const good = await f.reader.listIssueScope('demo');
    expect(good.complete).toBe(true); expect(good.records).toHaveLength(101);
    expect(f.process.mock.calls.map(([, op]) => op)).toEqual([1, 2].map(page => ({ kind: 'gh-api-get', resource: 'issues', state: 'open', page })));
    f.advance(); f.process.mockResolvedValue(response(page));
    const capped = await f.reader.listIssueScope('demo');
    expect(capped).toMatchObject({ complete: false, records: good.records, observedAt: good.observedAt, problems: [{ code: 'incomplete' }] });
    expect(f.process).toHaveBeenCalledTimes(12);
    const initial = fakeReader(); initial.process.mockResolvedValue(response(page));
    expect(await initial.reader.listIssueScope('demo')).toMatchObject({ complete: false, records: [] });
    const failure = fakeReader(); failure.process.mockResolvedValueOnce(response(page)).mockRejectedValueOnce(new Error('NETWORK_SECRET'));
    expect(await failure.reader.listIssueScope('demo')).toMatchObject({ complete: false, records: [], problems: [{ code: 'network_failed' }] });
  });
});

describe('trusted_report_selection', () => {
  it('accepts pinned progress, failure, scene and base CI contracts with attribution and suppressed targets', () => {
    const result = select([
      comment(1, `${marker()}\n${block('progress', reports.progress)}\n\nPROSE_CANARY`),
      comment(2, `${marker()}\n${kind('failure')}\n${block('failure', reports.failure)}\n${block('base-ci-red', reports.baseCi)}`),
      comment(3, `${marker()}\n${kind('review-round')}\n${block('scene', reports.scene)}`),
    ]);
    expect(result).toMatchObject({ selectedRunId: run, complete: true, progress: { status: 'available', data: { step: 'review', activity: { target: null } }, attribution: { repo, issue: 4, commentId: 1 } }, failure: { status: 'available', data: { action_code: 'fix_ticket' } }, baseCi: { status: 'available', data: { state: 'waiting' } }, prIdentity: { status: 'available', number: 42, source: 'scene' } });
    expect(JSON.stringify(result)).not.toMatch(/TARGET_CANARY|PROSE_CANARY|body|author_association/);
  });
  it('reads the pinned base-CI writer final block only on a formal base_ci_red failure', () => {
    const body = `${marker()}\n${kind('failure')}\n${block('failure', reports.failure)}\n\nReadable failure and repair prose\n\n${block('base-ci-red', reports.baseCi)}`;
    expect(select([comment(1, body)]).baseCi.status).toBe('available');
    expect(select([comment(1, body.replace('\n\n' + block('base-ci-red', reports.baseCi), '\n\n> ' + block('base-ci-red', reports.baseCi)))]).baseCi.status).toBe('missing');
  });
  it('rejects untrusted, quoted, fenced, malformed prefix and unknown kind without authorAssociation authentication', () => {
    const good = comment(1, `${marker()}\n${block('progress', reports.progress)}`);
    for (const body of [
      `> ${marker('22222222')}\n${block('progress', reports.progress)}`,
      `\`\`\`html\n${marker('22222222')}\n${block('progress', reports.progress)}\n\`\`\``,
      `prose\n${marker('22222222')}`, `${marker('22222222')}\n${kind('invented')}`,
      `${marker('bad-run')}\n${kind('started')}`,
    ]) expect(select([good, comment(2, body)]).selectedRunId).toBe(run);
    expect(select([good, comment(2, `${marker('22222222')}\n${kind('started')}`, 'attacker')]).selectedRunId).toBe(run);
    expect(select([comment(2, `${marker()}\n\n${block('progress', reports.progress)}`)]).progress.status).toBe('missing');
    expect(select([comment(2, 'Orbi progress: PROSE_CANARY')]).selectedRunId).toBeNull();
  });
  it('selects by updated time then numeric comment id, keeps same-run progress, and never falls back across runs', () => {
    const old = comment(1, `${marker()}\n${block('progress', reports.progress)}`);
    const newer = comment(2, `${marker('22222222')}\n${kind('started')}`);
    expect(select([old, newer]).progress.status).toBe('missing');
    expect(select([old, comment(2, `${marker()}\n${kind('started')}`)]).progress.status).toBe('available');
    const late = { ...old, updated_at: '2026-10-15T07:00:00Z' };
    expect(select([late, newer]).selectedRunId).toBe(run);
    expect(select([old, { ...newer, updated_at: old.updated_at }]).selectedRunId).toBe('22222222');
    for (const token of [block('progress', reports.progress, 9), '<!-- orbi:progress:v1 {"step": -->', block('progress', { ...reports.progress, step: 'made_up' })]) {
      const result = select([old, comment(2, `${marker('22222222')}\n${token}`)]);
      expect(result.selectedRunId).toBe('22222222');
      expect(result.progress.status).toBe(token.includes(':v9') ? 'unsupported' : 'invalid');
    }
    expect(select([old], false)).toMatchObject({ complete: false, selectedRunId: null, progress: { status: 'missing' } });
  });
  it('rejects duplicate blocks, unknown fields and enum/schema drift', () => {
    const progress = block('progress', reports.progress);
    expect(select([comment(1, `${marker()}\n${progress}\n${progress}`)]).progress.status).toBe('invalid');
    for (const data of [{ ...reports.failure, reason_code: 'arbitrary' }, { ...reports.failure, action_code: 'execute' }, { ...reports.failure, outcome: 'ready' }, { ...reports.failure, schema: 2 }, { ...reports.failure, retry_safe: 'true' }, { ...reports.failure, prose: 'SECRET' }]) {
      expect(select([comment(1, `${marker()}\n${kind('failure')}\n${block('failure', data)}`)]).failure.status).toBe('invalid');
    }
    for (const data of [{ ...reports.progress, activity: { ...reports.progress.activity, kind: 'tool' } }, { ...reports.progress, reported_at: null }, { ...reports.progress, activity: {} }]) expect(select([comment(1, `${marker()}\n${block('progress', data)}`)]).progress.status).toBe('invalid');
    for (const data of [{ ...reports.baseCi, state: 'green' }, { ...reports.baseCi, schema: 2 }]) expect(select([comment(1, `${marker()}\n${kind('failure')}\n${block('base-ci-red', data)}`)]).baseCi.status).toBe('invalid');
    for (const data of [{ ...reports.scene, external: false }, { ...reports.scene, review_round: -1 }, { ...reports.scene, run_id: '22222222' }, { ...reports.scene, pr_url: 'https://github.com/Foreign/project/pull/42' }, { ...reports.scene, pr_url: 'https://github.com/Example/project/pull/0' }]) expect(select([comment(1, `${marker()}\n${block('scene', data)}`)]).scene.status).toBe('invalid');
  });
  it('does not reinterpret kinded or non-leading progress as a formal progress comment', () => {
    expect(select([comment(1, `${marker()}\n${kind('started')}\n${block('progress', reports.progress)}`)]).progress.status).toBe('missing');
    expect(select([comment(1, `${marker()}\n${block('scene', reports.scene)}\n${block('progress', reports.progress)}`)]).progress.status).toBe('missing');
  });
  it('does not hide a newest failure missing its own record behind an older same-run failure', () => {
    const older = comment(1, `${marker()}\n${kind('failure')}\n${block('failure', reports.failure)}`);
    const newest = comment(2, `${marker()}\n${kind('failure')}\n\nLegacy prose only`);
    expect(select([older, newest]).failure.status).toBe('missing');
  });
  it('supports receipt-only identity and exposes scene/receipt conflicts with no selected PR', () => {
    const receipt = comment(2, `${marker()}\n${kind('merged')}\nReadable PROSE_CANARY\n\n${reports.receipt}`);
    expect(select([receipt])).toMatchObject({ mergedReceipt: { status: 'available', data: { review_rounds: 2, commits: 3 } }, prIdentity: { status: 'available', source: 'receipt', number: 42 } });
    const scene = comment(1, `${marker()}\n${block('scene', { ...reports.scene, pr_url: `https://github.com/${repo}/pull/43` })}`);
    expect(select([scene, receipt]).prIdentity).toEqual({ status: 'conflict' });
    const same = comment(1, `${marker()}\n${block('scene', reports.scene)}`);
    expect(select([same, receipt]).prIdentity).toMatchObject({ status: 'available', source: 'scene' });
    for (const malformed of [
      reports.receipt.replace('- commits=3', '- commits=3\n- commits=3'),
      reports.receipt.replace('- commits=3', '- commits=3\n- commits=4'),
      `${reports.receipt}\n${reports.receipt}`,
      reports.receipt.replace('- commits=3', '- commits=-1'),
      reports.receipt.replace('merge_commit=' + 'b'.repeat(40), 'merge_commit=bad'),
      reports.receipt.replace('run_id=' + run, 'run_id=22222222'),
      reports.receipt.replace('https://github.com/Example/project/pull/42', 'https://github.com/Foreign/project/pull/42'),
      reports.receipt.split('\n').map((line: string) => `> ${line}`).join('\n'),
      `\`\`\`html\n${reports.receipt}\n\`\`\``,
    ]) {
      const result = select([same, comment(2, `${marker()}\n${kind('merged')}\n\n${malformed}`)]);
      expect(result.mergedReceipt.status).toBe('invalid'); expect(result.prIdentity).toEqual({ status: 'invalid' });
    }
  });
});

describe('github_boundary_and_backoff', () => {
  it('coalesces selected reports, paginates fully, retains complete run on partial refresh and never scans historical issue comments', async () => {
    const f = fakeReader();
    const records = Array.from({ length: 100 }, (_, i) => comment(i + 1, `${marker()}\n${kind('started')}`, 'runner', '2026-10-15T06:20:01Z'));
    f.process.mockResolvedValueOnce(response(records)).mockResolvedValueOnce(response([comment(101, `${marker()}\n${block('progress', reports.progress)}`, 'runner', '2026-10-15T06:21:00Z')]));
    const [a, b] = await Promise.all([f.reader.readIssueReports('demo', 4), f.reader.readIssueReports('demo', 4)]);
    expect(a).toEqual(b); expect(a.progress.status).toBe('available'); expect(f.process).toHaveBeenCalledTimes(2);
    expect(f.process.mock.calls.map(([, op]) => op)).toEqual([1, 2].map(page => ({ kind: 'gh-api-get', resource: 'comments', issue: 4, page })));
    f.advance(); f.process.mockResolvedValueOnce(response(records)).mockResolvedValueOnce(response({}, 500));
    expect(await f.reader.readIssueReports('demo', 4)).toMatchObject({ selectedRunId: run, complete: false, progress: a.progress });
    const initial = fakeReader(); initial.process.mockResolvedValue(response(records));
    expect(await initial.reader.readIssueReports('demo', 4)).toMatchObject({ complete: false, selectedRunId: null });
    const browse = fakeReader(); await browse.reader.listIssues('demo', 1); await browse.reader.listIssueScope('demo');
    expect(browse.process.mock.calls.every(([, op]) => op.kind === 'gh-api-get' && op.resource === 'issues')).toBe(true);
  });
  it.each(['retry', 'reset', 'absent'] as const)('honors %s rate gate, including manual refresh and other deployments/selectors', async mode => {
    const f = fakeReader();
    const headers: Record<string, string> = mode === 'retry' ? { 'Retry-After': '90' } : mode === 'reset' ? { 'X-RateLimit-Reset': String(f.now() / 1000 + 90) } : {};
    f.process.mockResolvedValueOnce(response({}, 429, headers));
    expect(await f.reader.listIssues('demo', 1)).toMatchObject({ state: 'unavailable', problems: [{ code: 'rate_limited' }] });
    f.advance(30001);
    expect(await f.reader.listIssues('demo', 1)).toMatchObject({ state: 'unavailable', problems: [{ code: 'rate_limited' }] });
    expect(await f.reader.listIssueScope('demo')).toMatchObject({ complete: false, problems: [{ code: 'rate_limited' }] });
    expect(f.process).toHaveBeenCalledTimes(1);
    f.advance(mode === 'absent' ? 30001 : 60001);
    expect(await f.reader.listIssues('demo', 2)).toMatchObject({ state: 'available' });
    expect(f.process).toHaveBeenCalledTimes(2);
  });
  it('treats 403 without quota exhaustion as auth denial and applies fallback backoff; missing dependencies are not unblocked', async () => {
    const f = fakeReader(); f.process.mockResolvedValueOnce(response({}, 403, { 'X-RateLimit-Remaining': '3000' }));
    expect(await f.reader.readDependencies('demo', 4)).toMatchObject({ complete: false, records: [], problems: [{ code: 'auth_denied' }] });
    await f.reader.listIssues('demo', 1); expect(f.process).toHaveBeenCalledTimes(1);
    f.advance(60001); f.process.mockResolvedValueOnce(response({}, 404));
    expect(await f.reader.readDependencies('demo', 4)).toMatchObject({ complete: false, records: [], problems: [{ code: 'not_found' }] });
  });
  it('never attributes a foreign native dependency to the selected repository', async () => {
    const f = fakeReader();
    f.process.mockResolvedValue(response([{ ...rest.issue, html_url: 'https://github.com/Foreign/project/issues/4' }]));
    expect(await f.reader.readDependencies('demo', 4)).toMatchObject({ complete: false, records: [], problems: [{ code: 'invalid_response' }] });
  });
  it('reduces the final child deadline to the remaining 60-second collection budget', async () => {
    const f = fakeReader();
    f.process.mockImplementation(async () => { f.advance(9800); return response(Array.from({ length: 100 }, () => rest.issue)); });
    expect(await f.reader.listIssueScope('demo')).toMatchObject({ complete: false, problems: [{ code: 'deadline' }] });
    expect(f.process.mock.calls[6][2]).toBe(1200);
  });
  it('enforces cycle deadline, exact PR identity and head-only safe check projection', async () => {
    const f = fakeReader();
    f.process.mockImplementationOnce(async () => { f.advance(60001); return response(Array.from({ length: 100 }, () => rest.issue)); });
    expect(await f.reader.listIssueScope('demo')).toMatchObject({ complete: false, records: [], problems: [{ code: 'deadline' }] });
    f.process.mockResolvedValueOnce(response(rest.pull)).mockResolvedValueOnce(response(rest.checks));
    const pr = await f.reader.getPullRequestEvidence('demo', 42);
    expect(pr).toMatchObject({ number: 42, mergedAt: rest.pull.merged_at, head: 'a'.repeat(40), checks: { complete: true } });
    expect(JSON.stringify(pr)).not.toContain('OUTPUT_CANARY');
    expect(f.process.mock.calls.at(-1)?.[1]).toEqual({ kind: 'gh-api-get', resource: 'checks', sha: 'a'.repeat(40), page: 1 });
    f.process.mockResolvedValueOnce(response({ ...rest.pull, number: 43, html_url: 'https://github.com/Foreign/repo/pull/43' }));
    await expect(f.reader.getPullRequestEvidence('demo', 43)).rejects.toThrow('invalid_response');
    await expect(f.reader.listIssues('unauthorized', 1)).rejects.toThrow('deployment_unavailable');
  });
  it('uses terminal GitHub facts over progress and verifies merges only through exact-repo PR merged_at', async () => {
    const f = fakeReader();
    f.process.mockImplementation(async (_id, op) => {
      if (op.kind !== 'gh-api-get') throw new Error('unexpected');
      if (op.resource === 'issue') return response({ ...rest.issue, state: 'closed', labels: [] });
      if (op.resource === 'comments') return response([comment(1, `${marker()}\n${block('progress', reports.progress)}`), comment(2, `${marker()}\n${kind('merged')}\n\n${reports.receipt}`)]);
      if (op.resource === 'pull') return response({ ...rest.pull, merged_at: null });
      if (op.resource === 'checks') return response(rest.checks);
      return response([]);
    });
    const reported = await f.reader.getIssue('demo', 4);
    expect(IssueDetail.parse(reported.data)).toMatchObject({ issue: { state: 'Closed' }, mergeEvidence: 'reported', reports: { progress: { status: 'available' } } });
    f.advance();
    f.process.mockImplementation(async (_id, op) => {
      if (op.kind === 'gh-api-get' && op.resource === 'issue') return response({ ...rest.issue, state: 'closed', labels: [] });
      if (op.kind === 'gh-api-get' && op.resource === 'comments') return response([comment(2, `${marker()}\n${kind('merged')}\n\n${reports.receipt}`)]);
      if (op.kind === 'gh-api-get' && op.resource === 'pull') return response(rest.pull);
      if (op.kind === 'gh-api-get' && op.resource === 'checks') return response(rest.checks);
      return response([]);
    });
    const verified = await f.reader.getIssue('demo', 4);
    expect(verified.data).toMatchObject({ issue: { state: 'Merged', provenance: 'verified' }, mergeEvidence: 'verified' });
    f.advance(); f.process.mockResolvedValue(response({}, 401));
    expect(await f.reader.getIssue('demo', 4)).toMatchObject({ state: 'stale', data: verified.data });
  });
  it('retains verified merge evidence stale when the same associated PR cannot be refreshed', async () => {
    const f = fakeReader();
    let denyPull = false, otherPr = false;
    f.process.mockImplementation(async (_id, op) => {
      if (op.kind !== 'gh-api-get') throw new Error('unexpected operation');
      if (op.resource === 'issue') return response({ ...rest.issue, state: 'closed', labels: [] });
      if (op.resource === 'comments') return response([comment(1, `${marker()}\n${block('scene', otherPr ? { ...reports.scene, pr_url: `https://github.com/${repo}/pull/43` } : reports.scene)}`)]);
      if (op.resource === 'pull') return denyPull ? response({}, 401) : response(rest.pull);
      if (op.resource === 'checks') return response(rest.checks);
      return response([]);
    });
    const verified = await f.reader.getIssue('demo', 4);
    expect(verified).toMatchObject({ state: 'available', data: { issue: { state: 'Merged', provenance: 'verified' } } });
    f.advance(); denyPull = true;
    const stale = await f.reader.getIssue('demo', 4);
    expect(stale).toMatchObject({ state: 'stale', lastSuccessfulAt: verified.lastSuccessfulAt,
      problems: [{ code: 'auth_denied' }], data: { issue: { state: 'Merged', provenance: 'verified' }, mergeEvidence: 'verified' } });
    f.advance(); otherPr = true;
    expect(await f.reader.getIssue('demo', 4)).toMatchObject({ state: 'stale',
      data: { issue: { state: 'Closed', provenance: 'github' }, mergeEvidence: 'unknown' } });
  });
  it('propagates the concrete safe comment-read problem through reports and the detail RPC projection', async () => {
    const f = fakeReader();
    let denyComments = false;
    f.process.mockImplementation(async (_id, op) => {
      if (op.kind !== 'gh-api-get') throw new Error('unexpected operation');
      if (op.resource === 'issue') return response(rest.issue);
      if (op.resource === 'comments') return denyComments ? response({}, 401) : response([comment(1, `${marker()}\n${block('progress', reports.progress)}`)]);
      return response([]);
    });
    const first = await f.reader.getIssue('demo', 4);
    expect(first.state).toBe('available');
    f.advance(); denyComments = true;
    const stale = await f.reader.getIssue('demo', 4);
    expect(stale).toMatchObject({ state: 'stale', problems: [{ source: 'github', code: 'auth_denied' }],
      data: { reports: { complete: false, selectedRunId: run, progress: first.data?.reports.progress,
        problems: [{ source: 'github', code: 'auth_denied' }] } } });
    expect(() => IssueDetail.parse(stale.data)).not.toThrow();
  });
  it('shows newly confirmed terminal facts even if report/dependency refresh is incomplete', async () => {
    const f = fakeReader();
    f.process.mockImplementation(async (_id, op) => response(op.kind === 'gh-api-get' && op.resource === 'issue' ? rest.issue : []));
    expect((await f.reader.getIssue('demo', 4)).data?.issue.state).toBe('Blocked');
    f.advance();
    f.process.mockImplementation(async (_id, op) => op.kind === 'gh-api-get' && op.resource === 'issue' ? response({ ...rest.issue, state: 'closed', labels: [] }) : response({}, 401));
    const result = await f.reader.getIssue('demo', 4);
    expect(result.state).toBe('stale'); expect(result.data?.issue.state).toBe('Closed');
    expect(result.data?.reports.complete).toBe(false);
  });
  it('records actual gh argv for every allowlisted endpoint and receives headers even on nonzero HTTP exits', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    const bin = join(f.root, 'bin'); await mkdir(bin);
    const script = join(bin, 'gh');
    await writeFile(script, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)))\n`); await chmod(script, 0o755);
    vi.stubEnv('PATH', bin);
    const ports = new ReadPorts(await ConfigRepository.load(f.authorization)); cleanups.push(() => ports.dispose());
    const operations: [ProcessOperation, string][] = [
      [{ kind: 'gh-api-get', resource: 'issues', state: 'all', page: 2 }, 'issues?state=all&sort=updated&direction=desc&per_page=100&page=2'],
      [{ kind: 'gh-api-get', resource: 'issues', state: 'open', page: 1 }, 'issues?state=open&sort=updated&direction=desc&per_page=100&page=1'],
      [{ kind: 'gh-api-get', resource: 'comments', issue: 4, page: 3 }, 'issues/4/comments?per_page=100&page=3'],
      [{ kind: 'gh-api-get', resource: 'dependencies', issue: 4, page: 1 }, 'issues/4/dependencies/blocked_by?per_page=100&page=1'],
      [{ kind: 'gh-api-get', resource: 'issue', issue: 4, page: 1 }, 'issues/4'],
      [{ kind: 'gh-api-get', resource: 'pull', pr: 42, page: 1 }, 'pulls/42'],
      [{ kind: 'gh-api-get', resource: 'checks', sha: 'a'.repeat(40), page: 1 }, `commits/${'a'.repeat(40)}/check-runs?per_page=100&page=1`],
    ];
    for (const [operation, endpoint] of operations) expect(JSON.parse(await ports.process('demo', operation))).toEqual(['api', '--hostname', 'github.com', '--method', 'GET', '--include', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', `repos/${repo}/${endpoint}`]);
    for (const operation of [{ kind: 'gh-api-get', resource: 'checks', sha: '../main', page: 1 }, { kind: 'gh-api-get', resource: 'pull', pr: 0, page: 1 }, { kind: 'gh-api-get', resource: 'issues', state: 'closed', page: 1 }, { kind: 'gh-api-get', resource: 'comments', issue: -1, page: 1 }]) await expect(ports.process('demo', operation as ProcessOperation)).rejects.toThrow('unsafe_path');
    const http = response({}, 429, { 'Retry-After': '90' });
    await writeFile(script, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(http)});process.stderr.write('STDERR_CANARY');process.exit(1);`);
    expect(await ports.process('demo', operations[0][0])).toBe(http);
  });
  it('registers strict typed list/detail RPCs using only safe catalog ids', async () => {
    const f = await fixture(); cleanups.push(f.cleanup); vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
    const handlers = new Map<unknown, (input: any) => Promise<unknown>>();
    cleanups.push(contribute({ handle: (contract: unknown, handler: (input: any) => Promise<unknown>) => { handlers.set(contract, handler); } } as unknown as PluginServerContext));
    expect([...handlers.keys()]).toEqual([blockersList, blockersRead, deploymentsList, servicesInventory, issuesList, issuesGet, fleetRead, runsList, runsRead]);
    const process = vi.spyOn(ReadPorts.prototype, 'process').mockImplementation(async (_id, op) => response(op.kind === 'gh-api-get' && op.resource === 'issues' ? [rest.issue] : []));
    const result = issuesList.output.parse(await handlers.get(issuesList)!({ deploymentId: 'demo', page: 1 }));
    expect(result.data?.records[0].state).toBe('Blocked');
    expect(JSON.stringify(result)).not.toMatch(/BODY_CANARY|publisher-canary|repoDir/);
    await expect(handlers.get(issuesList)!({ deploymentId: 'unknown', page: 1 })).rejects.toThrow('deployment_unavailable');
    expect(process).toHaveBeenCalledTimes(1);
    expect(() => issuesList.input.parse({ deploymentId: 'demo', page: 1, url: 'https://evil.invalid' })).toThrow();
  });
});

import './helpers/host';
import { host } from './helpers/host';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { Shell } from '../client/shell';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const screenProps = { theme: { colors: { foreground: '#eee', foregroundMuted: '#aaa', surface0: '#111' } }, host: { id: 'host-a', label: 'Host A' }, layout: { compact: true, platform: 'web' }, params: { deploymentId: 'demo' }, route: 'issues', openScreen: vi.fn() } as unknown as React.ComponentProps<typeof Shell>;
async function renderIssues() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={client}><Shell {...screenProps} /></QueryClientProvider>); });
  const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2); }); };
  await settle(); await settle();
  cleanups.push(async () => { await act(async () => renderer.unmount()); client.clear(); });
  return { renderer, settle, client, rerender: async (props: typeof screenProps) => {
    await act(async () => renderer.update(<QueryClientProvider client={client}><Shell {...props} /></QueryClientProvider>));
    await settle(); await settle();
  } };
}
describe('Issues user journey', () => {
  it('safe_external_evidence_links', async () => {
    vi.useFakeTimers();
    host.openExternalUrl.mockReset().mockResolvedValue(undefined);
    const f = fakeReader();
    f.process.mockImplementation(async (_id, op) => {
      if (op.kind !== 'gh-api-get') throw new Error('unexpected operation');
      if (op.resource === 'issues') return response(op.page === 1 ? Array.from({ length: 100 }, (_, i) => ({ ...rest.issue, number: i + 1, html_url: `https://github.com/${repo}/issues/${i + 1}` })) : [{ ...rest.issue, number: 101, html_url: `https://github.com/${repo}/issues/101` }]);
      if (op.resource === 'issue') return response({ ...rest.issue, number: op.issue, html_url: `https://github.com/${repo}/issues/${op.issue}` });
      if (op.resource === 'comments') return response([comment(1, `${marker()}\n${block('scene', reports.scene)}`)]);
      if (op.resource === 'pull') return response({ ...rest.pull, merged_at: null });
      if (op.resource === 'checks') return response(rest.checks);
      return response([]);
    });
    const catalog = (selectedRepo = repo, id = 'demo', status = 'available') => ({ state: 'configured', entries: [{ id, label: 'Demo', repo: selectedRepo, status, problems: [] }], problems: [] });
    host.readCatalog.mockResolvedValue(catalog());
    host.readIssues.mockImplementation(async input => issuesList.output.parse(await f.reader.listIssues(input.deploymentId, input.page)));
    host.readIssue.mockImplementation(async input => issuesGet.output.parse(await f.reader.getIssue(input.deploymentId, input.issue)));
    const { renderer, settle, client, rerender } = await renderIssues();
    const links = () => renderer.root.findAll(node => node.type === ('ExternalLink' as any));
    const link = (kind: 'issue' | 'pull request', number: number, selectedRepo = repo) => links().find(node => node.props.accessibilityLabel === `Open ${selectedRepo} ${kind} ${number} on GitHub`)!;
    const rpcCounts = () => [host.readCatalog.mock.calls.length, host.readIssues.mock.calls.length, host.readIssue.mock.calls.length, f.process.mock.calls.length];
    expect(host.openExternalUrl).not.toHaveBeenCalled();
    const issueLink = link('issue', 4);
    expect(issueLink).toBeDefined();
    expect(issueLink.props.accessibilityRole).toBe('link');
    expect(issueLink.findByType('Text' as any).props.style.color).toBe('#eee');
    // The host link is a sibling, never inside the inspect press target.
    const inspect = renderer.root.findByProps({ accessibilityLabel: 'Inspect issue 4' });
    expect(inspect.findAll(node => node.type === ('ExternalLink' as any))).toHaveLength(0);
    const beforeOpen = rpcCounts();
    await act(async () => issueLink.props.onPress());
    expect(host.openExternalUrl).toHaveBeenLastCalledWith(`https://github.com/${repo}/issues/4`);
    expect(rpcCounts()).toEqual(beforeOpen);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('PR identity:');
    await act(async () => inspect.props.onPress()); await settle(); await settle();
    expect(host.readIssue).toHaveBeenLastCalledWith({ deploymentId: 'demo', issue: 4 });
    const prLink = link('pull request', 42);
    expect(prLink).toBeDefined();
    expect(prLink.findByType('Text' as any).props.style.color).toBe('#eee');
    const beforePr = rpcCounts();
    await act(async () => prLink.props.onPress());
    expect(host.openExternalUrl).toHaveBeenLastCalledWith(`https://github.com/${repo}/pull/42`);
    expect(rpcCounts()).toEqual(beforePr);
    expect(JSON.stringify(renderer.toJSON())).toContain('(scene)');
    expect(JSON.stringify(renderer.toJSON())).toContain('Merge evidence: ');
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Next page' }).props.onPress()); await settle(); await settle();
    expect(host.readIssues).toHaveBeenLastCalledWith({ deploymentId: 'demo', page: 2 });
    expect(link('pull request', 42)).toBeUndefined();
    expect(host.openExternalUrl).toHaveBeenCalledTimes(2);
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Previous page' }).props.onPress()); await settle(); await settle();
    expect(host.readIssues).toHaveBeenCalledWith({ deploymentId: 'demo', page: 1 });
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Inspect issue 4' }).props.onPress()); await settle(); await settle();

    const listKey = (hostId = 'host-a', id = 'demo', selectedRepo = repo) => ['paseo-orbi', hostId, id, `issues.list:${selectedRepo}:1`];
    const detailKey = ['paseo-orbi', 'host-a', 'demo', `issues.get:${repo}:4`];
    const page = issuesList.output.parse(client.getQueryData(listKey()));
    const detail = issuesGet.output.parse(client.getQueryData(detailKey));
    const setPage = async (url: string, hostId = 'host-a', selectedRepo = repo, id = 'demo') => {
      await act(async () => { client.setQueryData(listKey(hostId, id, selectedRepo), issuesList.output.parse({ ...page, data: { ...page.data!, repo: selectedRepo, records: [{ ...page.data!.records[0], url }] } })); });
      await settle();
    };
    // Both issue URLs and available PR identities must be exact canonical destinations.
    const invalidUrls = (kind: string, number: number) => [
      `https://github.com/Foreign/project/${kind}/${number}`, `https://user@github.com/${repo}/${kind}/${number}`,
      `https://github.com/${repo}/${kind}/${number}?next=evil`, `https://github.com/${repo}/${kind}/${number}#fragment`,
      `https://github.com/${repo}/${kind}/%${number}`, `https://github.com/${repo}/${kind}/0${number}`,
      `https://github.com/${repo}/${kind}/${number + 1}`, `https://github.com/${repo}/${kind}/${number}/`,
      `http://github.com/${repo}/${kind}/${number}`, `https://github.com:443/${repo}/${kind}/${number}`,
      `https://github.com.evil/${repo}/${kind}/${number}`, 'javascript:alert(1)', '', 'not a URL',
    ];
    // Remove the detail override when checking list destinations.
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Next page' }).props.onPress()); await settle(); await settle();
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Previous page' }).props.onPress()); await settle(); await settle();
    for (const url of invalidUrls('issues', 1)) {
      await setPage(url);
      expect(links()).toHaveLength(0);
      expect(JSON.stringify(renderer.toJSON())).toContain('Inspect issue 1');
    }
    await setPage(`https://github.com/${repo}/issues/1`);
    await act(async () => { client.setQueryData(listKey(), { ...client.getQueryData<object>(listKey()), state: 'stale' }); }); await settle();
    expect(link('issue', 1)).toBeDefined(); // retained evidence still belongs to selected repo
    expect(JSON.stringify(renderer.toJSON())).toContain('stale');
    expect(host.openExternalUrl).toHaveBeenCalledTimes(2);
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Inspect issue 1' }).props.onPress()); await settle(); await settle();
    const currentDetailKey = ['paseo-orbi', 'host-a', 'demo', `issues.get:${repo}:1`];
    for (const url of invalidUrls('pull', 42)) {
      await act(async () => { client.setQueryData(currentDetailKey, issuesGet.output.parse({ ...detail, data: { ...detail.data!, reports: { ...detail.data!.reports, prIdentity: { status: 'available', number: 42, url, source: 'scene', runId: run } } } })); });
      await settle();
      expect(link('pull request', 42)).toBeUndefined();
      expect(JSON.stringify(renderer.toJSON())).toContain('PR identity: ');
    }
    for (const status of ['missing', 'invalid', 'conflict'] as const) {
      await act(async () => { client.setQueryData(currentDetailKey, issuesGet.output.parse({ ...detail, data: { ...detail.data!, reports: { ...detail.data!.reports, prIdentity: { status } } } })); });
      await settle();
      expect(link('pull request', 42)).toBeUndefined();
      expect(JSON.stringify(renderer.toJSON())).toContain(status);
    }
    // Error handling consumes rejection without leaking raw diagnostics or adding reads.
    const error = vi.spyOn(console, 'error'), warn = vi.spyOn(console, 'warn');
    host.openExternalUrl.mockRejectedValueOnce(new Error('OPENER_SECRET'));
    const beforeError = rpcCounts();
    await act(async () => link('issue', 1).props.onPress());
    const safeMessage = 'Could not open GitHub. Try again using the link.';
    expect(JSON.stringify(renderer.toJSON())).toContain(safeMessage);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('OPENER_SECRET');
    expect(error).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
    expect(rpcCounts()).toEqual(beforeError);
    await act(async () => link('issue', 1).props.onPress()); // deliberate retry
    expect(host.openExternalUrl).toHaveBeenLastCalledWith(`https://github.com/${repo}/issues/1`);

    const setCatalog = async (selectedRepo: string, status = 'available', hostId = 'host-a') => {
      await act(async () => { client.setQueryData(['paseo-orbi', hostId, 'catalog', 'deployments.list'], { state: 'available', observedAt: new Date().toISOString(), lastSuccessfulAt: new Date().toISOString(), data: catalog(selectedRepo, 'demo', status), problems: [] }); });
      await settle();
    };
    const oldControl = link('issue', 1);
    await setCatalog('Other/project');
    await setPage(`https://github.com/${repo}/issues/1`, 'host-a', 'Other/project');
    expect(JSON.stringify(renderer.toJSON())).toContain('Inspect issue 1');
    expect(links()).toHaveLength(0); // foreign evidence cannot navigate a different selected repo
    expect(JSON.stringify(renderer.toJSON())).not.toContain(safeMessage);
    for (const invalidRepo of ['owner/..', 'owner/.', 'owner/name/extra', 'owner%2fname/repo', 'owner/repo\n', '/repo', 'owner/', '-owner/repo', 'é/repo']) {
      await setCatalog(invalidRepo); await setPage(`https://github.com/${invalidRepo}/issues/1`, 'host-a', invalidRepo);
      expect(JSON.stringify(renderer.toJSON())).toContain('Inspect issue 1');
      expect(links()).toHaveLength(0);
    }
    await setCatalog(repo, 'invalid_config');
    expect(links()).toHaveLength(0);
    await setCatalog(repo);
    await setPage(`https://github.com/${repo}/issues/1`);
    expect(link('issue', 1)).not.toBe(oldControl);
    expect(JSON.stringify(renderer.toJSON())).not.toContain(safeMessage);
    // Reused deployment/issue IDs on a different host/repo: activate ONLY newly mounted control.
    const originalHosts = host.hosts;
    host.hosts = [{ serverId: 'host-b', label: 'Host B', status: 'online' }];
    cleanups.push(() => { host.hosts = originalHosts; });
    host.readCatalog.mockResolvedValue(catalog('Other/project'));
    await rerender({ ...screenProps, host: { ...screenProps.host, id: 'host-b' } });
    expect(links()).toHaveLength(0);
    await setPage('https://github.com/Other/project/issues/1', 'host-b', 'Other/project');
    expect(JSON.stringify(renderer.toJSON())).toContain('Inspect issue 1');
    const newControl = link('issue', 1, 'Other/project');
    expect(newControl).toBeDefined(); expect(newControl).not.toBe(oldControl);
    expect(JSON.stringify(renderer.toJSON())).not.toContain(safeMessage);
    const beforeNewOpen = rpcCounts();
    await act(async () => newControl.props.onPress());
    expect(host.openExternalUrl).toHaveBeenLastCalledWith('https://github.com/Other/project/issues/1');
    expect(rpcCounts()).toEqual(beforeNewOpen);
    expect(host.openExternalUrl).toHaveBeenCalledTimes(5); // no render/selection/error-handler navigation
    // SDK does not revoke retained callbacks or cancel already-dispatched opens; no such claim here.
    for (const text of renderer.root.findAllByType('Text' as any)) expect(text.props.style.color).toBe('#eee');
  });
  it('opens safe selected repository, groups lifecycle evidence, paginates and inspects dependency/report uncertainty', async () => {
    vi.useFakeTimers();
    const f = fakeReader();
    f.process.mockImplementation(async (_id, op) => {
      if (op.kind !== 'gh-api-get') throw new Error('unexpected operation');
      if (op.resource === 'issues') return response(op.page === 1 ? Array.from({ length: 100 }, (_, i) => ({ ...rest.issue, number: i + 1 })) : [{ ...rest.issue, number: 101 }]);
      if (op.resource === 'issue') return response(rest.issue);
      if (op.resource === 'comments') return response([comment(1, `${marker()}\n${block('progress', reports.progress)}\n\nPROSE_CANARY`)]);
      if (op.resource === 'dependencies') return response({}, 404);
      return response([]);
    });
    host.readCatalog.mockResolvedValue({ state: 'configured', entries: [{ id: 'demo', label: 'Demo', repo, adapter: 'orbi-0.7.41-release', status: 'available', problems: [] }, { id: 'rejected', label: 'Rejected', repo: 'Other/repo', status: 'invalid_config', problems: [{ source: 'config', code: 'config_mismatch' }] }], problems: [] });
    host.readIssues.mockImplementation(input => f.reader.listIssues(input.deploymentId, input.page));
    host.readIssue.mockImplementation(input => f.reader.getIssue(input.deploymentId, input.issue));
    const { renderer, settle } = await renderIssues();
    let visible = JSON.stringify(renderer.toJSON());
    expect(visible).toContain('Blocked'); expect(visible).toContain('conflicting lifecycle labels');
    expect(visible).toContain('does not promise pickup'); expect(visible).toContain('Page ');
    expect(visible).toContain('config_mismatch');
    expect(renderer.root.findAll(node => node.props.accessibilityLabel === 'Select Rejected')).toHaveLength(0);
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Inspect issue 4' }).props.onPress()); await settle(); await settle();
    visible = JSON.stringify(renderer.toJSON());
    expect(visible).toContain('unknown / incomplete or unavailable'); expect(visible).toContain('Reported run: '); expect(visible).toContain(run);
    expect(visible).not.toMatch(/TARGET_CANARY|PROSE_CANARY|BODY_CANARY/);
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Next page' }).props.onPress()); await settle(); await settle();
    expect(JSON.stringify(renderer.toJSON())).toContain('#');
    expect(host.readIssues).toHaveBeenCalledWith({ deploymentId: 'demo', page: 2 });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Next page' }).props.disabled).toBe(true);
    for (const text of renderer.root.findAllByType('Text' as any)) expect(text.props.style.color).toBe('#eee');
  });
  it('names comment authentication failure on the selected issue and repairs it through detail Refresh', async () => {
    vi.useFakeTimers();
    const f = fakeReader();
    let denyComments = true;
    f.process.mockImplementation(async (_id, op) => {
      if (op.kind !== 'gh-api-get') throw new Error('unexpected operation');
      if (op.resource === 'issues') return response([rest.issue]);
      if (op.resource === 'issue') return response(rest.issue);
      if (op.resource === 'comments') return denyComments ? response({}, 401) : response([comment(1, `${marker()}\n${block('progress', reports.progress)}`)]);
      return response([]);
    });
    host.readCatalog.mockResolvedValue({ state: 'configured', entries: [{ id: 'demo', label: 'Demo', repo, status: 'available', problems: [] }], problems: [] });
    host.readIssues.mockImplementation(input => f.reader.listIssues(input.deploymentId, input.page));
    host.readIssue.mockImplementation(input => f.reader.getIssue(input.deploymentId, input.issue));
    const { renderer, settle } = await renderIssues();
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Inspect issue 4' }).props.onPress()); await settle(); await settle();
    expect(JSON.stringify(renderer.toJSON())).toContain('auth_denied');
    expect(JSON.stringify(renderer.toJSON())).toContain("daemon user's existing gh authentication");
    expect(JSON.stringify(renderer.toJSON())).toContain('incomplete — current run not established');
    f.advance(); denyComments = false;
    await act(async () => renderer.root.findByProps({ testID: 'orbi-issues' }).findByProps({ accessibilityLabel: 'Refresh selected issue' }).props.onPress()); await settle(); await settle();
    expect(JSON.stringify(renderer.toJSON())).not.toContain('auth_denied\"');
    expect(JSON.stringify(renderer.toJSON())).toContain(run);
    expect((await f.reader.readIssueReports('demo', 4)).problems).toEqual([]);
  });
  it('shows concrete auth repair with no empty success, then Refresh repairs the actual read path', async () => {
    vi.useFakeTimers();
    const f = fakeReader(); f.process.mockResolvedValue(response({}, 401));
    host.readCatalog.mockResolvedValue({ state: 'configured', entries: [{ id: 'demo', label: 'Demo', repo, status: 'available', problems: [] }], problems: [] });
    host.readIssues.mockImplementation(input => f.reader.listIssues(input.deploymentId, input.page));
    const { renderer, settle } = await renderIssues();
    expect(JSON.stringify(renderer.toJSON())).toContain('auth_denied');
    expect(JSON.stringify(renderer.toJSON())).toContain("daemon user's existing gh authentication");
    expect(JSON.stringify(renderer.toJSON())).not.toContain('No issues on this observed page');
    f.advance(); f.process.mockResolvedValue(response([rest.issue]));
    await act(async () => renderer.root.findByProps({ testID: 'orbi-issues' }).findByProps({ accessibilityLabel: 'Refresh issue page' }).props.onPress()); await settle(); await settle();
    expect(JSON.stringify(renderer.toJSON())).toContain('Browse issue evidence');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Inspect issue 4' })).toBeDefined();
  });
});

it('looks_up_an_issue_number_without_changing_browse_rows_or_page_limit', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-11-14T23:00:00Z');
  const catalog = { state: 'configured', entries: [{ id: 'demo', label: 'Demo', repo, status: 'available', problems: [] }], problems: [] };
  const record = (number: number, title: string) => ({ number, title, url: `https://github.com/${repo}/issues/${number}`,
    githubState: 'open' as const, updatedAt: '2026-10-15T06:20:00Z', labels: ['ai-blocked'], ...classifyIssue('open', ['ai-blocked']) });
  const pageFor = (page: number) => issuesList.output.parse({ state: 'available', observedAt: '2026-11-14T23:00:00Z', lastSuccessfulAt: '2026-11-14T23:00:00Z', problems: [],
    data: { repo, page, hasNextPage: true, dependencyStatus: 'unknown', records: [record(page, `PAGE_${page}_TITLE`)] } });
  const detailFor = (number: number, title: string) => issuesGet.output.parse({ state: 'available', observedAt: '2026-11-14T23:00:00Z', lastSuccessfulAt: '2026-11-14T23:00:00Z', problems: [],
    data: { issue: record(number, title),
      reports: selectReports(repo, number, [comment(1, `${marker()}\n${block('progress', reports.progress)}`)], ['runner'], true),
      dependencies: { complete: true, observedAt: '2026-11-14T23:00:00Z', records: [], problems: [] }, mergeEvidence: 'unknown' } });
  host.readCatalog.mockResolvedValue(catalog);
  host.readIssues.mockReset().mockImplementation(async input => pageFor(input.page));
  host.readIssue.mockReset();
  host.readIssue.mockImplementation(async input => input.issue === 999 ? Promise.reject(new Error('NETWORK_SECRET')) : detailFor(input.issue, `DETAIL_${input.issue}_TITLE`));
  const { renderer, settle } = await renderIssues();
  const press = async (label: string) => { await act(async () => renderer.root.findByProps({ accessibilityLabel: label }).props.onPress()); await settle(); await settle(); };
  const input = () => renderer.root.findByProps({ accessibilityLabel: 'Issue number to inspect' });
  const inspect = () => renderer.root.findByProps({ accessibilityLabel: 'Inspect issue by number' });
  const setInput = async (value: string) => { await act(async () => input().props.onChangeText(value)); await settle(); };
  const text = () => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
  const pageRows = () => renderer.root.findAll(node => typeof node.props.accessibilityLabel === 'string' && /^Inspect issue \d+$/.test(node.props.accessibilityLabel)).map(node => node.props.accessibilityLabel);
  const selectedRows = () => renderer.root.findAll(node => typeof node.props.accessibilityLabel === 'string' && /^Inspect issue \d+$/.test(node.props.accessibilityLabel) && node.props.accessibilityState?.selected === true).map(node => node.props.accessibilityLabel);
  for (let index = 0; index < 9; index++) await press('Next page');
  expect(text()).toContain('Safety page limit reached; historical scope is incomplete.');
  expect(pageRows()).toEqual(['Inspect issue 10']);
  // Invalid numbers disable the control and never issue a read, even if activated.
  for (const value of ['', '0', '007', '-1', '4.5', 'abc', String(Number.MAX_SAFE_INTEGER + 1)]) {
    await setInput(value);
    expect(inspect().props.disabled).toBe(true);
    const before = host.readIssue.mock.calls.length;
    await act(async () => inspect().props.onPress()); await settle();
    expect(host.readIssue).toHaveBeenCalledTimes(before);
  }
  await setInput('10');
  expect(inspect().props.disabled).toBe(false);
  await press('Inspect issue 10');
  const rowDetail = text();
  expect(rowDetail).toContain('Example/project#10');
  expect(selectedRows()).toEqual(['Inspect issue 10']); // the listed row owns the inline panel
  // A listed issue renders the same detail through the lookup as through its row.
  await setInput('11');
  await press('Inspect issue by number');
  expect(host.readIssue).toHaveBeenLastCalledWith({ deploymentId: 'demo', issue: 11 });
  expect(text()).toContain('Issue #11 — detail read by number; not a browse-page membership claim.');
  expect(text()).toContain('Example/project#11');
  expect(selectedRows()).toEqual([]); // an absent number marks no row as selected
  expect(pageRows()).toEqual(['Inspect issue 10']);
  expect(text()).toContain('Safety page limit reached; historical scope is incomplete.');
  // A failed lookup keeps the unavailable observation and its problem code, never stale evidence.
  await setInput('999');
  await press('Inspect issue by number');
  expect(host.readIssue).toHaveBeenLastCalledWith({ deploymentId: 'demo', issue: 999 });
  expect(text()).toContain('refresh_failed');
  expect(text()).not.toContain('Example/project#11');
  expect(text()).not.toContain('NETWORK_SECRET');
  expect(selectedRows()).toEqual([]);
  expect(pageRows()).toEqual(['Inspect issue 10']);
  expect(text()).toContain('Safety page limit reached; historical scope is incomplete.');
  await setInput('10');
  await press('Inspect issue by number');
  expect(text()).toBe(rowDetail);
});

it('places_the_selected_issue_detail_beside_its_row_on_a_full_page', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-11-14T23:00:00Z');
  const catalog = { state: 'configured', entries: [{ id: 'demo', label: 'Demo', repo, status: 'available', problems: [] }], problems: [] };
  const record = (number: number) => ({ number, title: `ROW_${number}_TITLE`, url: `https://github.com/${repo}/issues/${number}`,
    githubState: 'open' as const, updatedAt: '2026-10-15T06:20:00Z', labels: ['ai-blocked'], ...classifyIssue('open', ['ai-blocked']) });
  const detailFor = (number: number) => issuesGet.output.parse({ state: 'available', observedAt: '2026-11-14T23:00:00Z', lastSuccessfulAt: '2026-11-14T23:00:00Z', problems: [],
    data: { issue: record(number),
      reports: selectReports(repo, number, [comment(1, `${marker()}\n${block('progress', reports.progress)}`)], ['runner'], true),
      dependencies: { complete: true, observedAt: '2026-11-14T23:00:00Z', records: [], problems: [] }, mergeEvidence: 'unknown' } });
  const listKey = ['paseo-orbi', 'host-a', 'demo', `issues.list:${repo}:1`];
  host.readCatalog.mockResolvedValue(catalog);
  host.readIssues.mockReset().mockResolvedValue(issuesList.output.parse({ state: 'available', observedAt: '2026-11-14T23:00:00Z', lastSuccessfulAt: '2026-11-14T23:00:00Z', problems: [],
    data: { repo, page: 1, hasNextPage: true, dependencyStatus: 'unknown', records: Array.from({ length: 100 }, (_, index) => record(index + 1)) } }));
  host.readIssue.mockReset().mockImplementation(async input => detailFor(input.issue));
  const { renderer, settle, client } = await renderIssues();
  const press = async (label: string) => { await act(async () => renderer.root.findByProps({ accessibilityLabel: label }).props.onPress()); await settle(); await settle(); };
  const setInput = async (value: string) => { await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Issue number to inspect' }).props.onChangeText(value)); await settle(); };
  const lines = () => renderer.root.findAllByType('Text' as any).map(node => node.children.join(''));
  const index = (line: string) => lines().indexOf(line);
  const rows = () => renderer.root.findAll(node => typeof node.props.accessibilityLabel === 'string' && /^Inspect issue \d+$/.test(node.props.accessibilityLabel));
  const selectedRows = () => rows().filter(node => node.props.accessibilityState?.selected === true).map(node => node.props.accessibilityLabel);
  const detailLine = (number: number) => `#${number}: Blocked — ai-blocked (github)`;
  const refreshes = () => renderer.root.findByProps({ testID: 'orbi-issues' }).findAll(node => typeof node.props.accessibilityLabel === 'string' && /^Refresh /.test(node.props.accessibilityLabel));
  const absentHeader = 'Issue #999 — detail read by number; not a browse-page membership claim.';
  expect(rows()).toHaveLength(100);
  expect(selectedRows()).toEqual([]);
  expect(refreshes().map(node => node.props.accessibilityLabel)).toEqual(['Refresh issue page']); // no stale detail control before selection
  await press('Inspect issue 1');
  // Exactly one detail, directly after its own row: after row 1, before row 2 and the pager.
  expect(lines().filter(line => line === detailLine(1))).toHaveLength(1);
  expect(index('Selected; detail below this row.')).toBeGreaterThan(index('#1 ROW_1_TITLE — ai-blocked (github)'));
  expect(index(detailLine(1))).toBeGreaterThan(index('#1 ROW_1_TITLE — ai-blocked (github)'));
  expect(index(detailLine(1))).toBeLessThan(index('#2 ROW_2_TITLE — ai-blocked (github)'));
  expect(index(detailLine(1))).toBeLessThan(index('Previous page'));
  expect(selectedRows()).toEqual(['Inspect issue 1']);
  // Both controls still say Refresh but expose distinguishable accessible labels.
  expect(refreshes().map(node => node.props.accessibilityLabel).sort()).toEqual(['Refresh issue page', 'Refresh selected issue']);
  for (const control of refreshes()) {
    expect(control.props.accessibilityRole).toBe('button');
    expect(control.findByType('Text' as any).children).toEqual(['Refresh']);
  }
  // Selecting another row moves the one panel and the selected state; nothing is left behind.
  await press('Inspect issue 2');
  expect(lines().filter(line => line === detailLine(2))).toHaveLength(1);
  expect(lines()).not.toContain(detailLine(1));
  expect(index(detailLine(2))).toBeLessThan(index('#3 ROW_3_TITLE — ai-blocked (github)'));
  expect(renderer.root.findByProps({ accessibilityLabel: 'Inspect issue 1' }).props.accessibilityState).toEqual({ selected: false });
  expect(renderer.root.findByProps({ accessibilityLabel: 'Inspect issue 2' }).props.accessibilityState).toEqual({ selected: true });
  expect(selectedRows()).toEqual(['Inspect issue 2']);
  // A number absent from the page keeps one result beside the field, with no row selected.
  await setInput('999'); await press('Inspect issue by number');
  expect(index(absentHeader)).toBeGreaterThan(-1);
  expect(index(absentHeader)).toBeLessThan(index(`${repo} — Page 1. This displayed page is not the complete active scope.`));
  expect(lines().some(line => line.includes('Example/project#999'))).toBe(true);
  expect(lines()).not.toContain(detailLine(2));
  expect(selectedRows()).toEqual([]);
  expect(rows()).toHaveLength(100);
  // That result is not hidden behind a readable list: an unavailable page keeps it visible.
  await act(async () => { client.setQueryData(listKey, issuesList.output.parse({ state: 'unavailable', observedAt: '2026-11-14T23:00:00Z', lastSuccessfulAt: null,
    problems: [{ source: 'github', code: 'auth_denied' }], data: null })); }); await settle();
  expect(lines()).toContain(absentHeader);
  expect(lines().some(line => line.includes('Example/project#999'))).toBe(true);
  expect(rows()).toHaveLength(0);
  expect(selectedRows()).toEqual([]);
});

it('ignores a late detail response for a previous issue number', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-11-14T23:00:00Z');
  const catalog = { state: 'configured', entries: [{ id: 'demo', label: 'Demo', repo, status: 'available', problems: [] }], problems: [] };
  const record = (number: number, title: string) => ({ number, title, url: `https://github.com/${repo}/issues/${number}`,
    githubState: 'open' as const, updatedAt: '2026-10-15T06:20:00Z', labels: ['ai-blocked'], ...classifyIssue('open', ['ai-blocked']) });
  const detailFor = (number: number, title: string) => issuesGet.output.parse({ state: 'available', observedAt: '2026-11-14T23:00:00Z', lastSuccessfulAt: '2026-11-14T23:00:00Z', problems: [],
    data: { issue: record(number, title),
      reports: selectReports(repo, number, [comment(1, `${marker()}\n${block('progress', reports.progress)}`)], ['runner'], true),
      dependencies: { complete: true, observedAt: '2026-11-14T23:00:00Z', records: [], problems: [] }, mergeEvidence: 'unknown' } });
  host.readCatalog.mockResolvedValue(catalog);
  host.readIssues.mockReset().mockResolvedValue(issuesList.output.parse({ state: 'available', observedAt: '2026-11-14T23:00:00Z', lastSuccessfulAt: '2026-11-14T23:00:00Z', problems: [],
    data: { repo, page: 1, hasNextPage: false, dependencyStatus: 'unknown', records: [record(4, 'ROW_FOUR_TITLE')] } }));
  host.readIssue.mockReset();
  let finishFour!: (value: unknown) => void;
  host.readIssue.mockImplementationOnce(() => new Promise(resolve => { finishFour = resolve; })).mockResolvedValueOnce(detailFor(5, 'DETAIL_FIVE_TITLE'));
  const { renderer, settle } = await renderIssues();
  const setInput = async (value: string) => { await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Issue number to inspect' }).props.onChangeText(value)); await settle(); };
  const inspect = async () => { await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Inspect issue by number' }).props.onPress()); await settle(); await settle(); };
  const text = () => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
  await setInput('4'); await inspect();
  await setInput('5'); await inspect();
  expect(text()).toContain('Example/project#5');
  await act(async () => finishFour(detailFor(4, 'LATE_FOUR_TITLE'))); await settle(); await settle();
  expect(text()).toContain('Example/project#5');
  expect(text()).not.toContain('Example/project#4');
});

it('repository_change_separates_pending_lists_details_and_late_reads', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-11-14T23:00:00Z');
  const f = fakeReader();
  f.process.mockImplementation(async (_id, op) => {
    if (op.kind !== 'gh-api-get') throw new Error('unexpected operation');
    if (op.resource === 'issues') return response([rest.issue]);
    if (op.resource === 'issue') return response(rest.issue);
    if (op.resource === 'comments') return response([comment(1, `${marker()}\n${block('progress', reports.progress)}`)]);
    return response([]);
  });
  const aPage = issuesList.output.parse(await f.reader.listIssues('demo', 1));
  const aDetail = issuesGet.output.parse(await f.reader.getIssue('demo', 4));
  aPage.data!.records[0].title = 'A_ISSUE_TITLE'; aDetail.data!.issue.title = 'A_ISSUE_TITLE';
  aDetail.data!.reports.selectedRunId = 'aaaaaaaa';
  const bPage = issuesList.output.parse({ ...aPage, data: { ...aPage.data!, repo: 'Reassigned/project', records: [
    { ...aPage.data!.records[0], title: 'B_ISSUE_TITLE', url: 'https://github.com/Reassigned/project/issues/4' },
  ] } });
  const bIdentity = JSON.parse(JSON.stringify(aDetail).replaceAll(repo, 'Reassigned/project'));
  const bDetail = issuesGet.output.parse({ ...bIdentity, data: { ...bIdentity.data, issue: bPage.data!.records[0],
    reports: { ...bIdentity.data.reports, selectedRunId: 'bbbbbbbb' } } });
  const catalog = (repo: string) => ({ state: 'configured', entries: [{ id: 'demo', label: 'Demo', repo, status: 'available', problems: [] }], problems: [] });
  host.readCatalog.mockResolvedValue(catalog(repo)); host.readIssues.mockReset().mockResolvedValue(aPage); host.readIssue.mockReset().mockResolvedValue(aDetail);
  const { renderer, settle, client } = await renderIssues();
  const text = () => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
  const press = async (label: string) => { await act(async () => renderer.root.findByProps({ accessibilityLabel: label }).props.onPress()); await settle(); await settle(); };
  await press('Inspect issue 4');
  expect(text()).toContain('A_ISSUE_TITLE'); expect(text()).toContain('Reported run: aaaaaaaa');
  let finishA!: (value: unknown) => void;
  host.readIssue.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; }));
  await act(async () => { renderer.root.findByProps({ testID: 'orbi-issues' }).findByProps({ accessibilityLabel: 'Refresh selected issue' }).props.onPress(); }); await settle();
  let finishList!: (value: unknown) => void, rejectDetail!: (error: Error) => void;
  host.readIssues.mockImplementationOnce(() => new Promise(resolve => { finishList = resolve; }));
  host.readIssue.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectDetail = reject; }));
  await act(async () => { client.setQueryData(['paseo-orbi', 'host-a', 'catalog', 'deployments.list'], {
    state: 'available', observedAt: new Date().toISOString(), lastSuccessfulAt: new Date().toISOString(), problems: [], data: catalog('Reassigned/project'),
  }); }); await settle(); await settle();
  expect(host.readIssues).toHaveBeenCalledTimes(2);
  expect(host.readIssues).toHaveBeenLastCalledWith(issuesList.input.parse({ deploymentId: 'demo', page: 1 }));
  expect(text()).toContain('Loading'); expect(text()).not.toContain('A_ISSUE_TITLE'); expect(text()).not.toContain('aaaaaaaa');
  expect(renderer.root.findAll(node => node.type === ('ExternalLink' as any))).toHaveLength(0);
  await act(async () => finishList(bPage)); await settle(); await settle();
  expect(text()).toContain('B_ISSUE_TITLE');
  await press('Inspect issue 4');
  // B must start even while A's same-issue transport is still pending.
  expect(host.readIssue).toHaveBeenCalledTimes(3);
  expect(host.readIssue).toHaveBeenLastCalledWith(issuesGet.input.parse({ deploymentId: 'demo', issue: 4 }));
  expect(text()).not.toContain('aaaaaaaa');
  await act(async () => finishA({ ...aDetail, data: { ...aDetail.data!, reports: { ...aDetail.data!.reports, selectedRunId: 'deadbeef' } } })); await settle();
  expect(text()).not.toContain('deadbeef'); expect(text()).not.toContain('A_ISSUE_TITLE');
  expect(client.getQueryData(['paseo-orbi', 'host-a', 'demo', `issues.get:${repo}:4`])).toEqual(aDetail);
  await act(async () => rejectDetail(new Error('transport unavailable'))); await settle();
  expect(text()).toContain('unavailable'); expect(text()).toContain('refresh_failed'); expect(text()).not.toContain('aaaaaaaa');
  const refreshDetail = async () => { await act(async () => { await renderer.root.findByProps({ testID: 'orbi-issues' }).findByProps({ accessibilityLabel: 'Refresh selected issue' }).props.onPress(); }); await settle(); };
  host.readIssue.mockResolvedValue(bDetail); await refreshDetail();
  expect(text()).toContain('Reported run: bbbbbbbb');
  expect(text()).not.toContain(`https://github.com/${repo}/`);
  host.readIssue.mockRejectedValue(new Error('transport unavailable')); await refreshDetail();
  expect(text()).toContain('stale'); expect(text()).toContain('Reported run: bbbbbbbb'); expect(text()).not.toContain('aaaaaaaa');
  expect(renderer.root.findByProps({ accessibilityLabel: 'Open Reassigned/project issue 4 on GitHub' })).toBeDefined();
});

it('opens_a_complete_reported_run_in_runs_and_keeps_incomplete_reports_as_text', async () => {
  vi.useFakeTimers();
  const f = fakeReader();
  f.process.mockImplementation(async (_id, op) => {
    if (op.kind !== 'gh-api-get') throw new Error('unexpected operation');
    if (op.resource === 'issues') return response([rest.issue]);
    if (op.resource === 'issue') return response(rest.issue);
    if (op.resource === 'comments') return response([comment(1, `${marker()}\n${block('progress', reports.progress)}`)]);
    if (op.resource === 'dependencies') return response({}, 404);
    return response([]);
  });
  host.readCatalog.mockResolvedValue({ state: 'configured', entries: [{ id: 'demo', label: 'Demo', repo, status: 'available', problems: [] }], problems: [] });
  host.readIssues.mockImplementation(input => f.reader.listIssues(input.deploymentId, input.page));
  host.readIssue.mockImplementation(input => f.reader.getIssue(input.deploymentId, input.issue));
  const openScreen = vi.fn(), client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={client}><Shell {...screenProps} openScreen={openScreen} /></QueryClientProvider>); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); client.clear(); });
  const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2); }); };
  await settle(); await settle();
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Inspect issue 4' }).props.onPress()); await settle(); await settle();
  const controls = () => renderer.root.findAll(node => node.props.accessibilityLabel === `Inspect run ${run} in Runs`);
  const text = () => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
  expect(controls()).toHaveLength(1);
  expect(controls()[0].props.accessibilityRole).toBe('button');
  expect(text()).toContain(`Reported run: ${run}; reports complete`);
  const reads = () => [host.readCatalog.mock.calls.length, host.readIssues.mock.calls.length, host.readIssue.mock.calls.length, f.process.mock.calls.length];
  const beforeOpen = reads();
  await act(async () => controls()[0].props.onPress()); await settle();
  expect(openScreen).toHaveBeenCalledWith({ screenId: 'runs', params: { deploymentId: 'demo', issue: '4', runId: run } });
  expect(host.readRun).not.toHaveBeenCalled(); // navigation adds no read of its own
  expect(reads()).toEqual(beforeOpen);
  // Incomplete or unestablished reports keep the existing plain wording and no control.
  const key = ['paseo-orbi', 'host-a', 'demo', `issues.get:${repo}:4`];
  const detail = issuesGet.output.parse(client.getQueryData(key));
  const setReports = async (reports: object) => {
    await act(async () => { client.setQueryData(key, issuesGet.output.parse({ ...detail, data: { ...detail.data!, reports } })); });
    await settle();
  };
  await setReports({ ...detail.data!.reports, complete: false, selectedRunId: null });
  expect(controls()).toHaveLength(0);
  expect(text()).toContain('Reported run: unknown; reports incomplete — current run not established; retained evidence may be stale');
  await setReports({ ...detail.data!.reports, complete: false, selectedRunId: run });
  expect(controls()).toHaveLength(0);
  expect(text()).toContain(`Reported run: ${run}; reports incomplete — current run not established; retained evidence may be stale`);
  await setReports({ ...detail.data!.reports, complete: true, selectedRunId: null });
  expect(controls()).toHaveLength(0);
  expect(text()).toContain('Reported run: unknown; reports complete');
  expect(openScreen).toHaveBeenCalledTimes(1);
});

it('renders recorded base-CI, scene round and receipt values only while their status is available', async () => {
  vi.useFakeTimers();
  const f = fakeReader();
  const comments = [
    comment(1, `${marker()}\n${kind('failure')}\n${block('failure', reports.failure)}\n${block('base-ci-red', reports.baseCi)}`),
    comment(2, `${marker()}\n${kind('review-round')}\n${block('scene', reports.scene)}`),
    comment(3, `${marker()}\n${kind('merged')}\nReadable merged PROSE_CANARY\n\n${reports.receipt}`),
  ];
  f.process.mockImplementation(async (_id, op) => {
    if (op.kind !== 'gh-api-get') throw new Error('unexpected operation');
    if (op.resource === 'issues') return response([rest.issue]);
    if (op.resource === 'issue') return response(rest.issue);
    if (op.resource === 'comments') return response(comments);
    if (op.resource === 'pull') return response({ ...rest.pull, merged_at: null });
    if (op.resource === 'checks') return response(rest.checks);
    return response([]);
  });
  host.readCatalog.mockResolvedValue({ state: 'configured', entries: [{ id: 'demo', label: 'Demo', repo, status: 'available', problems: [] }], problems: [] });
  host.readIssues.mockImplementation(input => f.reader.listIssues(input.deploymentId, input.page));
  host.readIssue.mockImplementation(input => f.reader.getIssue(input.deploymentId, input.issue));
  const { renderer, settle, client } = await renderIssues();
  const text = () => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Inspect issue 4' }).props.onPress()); await settle(); await settle();
  const reads = () => [host.readCatalog.mock.calls.length, host.readIssues.mock.calls.length, host.readIssue.mock.calls.length, f.process.mock.calls.length];
  const before = reads();
  // The validated base-CI, scene and receipt values arrive in issues.get and are rendered from there.
  expect(text()).toContain('Base CI: waiting; PR #42');
  expect(text()).toContain(waitGuidance('waiting'));
  expect(text()).toContain('Scene review_round: 2');
  expect(text()).toContain(`Reported receipt: merge_commit ${'b'.repeat(40)}; review_rounds 2; commits 3; external_commits 0; run_id ${run}`);
  expect(text()).toContain('Merge evidence: reported. Receipts and labels alone do not verify a merge.');
  expect(text()).toContain(`mergedReceipt: ${repo}#4`);
  // No check names, check output or transported prose from any report source.
  expect(text()).not.toMatch(/typecheck|PROSE_CANARY|TARGET_CANARY|OUTPUT_CANARY/);
  expect(reads()).toEqual(before);
  const key = ['paseo-orbi', 'host-a', 'demo', `issues.get:${repo}:4`];
  const detail = issuesGet.output.parse(client.getQueryData(key));
  const setReports = async (value: object) => {
    await act(async () => { client.setQueryData(key, issuesGet.output.parse({ ...detail, data: { ...detail.data!, reports: value } })); });
    await settle();
  };
  const attr = detail.data!.reports.attribution!;
  const noReceiptValues = () => {
    expect(text()).not.toContain('merge_commit');
    expect(text()).not.toContain('commits');
    expect(text()).not.toContain('run_id');
  };
  const noValues = () => {
    expect(text()).not.toContain('Base CI: waiting');
    expect(text()).not.toContain(waitGuidance('waiting'));
    expect(text()).not.toContain('review_round');
    noReceiptValues();
  };
  for (const status of ['missing', 'invalid', 'unsupported'] as const) {
    await setReports({ ...detail.data!.reports,
      baseCi: { status, attribution: status === 'missing' ? null : attr },
      scene: { status, attribution: status === 'missing' ? null : attr },
      mergedReceipt: { status, attribution: status === 'missing' ? null : attr } });
    expect(text()).toContain(`Scene: ${status}; Base CI: ${status}; Receipt: ${status}`);
    noValues(); // status only: no values and no fabricated zeros
  }
  // A valid scene cannot lend values to a malformed receipt (and vice versa).
  await setReports({ ...detail.data!.reports, mergedReceipt: { status: 'invalid', attribution: attr } });
  expect(text()).toContain('Scene review_round: 2');
  expect(text()).toContain('Base CI: waiting; PR #42');
  expect(text()).toContain('Receipt: invalid');
  noReceiptValues(); // a malformed receipt cannot borrow the valid scene's values
  expect(text()).toContain('mergedReceipt: Example/project#4');
  expect(reads()).toEqual(before);
  expect(JSON.stringify(renderer.toJSON())).not.toMatch(/PROSE_CANARY|TARGET_CANARY/);
});
