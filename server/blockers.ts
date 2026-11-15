import type { Observation, Problem } from '../shared/common';
import { attention, artifactNames, blockerLabels, type Blocker, type BlockerPage, type BlockerDetails } from '../shared/blockers';
import type { IssueSummary, ReportSelection } from '../shared/issues';
import type { ConfigRepository } from './config';
import type { GitHubReader } from './github';
import { ReadError, type ReadPorts } from './read-ports';

const PAGE_SIZE = 20;
function record(issue: IssueSummary, reports: ReportSelection): Blocker {
  const base = reports.baseCi;
  return { issue, attention: attention(issue), reports: {
    selectedRunId: reports.selectedRunId, attribution: reports.attribution, complete: reports.complete,
    failure: reports.failure, scene: reports.scene,
    baseCi: base.status === 'available' ? { ...base, data: { state: base.data.state, pr: base.data.pr } } : base,
  } };
}
export class BlockersReader {
  private successes = new Map<string, Observation<BlockerPage | BlockerDetails>>();
  constructor(private readonly repository: Pick<ConfigRepository, 'resolve'>, private readonly github: Pick<GitHubReader, 'listIssueScope' | 'readIssueReports' | 'getIssue'>, private readonly ports: Pick<ReadPorts, 'clock' | 'statArtifact'>) {}
  private observe<T extends BlockerPage | BlockerDetails>(key: string, data: T | null, complete: boolean, problems: Problem[], evidenceAt: string): Observation<T> {
    const previous = this.successes.get(key);
    const result: Observation<T> = { state: complete ? 'available' : previous ? 'stale' : data ? 'partial' : 'unavailable',
      data: data ?? (previous?.data as T | undefined) ?? null, observedAt: this.ports.clock().toISOString(),
      lastSuccessfulAt: complete ? evidenceAt : previous?.lastSuccessfulAt ?? null, problems };
    if (complete) {
      this.successes.delete(key); this.successes.set(key, result);
      if (this.successes.size > 128) this.successes.delete(this.successes.keys().next().value!);
    }
    return result;
  }
  async list({ deploymentId: id, page }: { deploymentId: string; page: number }): Promise<Observation<BlockerPage>> {
    const { repo } = this.repository.resolve(id);
    if (!Number.isSafeInteger(page) || page < 1) throw new ReadError('unsafe_path');
    const scope = await this.github.listIssueScope(id);
    const candidates = scope.records.filter(issue => blockerLabels.some(label => issue.labels.includes(label)));
    const selected = candidates.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const records: Blocker[] = [], problems = [...scope.problems];
    let complete = scope.complete;
    // Sequential reads respect the shared two-process bound. Only this page's candidates, never historical issues.
    for (const issue of selected) {
      const reports = await this.github.readIssueReports(id, issue.number);
      records.push(record(issue, reports));
      complete &&= reports.complete; problems.push(...reports.problems);
    }
    // An initial incomplete scope establishes no membership, not an empty success.
    const data = !scope.complete && !scope.records.length ? null : { repo, page, hasNextPage: candidates.length > page * PAGE_SIZE, complete: scope.complete, records };
    return this.observe(`${id}:page:${page}`, data, complete, problems, scope.observedAt);
  }
  async read({ deploymentId: id, issue }: { deploymentId: string; issue: number }): Promise<Observation<BlockerDetails>> {
    const deployment = this.repository.resolve(id);
    if (!Number.isSafeInteger(issue) || issue < 1) throw new ReadError('unsafe_path');
    const detail = await this.github.getIssue(id, issue);
    const key = `${id}:issue:${issue}`;
    if (!detail.data) return this.observe<BlockerDetails>(key, null, false, detail.problems, detail.observedAt);
    const blocker = record(detail.data.issue, detail.data.reports);
    const reports = blocker.reports;
    const exact = reports.complete && reports.scene.status === 'available'
      && reports.scene.data.run_id === reports.selectedRunId && detail.data.reports.prIdentity.status === 'available';
    const artifacts: BlockerDetails['artifacts'] = [];
    for (const name of artifactNames) artifacts.push(exact
      ? await this.ports.statArtifact(id, issue, reports.selectedRunId!, name)
      : { name, status: 'unattributed', size: null, modifiedAt: null });
    const data: BlockerDetails = { ...blocker, artifacts, retention: { profile: deployment.sourceProfile,
      worktreeRetainHours: deployment.worktreeRetainHours, keepFailedWorktrees: deployment.keepFailedWorktrees } };
    return this.observe(key, data, detail.state === 'available', detail.problems, detail.lastSuccessfulAt ?? detail.observedAt);
  }
}
