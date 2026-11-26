import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { DeploymentId, Problem, observationSchema } from './common';

export const issueStates = ['Merged', 'Closed', 'Blocked', 'Needs detail', 'Coordination', 'Reviewing', 'Implementing', 'Planning', 'Paused', 'Ready candidate', 'Other'] as const;
// GitHub's server-side issue state filter. Browse defaults to open; closed and
// all are separate requests, never a local filter over one all-state page.
export const issueBrowseStates = ['open', 'closed', 'all'] as const;
export type IssueBrowseState = (typeof issueBrowseStates)[number];
// Browser shortcuts for the workflow labels this plugin already classifies.
// Both the Work first screen and the Issues route use the same exact filters.
export const issueLabelShortcuts = ['ai-ready', 'ai-planning', 'ai-blocked', 'ai-in-progress'] as const;
export const issueBrowseStateTitle = (state: IssueBrowseState) => state === 'all' ? 'All states' : state[0].toUpperCase() + state.slice(1);
// One concrete repair sentence, never a retry or a mutation affordance.
export const issueReadRepair = "If auth_denied: ask the operator to repair the daemon user's existing gh authentication, then Refresh. rate_limited: wait for GitHub's retry/reset gate; Refresh cannot bypass it.";
// One exact literal label: bounded printable text. A comma is excluded because
// GitHub reads its labels parameter as a comma-separated list, and surrounding
// whitespace would silently change the requested label. Everything else is
// accepted as written and URL-encoded, never interpolated into a command.
export function validIssueLabel(value: string) {
  return value.length >= 1 && value.length <= 100 && !/[\u0000-\u001f\u007f,]/.test(value) && value.trim() === value;
}
// Presentation only: GitHub label colors are six-digit hex without '#'; anything
// else is a neutral chip, never a guessed or invented color.
export const neutralLabelColor = '#6e7781';
export function labelColor(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-fA-F]{6}$/.test(value) ? `#${value.toLowerCase()}` : neutralLabelColor;
}
// WCAG relative luminance. Pure black and pure white cross at L = 0.179, so
// choosing the lighter/darker ink at that crossover keeps every six-digit
// repository color at >= 4.5:1 contrast instead of guessing a mid-tone ink.
export function labelLuminance(color: string): number {
  const hex = /^#[0-9a-fA-F]{6}$/.test(color) ? color : neutralLabelColor;
  const [r, g, b] = [1, 3, 5].map(index => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function labelForeground(color: string): string {
  return labelLuminance(color) > 0.179 ? '#000000' : '#ffffff';
}
export const LabelPresentation = z.object({ name: z.string().max(100), color: z.string().regex(/^#[0-9a-f]{6}$/) }).strict();
export type LabelPresentation = z.infer<typeof LabelPresentation>;
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
  // Literal label names stay in `labels` for classification; colors are only
  // presentation metadata and never change lifecycle state or provenance.
  labelDetails: z.array(LabelPresentation).optional(),
  state: z.enum(issueStates), badge: z.string().nullable(), provenance: z.enum(['verified', 'reported', 'github']), warning: z.boolean(),
}).strict();
export type IssueSummary = z.infer<typeof IssueSummary>;
export type CompleteCollection<T> = { complete: boolean; observedAt: string; records: T[]; problems: z.infer<typeof Problem>[] };
export const IssuePage = z.object({
  repo: z.string(), page: z.number().int().positive(), hasNextPage: z.boolean(), records: z.array(IssueSummary), dependencyStatus: z.literal('unknown'),
  state: z.enum(issueBrowseStates).default('open'), label: z.string().nullable().default(null),
}).strict();
export type IssuePage = z.infer<typeof IssuePage>;
const Attribution = z.object({ repo: z.string(), issue: z.number().int().positive(), commentId: z.number().int().positive(), updatedAt: z.iso.datetime() }).strict();
const classified = <T extends z.ZodType>(data: T) => z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), data, attribution: Attribution }).strict(),
  z.object({ status: z.enum(['missing', 'unsupported', 'invalid']), attribution: Attribution.nullable() }).strict(),
]);
export const Progress = z.object({ step: z.enum(['starting', 'implement', 'review', 'checks', 'merge', 'release']).nullable(), reported_at: z.iso.datetime(), activity: z.object({ at: z.iso.datetime().nullable(), kind: z.enum(['read', 'edit', 'command', 'analysis']), target: z.null() }).strict().nullable() }).strict();
export const Failure = z.object({ schema: z.literal(1), outcome: z.enum(['blocked', 'fix_needed']), reason_code: z.enum(['github_transient', 'tests_failed', 'review_budget_exhausted', 'human_decision_required', 'credential_missing', 'provider_quota', 'base_branch_missing', 'base_ci_red', 'checks_permission_missing', 'release_failed', 'no_commit_delivered', 'no_file_change', 'provider_balance', 'attachment_unavailable', 'unclassified']), action_code: z.enum(['requeue', 'fix_ticket', 'decide', 'check_credentials', 'wait_quota', 'top_up_balance']), retry_safe: z.boolean() }).strict();
export const Scene = z.object({ run_id: z.string().regex(/^[0-9a-f]{8}$/), pr_url: z.string(), review_round: z.number().int().nonnegative() }).strict();
export const BaseCi = z.object({ state: z.enum(['waiting', 'resuming', 'merged', 'stale']), pr: z.number().int(), failing_checks: z.array(z.string()) }).strict();
export const Receipt = z.object({ merge_commit: z.string().regex(/^[0-9a-f]{40}$/), review_rounds: z.number().int().nonnegative(), commits: z.number().int().nonnegative(), external_commits: z.number().int().nonnegative(), run_id: z.string().regex(/^[0-9a-f]{8}$/), pr_url: z.string() }).strict();
export const PrIdentity = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), number: z.number().int().positive(), url: z.string(), source: z.enum(['scene', 'receipt']), runId: z.string() }).strict(),
  z.object({ status: z.enum(['missing', 'invalid', 'conflict']) }).strict(),
]);
export const ReportSelection = z.object({ selectedRunId: z.string().nullable(), attribution: Attribution.nullable(), complete: z.boolean(), problems: z.array(Problem), progress: classified(Progress), failure: classified(Failure), scene: classified(Scene), baseCi: classified(BaseCi), mergedReceipt: classified(Receipt), prIdentity: PrIdentity }).strict();
export type ReportSelection = z.infer<typeof ReportSelection>;
export const IssueDetail = z.object({ issue: IssueSummary, reports: ReportSelection, dependencies: z.object({ complete: z.boolean(), observedAt: z.iso.datetime(), records: z.array(IssueSummary), problems: z.array(Problem) }).strict(), mergeEvidence: z.enum(['verified', 'reported', 'unknown']) }).strict();
export type IssueDetail = z.infer<typeof IssueDetail>;
export const issuesList = defineRpc({ name: 'issues.list', input: z.object({
  deploymentId: DeploymentId, page: z.number().int().min(1).max(10),
  state: z.enum(issueBrowseStates).default('open'),
  label: z.string().max(100).refine(validIssueLabel).optional(),
}).strict(), output: observationSchema(IssuePage) });
export const issuesGet = defineRpc({ name: 'issues.get', input: z.object({ deploymentId: DeploymentId, issue: z.number().int().positive() }).strict(), output: observationSchema(IssueDetail) });
