import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { DeploymentId, observationSchema } from './common';
import { IssueSummary, ReportSelection, type ReportSelection as Reports } from './issues';

export const blockerLabels = ['ai-blocked', 'ai-needs-detail', 'ai-awaiting-merge', 'ai-fix-needed'] as const;
export function attention(issue: Pick<z.infer<typeof IssueSummary>, 'githubState' | 'labels' | 'state'>) {
  if (issue.githubState === 'closed' || issue.state === 'Merged' || issue.labels.includes('ai-merged')) return 'github_terminal' as const;
  if (issue.labels.includes('ai-blocked') || issue.labels.includes('ai-needs-detail')) return 'manual_attention' as const;
  if (issue.labels.includes('ai-fix-needed')) return 'automatic_fix_pending' as const;
  if (issue.labels.includes('ai-awaiting-merge')) return 'maintainer_merge_wait' as const;
  return 'not_candidate' as const;
}
export const attentionText = {
  manual_attention: 'Manual attention reported. An operator must assess the precondition outside this plugin.',
  automatic_fix_pending: 'Automatic fix/review pending, not a terminal failure. Observe Orbi before intervening.',
  maintainer_merge_wait: 'Maintainer merge wait, not a terminal failure. A maintainer decides outside this plugin.',
  github_terminal: 'GitHub is terminal or reports merged; retained failure metadata is historical, not current execution.',
  not_candidate: 'No current blocker label observed. Retained reports are not proof of a current blocker.',
} as const;
export const reasonText = {
  github_transient: 'GitHub transient failure reported. The operator can assess GitHub availability before considering recovery.',
  tests_failed: 'Tests failed (legacy reported reason). The operator should inspect the code/ticket and CI evidence externally.',
  review_budget_exhausted: 'Review budget exhausted. A human must decide how to proceed.',
  human_decision_required: 'A human decision or external precondition is required.',
  credential_missing: 'Missing or rejected credential reported. The operator repairs credentials externally; this plugin does not validate them.',
  provider_quota: 'Provider quota exhausted. Wait for the provider quota window outside this plugin.',
  base_branch_missing: 'Configured base branch is missing. The operator repairs repository/configuration externally.',
  base_ci_red: 'Base CI is red. Repair belongs to the base, not a plain requeue of this delivery. Orbi owns same-run recovery.',
  checks_permission_missing: 'Check-read permission is missing. An installation owner approves permissions externally; Orbi can then resume.',
  unclassified: 'Unclassified failure. An operator must investigate externally; no diagnostic prose is interpreted.',
} as const;
export const actionText = {
  requeue: 'Reported action requeue: only Orbi/operator may decide whether to requeue externally.',
  fix_ticket: 'Reported action fix_ticket: operator assesses and repairs code/ticket externally.',
  decide: 'Reported action decide: a human decides the next step externally.',
  check_credentials: 'Reported action check_credentials: operator checks/repairs credentials externally.',
  wait_quota: 'Reported action wait_quota: wait for the provider quota window externally.',
} as const;
export function failureGuidance(failure: Reports['failure']): string {
  if (failure.status !== 'available') return `Failure metadata ${failure.status}. Reason, action and retry safety are unknown; ask the operator for formal evidence. No prose fallback.`;
  const f = failure.data;
  return `Reported outcome ${f.outcome}. ${reasonText[f.reason_code]} ${actionText[f.action_code]} Reported retry_safe=${f.retry_safe}: metadata, never permission to retry.`;
}
export function waitGuidance(state: 'waiting' | 'resuming' | 'merged' | 'stale'): string {
  return {
    waiting: 'Base CI waiting: reported wait for base repair; Orbi owns recovery.',
    resuming: 'Base CI resuming: reported same-run recovery, not delivery success.',
    merged: 'Base CI merged: reported base-CI recovery state, not independently verified delivery success.',
    stale: 'Base CI stale: reported evidence is no longer current; operator investigation is needed.',
  }[state];
}
// Exclude progress targets, diagnostics, check names and arbitrary scene paths.
export const BlockerReports = ReportSelection.pick({ selectedRunId: true, attribution: true, complete: true, failure: true, scene: true }).extend({
  baseCi: z.discriminatedUnion('status', [
    z.object({ status: z.literal('available'), data: z.object({ state: z.enum(['waiting', 'resuming', 'merged', 'stale']), pr: z.number().int() }).strict(), attribution: ReportSelection.shape.attribution.unwrap() }).strict(),
    z.object({ status: z.enum(['missing', 'unsupported', 'invalid']), attribution: ReportSelection.shape.attribution }).strict(),
  ]),
}).strict();
export const Blocker = z.object({ issue: IssueSummary, attention: z.enum(['manual_attention', 'automatic_fix_pending', 'maintainer_merge_wait', 'github_terminal', 'not_candidate']), reports: BlockerReports }).strict();
export type Blocker = z.infer<typeof Blocker>;
export const BlockerPage = z.object({ repo: z.string(), page: z.number().int().positive(), hasNextPage: z.boolean(), complete: z.boolean(), records: z.array(Blocker) }).strict();
export type BlockerPage = z.infer<typeof BlockerPage>;
export const artifactNames = ['worktree', '.orbi/run-state.json', '.orbi/test.log', '.orbi/plan.md', '.orbi/verify.md'] as const;
export const ArtifactMetadata = z.object({ name: z.enum(artifactNames), status: z.enum(['present', 'missing', 'unreadable', 'invalid', 'unattributed']), size: z.number().int().nonnegative().nullable(), modifiedAt: z.iso.datetime().nullable() }).strict();
export type ArtifactMetadata = z.infer<typeof ArtifactMetadata>;
export const Retention = z.object({ profile: z.enum(['orbi-0.7.41-release', 'orbi-0.7.41-1a8b2f96']), worktreeRetainHours: z.number().positive(), keepFailedWorktrees: z.boolean().nullable() }).strict();
export const BlockerDetails = Blocker.extend({ artifacts: z.array(ArtifactMetadata), retention: Retention }).strict();
export type BlockerDetails = z.infer<typeof BlockerDetails>;
const selector = z.object({ deploymentId: DeploymentId, issue: z.number().int().positive() }).strict();
export const blockersList = defineRpc({ name: 'blockers.list', input: z.object({ deploymentId: DeploymentId, page: z.number().int().positive() }).strict(), output: observationSchema(BlockerPage) });
export const blockersRead = defineRpc({ name: 'blockers.read', input: selector, output: observationSchema(BlockerDetails) });
