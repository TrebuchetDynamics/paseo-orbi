import { z } from 'zod';
import type { Observation, Problem } from '../shared/common';
import { classifyIssue, type CompleteCollection, type IssueSummary, type IssuePage, type IssueDetail, type ReportSelection } from '../shared/issues';
import type { ConfigRepository } from './config';
import { ReadError, type ReadPorts, type ProcessOperation } from './read-ports';
import { Comment, selectReports } from './reports';

const positive = z.number().int().positive();
const RawIssue = z.object({ number: positive, title: z.string().max(1024), state: z.enum(['open', 'closed']), updated_at: z.iso.datetime(), labels: z.array(z.object({ name: z.string().max(100) })), pull_request: z.unknown().optional() });
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const Pull = z.object({ number: positive, html_url: z.string(), merged_at: z.iso.datetime().nullable(), state: z.enum(['open', 'closed']), head: z.object({ sha }), base: z.object({ repo: z.object({ full_name: z.string() }) }) });
const Check = z.object({ head_sha: sha.optional(), html_url: z.string().nullable().optional(), id: positive, name: z.string().max(1024), status: z.enum(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']), conclusion: z.enum(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure']).nullable() });
export type PullRequestEvidence = { number: number; url: string; head: string; state: 'open' | 'closed'; mergedAt: string | null; checks: CompleteCollection<z.infer<typeof Check>> };
class GitHubError extends Error { constructor(readonly code: Problem['code']) { super(code); } }
const problem = (code: Problem['code']): Problem => ({ source: 'github', code });
type Port = Pick<ReadPorts, 'process' | 'clock'>;
type CacheValue = { at: number; value: unknown };

export class GitHubReader {
  private blockedUntil = 0;
  private cache = new Map<string, CacheValue>();
  private pending = new Map<string, Promise<unknown>>();
  private complete = new Map<string, unknown>();
  constructor(private readonly repository: Pick<ConfigRepository, 'resolve'>, private readonly ports: Port) {}
  private now() { return this.ports.clock().getTime(); }
  private stamp() { return this.ports.clock().toISOString(); }
  private remember(map: Map<string, unknown>, key: string, value: unknown) {
    map.delete(key); map.set(key, value);
    if (map.size > 128) map.delete(map.keys().next().value!);
  }
  private async coalesce<T>(key: string, read: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < 30000) return structuredClone(cached.value) as T;
    const existing = this.pending.get(key);
    if (existing) return structuredClone(await existing) as T;
    const promise = read(); this.pending.set(key, promise);
    try {
      const value = await promise;
      this.remember(this.cache, key, { at: this.now(), value });
      return structuredClone(value);
    } finally { this.pending.delete(key); }
  }
  private async request(id: string, operation: ProcessOperation, remainingMs = 10000): Promise<unknown> {
    this.repository.resolve(id);
    if (this.now() < this.blockedUntil) throw new GitHubError('rate_limited');
    let text: string;
    try { text = await this.ports.process(id, operation, Math.min(10000, remainingMs)); }
    catch (error) { throw new GitHubError(error instanceof ReadError ? error.code : 'network_failed'); }
    const match = text.match(/^HTTP\/[^ ]+ (\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
    if (!match) throw new GitHubError('invalid_response');
    const status = Number(match[1]);
    const headers = new Map(match[2].split(/\r?\n/).flatMap(line => {
      const separator = line.indexOf(':'); return separator < 1 ? [] : [[line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()] as [string, string]];
    }));
    if (status === 403 || status === 429) {
      const retry = headers.get('retry-after');
      const reset = headers.get('x-ratelimit-reset');
      const retryAt = retry ? /^\d+$/.test(retry) ? this.now() + Number(retry) * 1000 : Date.parse(retry) : NaN;
      const resetAt = reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : NaN;
      const gate = Number.isFinite(retryAt) && retryAt > this.now() ? retryAt : Number.isFinite(resetAt) && resetAt > this.now() ? resetAt : this.now() + 60000;
      this.blockedUntil = Math.max(this.blockedUntil, gate);
      throw new GitHubError(status === 429 || retry || headers.get('x-ratelimit-remaining') === '0' ? 'rate_limited' : 'auth_denied');
    }
    if (status === 401) throw new GitHubError('auth_denied');
    if (status === 404) throw new GitHubError('not_found');
    if (status < 200 || status >= 300) throw new GitHubError('network_failed');
    try { return JSON.parse(match[3]); } catch { throw new GitHubError('invalid_response'); }
  }
  private code(error: unknown): Problem['code'] { return error instanceof GitHubError ? error.code : 'invalid_response'; }
  private summary(repo: string, raw: z.infer<typeof RawIssue>): IssueSummary {
    const labels = raw.labels.map(label => label.name);
    return { number: raw.number, title: raw.title, url: `https://github.com/${repo}/issues/${raw.number}`, githubState: raw.state, updatedAt: raw.updated_at, labels, ...classifyIssue(raw.state, labels) };
  }
  private async collect<T>(id: string, key: string, operation: (page: number) => ProcessOperation, parse: (value: unknown) => { records: T[]; count: number }): Promise<CompleteCollection<T>> {
    const start = this.now(), records: T[] = [];
    let failure: Problem['code'] = 'incomplete';
    try {
      for (let page = 1; page <= 10; page++) {
        if (this.now() - start >= 60000) throw new GitHubError('deadline');
        const result = parse(await this.request(id, operation(page), Math.max(1, 60000 - (this.now() - start))));
        if (this.now() - start >= 60000) throw new GitHubError('deadline');
        if (result.count > 100) throw new GitHubError('invalid_response');
        records.push(...result.records);
        if (result.count < 100) {
          const collection = { complete: true, observedAt: this.stamp(), records, problems: [] };
          this.remember(this.complete, key, collection); return collection;
        }
      }
    } catch (error) { failure = this.now() - start >= 60000 ? 'deadline' : this.code(error); }
    const previous = this.complete.get(key) as CompleteCollection<T> | undefined;
    return { complete: false, observedAt: previous?.observedAt ?? this.stamp(), records: previous?.records ?? [], problems: [problem(failure)] };
  }
  async listIssueScope(id: string): Promise<CompleteCollection<IssueSummary>> {
    const { repo } = this.repository.resolve(id), key = `${id}:scope`;
    return this.coalesce(key, () => this.collect(id, key, page => ({ kind: 'gh-api-get', resource: 'issues', state: 'open', page }), value => {
      const raw = z.array(RawIssue).parse(value);
      return { count: raw.length, records: raw.filter(r => !r.pull_request).map(r => this.summary(repo, r)) };
    }));
  }
  async listIssues(id: string, page: number): Promise<Observation<IssuePage>> {
    const { repo } = this.repository.resolve(id);
    if (!Number.isInteger(page) || page < 1 || page > 10) throw new ReadError('unsafe_path');
    const key = `${id}:page:${page}`;
    return this.coalesce(key, async () => {
      try {
        const raw = z.array(RawIssue).max(100).parse(await this.request(id, { kind: 'gh-api-get', resource: 'issues', state: 'all', page }));
        const data: IssuePage = { repo, page, hasNextPage: raw.length === 100, records: raw.filter(r => !r.pull_request).map(r => this.summary(repo, r)), dependencyStatus: 'unknown' };
        const now = this.stamp();
        const observation: Observation<IssuePage> = { state: 'available', data, observedAt: now, lastSuccessfulAt: now, problems: [] };
        this.remember(this.complete, key, observation); return observation;
      } catch (error) {
        const previous = this.complete.get(key) as Observation<IssuePage> | undefined;
        return { state: previous ? 'stale' : 'unavailable', data: previous?.data ?? null, observedAt: this.stamp(), lastSuccessfulAt: previous?.lastSuccessfulAt ?? null, problems: [problem(this.code(error))] };
      }
    });
  }
  async readIssueReports(id: string, issue: number): Promise<ReportSelection> {
    const deployment = this.repository.resolve(id), key = `${id}:reports:${issue}`;
    return this.coalesce(key, async () => {
      const comments = await this.collect(id, `${key}:comments`, page => ({ kind: 'gh-api-get', resource: 'comments', issue, page }), value => {
        const records = z.array(Comment).parse(value); return { records, count: records.length };
      });
      if (comments.complete) {
        const result = selectReports(deployment.repo, issue, comments.records, deployment.trustedPublisherLogins, true);
        this.remember(this.complete, key, result); return result;
      }
      const previous = this.complete.get(key) as ReportSelection | undefined;
      const retained = previous ?? selectReports(deployment.repo, issue, [], deployment.trustedPublisherLogins, false);
      return { ...retained, complete: false, problems: comments.problems };
    });
  }
  async readDependencies(id: string, issue: number): Promise<CompleteCollection<IssueSummary>> {
    const { repo } = this.repository.resolve(id), key = `${id}:dependencies:${issue}`;
    return this.coalesce(key, () => this.collect(id, key, page => ({ kind: 'gh-api-get', resource: 'dependencies', issue, page }), value => {
      const raw = z.array(RawIssue.extend({ html_url: z.string() })).parse(value);
      if (raw.some(r => r.html_url !== `https://github.com/${repo}/issues/${r.number}`)) throw new GitHubError('invalid_response');
      return { count: raw.length, records: raw.filter(r => !r.pull_request).map(r => this.summary(repo, r)) };
    }));
  }
  async getPullRequestEvidence(id: string, prNumber: number): Promise<PullRequestEvidence> {
    const { repo } = this.repository.resolve(id), key = `${id}:pr:${prNumber}`;
    return this.coalesce(key, async () => {
      const pr = Pull.parse(await this.request(id, { kind: 'gh-api-get', resource: 'pull', pr: prNumber, page: 1 }));
      const url = `https://github.com/${repo}/pull/${prNumber}`;
      if (pr.number !== prNumber || pr.base.repo.full_name !== repo || pr.html_url !== url) throw new GitHubError('invalid_response');
      const checks = await this.collect(id, `${key}:${pr.head.sha}:checks`, page => ({ kind: 'gh-api-get', resource: 'checks', sha: pr.head.sha, page }), value => {
        const parsed = z.object({ check_runs: z.array(Check) }).parse(value);
        const records = parsed.check_runs.map(check => {
          // Check URLs are evidence links, never request destinations.
          const prefix = `https://github.com/${repo}/`;
          const url = check.html_url;
          const safe = url?.startsWith(prefix) && /^(?:runs\/[0-9]+|actions\/runs\/[0-9]+(?:\/job\/[0-9]+)?)$/.test(url.slice(prefix.length));
          return { ...check, html_url: safe ? url : null };
        });
        return { count: records.length, records };
      });
      return { number: prNumber, url, state: pr.state, head: pr.head.sha, mergedAt: pr.merged_at, checks };
    });
  }
  async getIssue(id: string, issue: number): Promise<Observation<IssueDetail>> {
    const { repo } = this.repository.resolve(id), key = `${id}:issue:${issue}`;
    return this.coalesce(key, async () => {
      try {
        const raw = RawIssue.parse(await this.request(id, { kind: 'gh-api-get', resource: 'issue', issue, page: 1 }));
        if (raw.number !== issue || raw.pull_request) throw new GitHubError('invalid_response');
        const reports = await this.readIssueReports(id, issue);
        const dependencies = await this.readDependencies(id, issue);
        const problems = [...dependencies.problems, ...reports.problems];
        let verified = false;
        if (reports.prIdentity.status === 'available') {
          try { verified = (await this.getPullRequestEvidence(id, reports.prIdentity.number)).mergedAt !== null; }
          catch (error) {
            problems.push(problem(this.code(error)));
            // A failed refresh is not evidence that an already confirmed merge
            // disappeared. Retain it only for the very same associated run/PR;
            // a new, missing or conflicting identity cannot borrow that fact.
            const previous = this.complete.get(key) as Observation<IssueDetail> | undefined;
            const identity = previous?.data?.reports.prIdentity;
            verified = previous?.data?.mergeEvidence === 'verified' && identity?.status === 'available'
              && identity.url === reports.prIdentity.url && identity.runId === reports.prIdentity.runId;
          }
        }
        const summary = this.summary(repo, raw);
        const data: IssueDetail = { issue: { ...summary, ...classifyIssue(raw.state, summary.labels, verified) }, reports, dependencies,
          mergeEvidence: verified ? 'verified' : summary.labels.includes('ai-merged') || reports.mergedReceipt.status === 'available' ? 'reported' : 'unknown' };
        const now = this.stamp();
        if (problems.length) {
          const previous = this.complete.get(key) as Observation<IssueDetail> | undefined;
          if (previous) return { ...previous, data, state: 'stale', observedAt: now, problems };
          return { state: 'partial', data, observedAt: now, lastSuccessfulAt: null, problems };
        }
        const observation: Observation<IssueDetail> = { state: 'available', data, observedAt: now, lastSuccessfulAt: now, problems: [] };
        this.remember(this.complete, key, observation); return observation;
      } catch (error) {
        const previous = this.complete.get(key) as Observation<IssueDetail> | undefined;
        return { state: previous ? 'stale' : 'unavailable', data: previous?.data ?? null, observedAt: this.stamp(), lastSuccessfulAt: previous?.lastSuccessfulAt ?? null, problems: [problem(this.code(error))] };
      }
    });
  }
}

// Server-only helper: callers share the installation's reader/cache and exact-repo boundary.
export function getPullRequestEvidence(deploymentId: string, prNumber: number, reader: GitHubReader) {
  return reader.getPullRequestEvidence(deploymentId, prNumber);
}
