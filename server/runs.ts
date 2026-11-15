import { z } from 'zod';
import { Problem, type Observation } from '../shared/common';
import type { IssueSummary, ReportSelection } from '../shared/issues';
import { RunId, type RunSummary, type RunDetails, type SessionActivity } from '../shared/runs';
import type { ConfigRepository } from './config';
import type { GitHubReader, PullRequestEvidence } from './github';
import { ReadError, type ReadPorts } from './read-ports';
import { projectEvents } from './events';

type Ports = Pick<ReadPorts, 'clock' | 'worktrees' | 'runState' | 'sessions' | 'sessionRange' | 'process'>;
type GitHub = Pick<GitHubReader, 'listIssueScope' | 'readIssueReports' | 'getPullRequestEvidence'>;
const problem = (error: unknown, source: Problem['source'] = 'filesystem'): Problem => {
  const parsed = Problem.safeParse({ source, code: error && typeof error === 'object' && 'code' in error ? error.code : 'invalid_response' });
  return parsed.success ? parsed.data : { source, code: 'invalid_response' };
};
const active = (issue: IssueSummary) => ['Implementing', 'Reviewing'].includes(issue.state) && issue.githubState === 'open';
const State = z.object({ repo: z.string(), issue: z.number().int().positive(), run_id: RunId, branch: z.string(), created_at: z.iso.datetime(), pushed_head: z.string().regex(/^[0-9a-f]{40}$/).optional(), reviewed_head: z.string().regex(/^[0-9a-f]{40}$/).optional() });
const iso = (value: unknown) => typeof value === 'string' && z.iso.datetime().safeParse(value).success ? value : null;
const emptyActivity = (): SessionActivity => ({ sessionId: null, state: 'unavailable', at: null, kind: null, problems: [] });
type SessionState = { identity: string; size: number; mtime: number; offset: number; activity: SessionActivity; header: string };

export class RunsReader {
  private scopes = new Map<string, { records: IssueSummary[]; at: string }>();
  private sessions = new Map<string, SessionState>();
  constructor(private readonly repository: Pick<ConfigRepository, 'resolve'>, private readonly ports: Ports, private readonly github: GitHub) {}
  private boundedRemember<T>(map: Map<string, T>, key: string, value: T, limit: number) {
    map.delete(key); map.set(key, value);
    if (map.size > limit) map.delete(map.keys().next().value!);
  }
  private observation<T>(data: T | null, problems: Problem[], stale = false, last: string | null = null): Observation<T> {
    const now = this.ports.clock().toISOString();
    problems = [...new Map(problems.map(p => [`${p.source}:${p.code}`, p])).values()];
    return { state: stale ? 'stale' : data === null ? 'unavailable' : problems.length ? 'partial' : 'available', observedAt: now, lastSuccessfulAt: stale ? last : problems.length ? null : now, data, problems };
  }
  private async activity(id: string, issue: number, runId: string, name: string): Promise<SessionActivity> {
    const key = JSON.stringify([id, this.repository.resolve(id).repo, issue, runId, name]);
    try {
      const header = await this.ports.sessionRange(id, issue, runId, name, 0, 65536);
      const newline = header.bytes.indexOf(10);
      if (newline < 0) throw new ReadError(header.size >= 65536 ? 'read_limit' : 'read_failed');
      const raw = JSON.parse(header.bytes.subarray(0, newline).toString('utf8'));
      if (raw.type !== 'session' || typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.id)) throw new ReadError('read_failed');
      const headerText = header.bytes.subarray(0, newline).toString('utf8');
      let previous = this.sessions.get(key);
      if (previous && (previous.identity !== header.identity || header.size < previous.size || previous.header !== headerText || (header.size === previous.size && header.mtimeMs !== previous.mtime))) previous = undefined;
      let activity: SessionActivity = previous ? structuredClone(previous.activity) : { ...emptyActivity(), sessionId: raw.id };
      const requested = previous?.offset ?? 0;
      const start = Math.max(requested, header.size - 262144);
      const chunk = await this.ports.sessionRange(id, issue, runId, name, start, 262144);
      if (chunk.identity !== header.identity || chunk.size !== header.size || chunk.mtimeMs !== header.mtimeMs) throw new ReadError('read_failed');
      let from = 0, end = chunk.bytes.lastIndexOf(10) + 1;
      if (start > requested) {
        activity.problems = [{ source: 'filesystem', code: 'incomplete' }];
        from = chunk.bytes.indexOf(10) + 1; // a tail can start inside a private record
      }
      if (end !== chunk.bytes.length) activity.problems.push({ source: 'filesystem', code: 'incomplete' });
      if (!from && start > requested) end = 0;
      let malformed = false;
      for (const line of chunk.bytes.subarray(from, end).toString('utf8').split('\n')) {
        if (!line) continue;
        if (Buffer.byteLength(line) > 65536) { malformed = true; activity.problems.push({ source: 'filesystem', code: 'read_limit' }); continue; }
        try {
          const record = JSON.parse(line);
          if (record.type === 'session' && record.id !== raw.id) { malformed = true; continue; }
          if (record.type !== 'message') continue;
          if (!record.message || typeof record.message !== 'object') { malformed = true; continue; }
          if (record.message.role !== 'assistant') continue;
          if (!Array.isArray(record.message.content)) { malformed = true; continue; }
          let kind: SessionActivity['kind'] = null;
          for (const item of record.message.content) {
            if (item?.type === 'text' || item?.type === 'thinking') kind = 'analysis';
            if (item?.type === 'toolCall') {
              const kinds: Record<string, SessionActivity['kind']> = { read: 'read', edit: 'edit', write: 'edit', bash: 'command', codemode: 'command' };
              if (Object.hasOwn(kinds, item.name)) kind = kinds[item.name];
            }
          }
          if (kind) {
            const at = iso(record.timestamp);
            if (!at) { malformed = true; continue; }
            if (!activity.at || at >= activity.at) { activity.at = at; activity.kind = kind; }
          }
        } catch { malformed = true; }
      }
      if (malformed) { activity.at = null; activity.kind = null; activity.problems.push({ source: 'filesystem', code: 'invalid_response' }); }
      activity.state = activity.at && activity.kind ? 'available' : 'unavailable';
      activity.problems = [...new Map(activity.problems.map(p => [p.code, p])).values()];
      this.boundedRemember(this.sessions, key, { identity: chunk.identity, size: chunk.size, mtime: chunk.mtimeMs, offset: end ? start + end : start, activity, header: headerText }, 3200);
      return activity;
    } catch (error) { this.sessions.delete(key); return { ...emptyActivity(), problems: [problem(error)] }; }
  }
  private async summary(id: string, issue: number, runId: string, membership: RunSummary['membership'], reports: ReportSelection, lifecycle: string | null): Promise<RunSummary> {
    const { repo } = this.repository.resolve(id);
    const selected = reports.selectedRunId === runId;
    const result: RunSummary = { deploymentId: id, repo, issue, runId, membership, lifecycle,
      stage: selected && reports.progress.status === 'available' ? reports.progress.data.step : null,
      failure: selected && reports.failure.status === 'available' ? reports.failure.data : null,
      branch: null, createdAt: null, pushedHead: null, reviewedHead: null, sessions: [], problems: [] };
    try {
      const state = State.parse(JSON.parse((await this.ports.runState(id, issue, runId)).toString('utf8')));
      const branch = `orbi/${repo.replace('/', '-')}-issue-${issue}`;
      if (state.repo !== repo || state.issue !== issue || state.run_id !== runId || (state.branch !== branch && state.branch !== `${branch}-${runId}`)) throw new ReadError('read_failed');
      result.branch = state.branch; result.createdAt = state.created_at; result.pushedHead = state.pushed_head ?? null; result.reviewedHead = state.reviewed_head ?? null;
      const names = await this.ports.sessions(id, issue, runId);
      for (const name of names) result.sessions.push(await this.activity(id, issue, runId, name));
      if (!names.length) result.problems.push({ source: 'filesystem', code: 'incomplete' });
    } catch (error) { result.problems.push(problem(error)); }
    result.problems.push(...result.sessions.flatMap(s => s.problems));
    return result;
  }
  async list(input: { deploymentId: string; issue?: number }): Promise<Observation<RunSummary[]>> {
    const id = input.deploymentId;
    const scopeKey = JSON.stringify([id, this.repository.resolve(id).repo]);
    const rows: RunSummary[] = [], problems: Problem[] = [];
    if (input.issue !== undefined) {
      const reports = await this.github.readIssueReports(id, input.issue);
      problems.push(...reports.problems);
      const runs = new Set<string>();
      try { for (const tree of await this.ports.worktrees(id, input.issue)) if (tree.issue === input.issue) runs.add(tree.runId); }
      catch (error) { problems.push(problem(error)); }
      if (reports.selectedRunId) runs.add(reports.selectedRunId);
      for (const run of [...runs].sort()) rows.push(await this.summary(id, input.issue, run, 'history', reports, null));
    } else {
      const scope = await this.github.listIssueScope(id);
      if (scope.complete) this.boundedRemember(this.scopes, scopeKey, { records: scope.records, at: scope.observedAt }, 16);
      const known = this.scopes.get(scopeKey);
      if (!known) return this.observation<RunSummary[]>(null, scope.problems.length ? scope.problems : [{ source: 'github', code: 'incomplete' }]);
      problems.push(...scope.problems);
      for (const issue of known.records.filter(active)) {
        const reports = await this.github.readIssueReports(id, issue.number);
        problems.push(...reports.problems);
        if (reports.selectedRunId) rows.push(await this.summary(id, issue.number, reports.selectedRunId, 'scope', reports, issue.state));
      }
      problems.push(...rows.flatMap(row => row.problems));
      return this.observation(rows, problems, !scope.complete, known.at);
    }
    problems.push(...rows.flatMap(row => row.problems));
    return this.observation(rows, problems);
  }
  private checks(pr: PullRequestEvidence): NonNullable<RunDetails['pr']>['checksState'] {
    if (!pr.checks.complete) return 'inaccessible';
    if (!pr.checks.records.length) return 'missing';
    if (pr.checks.records.some(c => !c.head_sha)) return 'missing';
    if (pr.checks.records.some(c => c.head_sha !== pr.head)) return 'stale_head';
    if (pr.checks.records.some(c => c.status !== 'completed' || c.conclusion === null)) return 'pending';
    return pr.checks.records.every(c => c.conclusion === 'success') ? 'passed' : 'failed';
  }
  async read(input: { deploymentId: string; issue: number; runId: string }): Promise<Observation<RunDetails>> {
    const { deploymentId: id, issue, runId } = input, deployment = this.repository.resolve(id);
    if (!RunId.safeParse(runId).success || !Number.isSafeInteger(issue) || issue < 1) throw new ReadError('unsafe_path');
    const reports = await this.github.readIssueReports(id, issue);
    const summary = await this.summary(id, issue, runId, 'history', reports, null);
    const problems = [...reports.problems, ...summary.problems];
    const prIdentity = reports.selectedRunId === runId ? reports.prIdentity : { status: 'missing' as const };
    const data: RunDetails = { summary, prIdentity, pr: null, events: [] };
    if (prIdentity.status === 'available') {
      if (prIdentity.runId !== runId || prIdentity.url !== `https://github.com/${deployment.repo}/pull/${prIdentity.number}`) data.prIdentity = { status: 'invalid' };
      else try {
        const pr = await this.github.getPullRequestEvidence(id, prIdentity.number);
        data.pr = { number: pr.number, url: pr.url, state: pr.state, merged_at: pr.mergedAt, head: { sha: pr.head }, checksState: this.checks(pr),
          checks: pr.checks.records.filter(c => c.head_sha === pr.head).map(c => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url ?? null })) };
        problems.push(...pr.checks.problems);
      } catch (error) { problems.push(problem(error, 'github')); }
    }
    for (let slot = 1; slot <= deployment.capacity; slot++) {
      const prefix = deployment.unitName === null ? 'orbi' : `orbi-${deployment.unitName}`;
      try {
        const projected = projectEvents(await this.ports.process(id, { kind: 'journalctl', slot }), { unit: `${prefix}@${slot}.service`, repo: deployment.repo, issue, runId, retained: deployment.sourceProfile === 'orbi-0.7.41-1a8b2f96' });
        data.events.push(...projected.events); problems.push(...projected.problems);
      } catch (error) { problems.push(problem(error, 'journal')); }
    }
    data.events.sort((a, b) => a.at.localeCompare(b.at));
    if (data.events.length > 200) { data.events = data.events.slice(0, 200); problems.push({ source: 'journal', code: 'read_limit' }); }
    return this.observation(data, problems);
  }
}
