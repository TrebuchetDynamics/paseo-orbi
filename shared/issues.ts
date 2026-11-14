import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { DeploymentId, Problem, observationSchema } from './common';

export const issueStates = ['Merged', 'Closed', 'Blocked', 'Needs detail', 'Coordination', 'Reviewing', 'Implementing', 'Planning', 'Paused', 'Ready candidate', 'Other'] as const;
const precedence = [
  ['ai-merged', 'Merged'], ['ai-blocked', 'Blocked'], ['ai-needs-detail', 'Needs detail'],
  ['ai-epic', 'Coordination'], ['ai-awaiting-merge', 'Reviewing'], ['ai-pr-opened', 'Reviewing'],
  ['ai-fix-needed', 'Reviewing'], ['ai-in-progress', 'Implementing'], ['ai-planning', 'Planning'],
  ['ai-paused', 'Paused'], ['ai-ready', 'Ready candidate'],
] as const;
export function classifyIssue(state: 'open' | 'closed', labels: string[], verifiedMerge = false) {
  const evidence = precedence.filter(([label]) => labels.includes(label));
  const selected = evidence[0];
  return {
    state: verifiedMerge || labels.includes('ai-merged') ? 'Merged' as const : state === 'closed' ? 'Closed' as const : selected?.[1] ?? 'Other' as const,
    badge: verifiedMerge ? 'PR merged_at' : state === 'closed' && !labels.includes('ai-merged') ? 'GitHub closed' : selected?.[0] ?? null,
    provenance: verifiedMerge ? 'verified' as const : labels.includes('ai-merged') ? 'reported' as const : 'github' as const,
    warning: evidence.length > 1,
  };
}
export const IssueSummary = z.object({
  number: z.number().int().positive(), title: z.string().max(1024), url: z.string(),
  githubState: z.enum(['open', 'closed']), updatedAt: z.iso.datetime(), labels: z.array(z.string().max(100)),
  state: z.enum(issueStates), badge: z.string().nullable(), provenance: z.enum(['verified', 'reported', 'github']), warning: z.boolean(),
}).strict();
export type IssueSummary = z.infer<typeof IssueSummary>;
export type CompleteCollection<T> = { complete: boolean; observedAt: string; records: T[]; problems: z.infer<typeof Problem>[] };
export const IssuePage = z.object({ repo: z.string(), page: z.number().int().positive(), hasNextPage: z.boolean(), records: z.array(IssueSummary), dependencyStatus: z.literal('unknown') }).strict();
export type IssuePage = z.infer<typeof IssuePage>;
const Attribution = z.object({ repo: z.string(), issue: z.number().int().positive(), commentId: z.number().int().positive(), updatedAt: z.iso.datetime() }).strict();
const classified = <T extends z.ZodType>(data: T) => z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), data, attribution: Attribution }).strict(),
  z.object({ status: z.enum(['missing', 'unsupported', 'invalid']), attribution: Attribution.nullable() }).strict(),
]);
export const Progress = z.object({ step: z.enum(['starting', 'implement', 'review', 'checks', 'merge', 'release']).nullable(), reported_at: z.iso.datetime(), activity: z.object({ at: z.iso.datetime().nullable(), kind: z.enum(['read', 'edit', 'command', 'analysis']), target: z.null() }).strict().nullable() }).strict();
export const Failure = z.object({ schema: z.literal(1), outcome: z.enum(['blocked', 'fix_needed']), reason_code: z.enum(['github_transient', 'tests_failed', 'review_budget_exhausted', 'human_decision_required', 'credential_missing', 'provider_quota', 'base_branch_missing', 'base_ci_red', 'checks_permission_missing', 'unclassified']), action_code: z.enum(['requeue', 'fix_ticket', 'decide', 'check_credentials', 'wait_quota']), retry_safe: z.boolean() }).strict();
export const Scene = z.object({ run_id: z.string().regex(/^[0-9a-f]{8}$/), pr_url: z.string(), review_round: z.number().int().nonnegative() }).strict();
export const BaseCi = z.object({ state: z.enum(['waiting', 'resuming', 'merged', 'stale']), pr: z.number().int(), failing_checks: z.array(z.string()) }).strict();
export const Receipt = z.object({ merge_commit: z.string().regex(/^[0-9a-f]{40}$/), review_rounds: z.number().int().nonnegative(), commits: z.number().int().nonnegative(), external_commits: z.number().int().nonnegative(), run_id: z.string().regex(/^[0-9a-f]{8}$/), pr_url: z.string() }).strict();
export const PrIdentity = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), number: z.number().int().positive(), url: z.string(), source: z.enum(['scene', 'receipt']), runId: z.string() }).strict(),
  z.object({ status: z.enum(['missing', 'invalid', 'conflict']) }).strict(),
]);
export const ReportSelection = z.object({ selectedRunId: z.string().nullable(), attribution: Attribution.nullable(), complete: z.boolean(), progress: classified(Progress), failure: classified(Failure), scene: classified(Scene), baseCi: classified(BaseCi), mergedReceipt: classified(Receipt), prIdentity: PrIdentity }).strict();
export type ReportSelection = z.infer<typeof ReportSelection>;
export const IssueDetail = z.object({ issue: IssueSummary, reports: ReportSelection, dependencies: z.object({ complete: z.boolean(), observedAt: z.iso.datetime(), records: z.array(IssueSummary), problems: z.array(Problem) }).strict(), mergeEvidence: z.enum(['verified', 'reported', 'unknown']) }).strict();
export type IssueDetail = z.infer<typeof IssueDetail>;
export const issuesList = defineRpc({ name: 'issues.list', input: z.object({ deploymentId: DeploymentId, page: z.number().int().min(1).max(10) }).strict(), output: observationSchema(IssuePage) });
export const issuesGet = defineRpc({ name: 'issues.get', input: z.object({ deploymentId: DeploymentId, issue: z.number().int().positive() }).strict(), output: observationSchema(IssueDetail) });
