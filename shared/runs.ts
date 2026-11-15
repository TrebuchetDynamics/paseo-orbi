import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { DeploymentId, Problem, observationSchema } from './common';
import { PrIdentity, Progress, Failure } from './issues';

export const RunId = z.string().regex(/^[0-9a-f]{8}$/);
const issue = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const SessionActivity = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
  state: z.enum(['available', 'unavailable']), at: z.iso.datetime().nullable(),
  kind: z.enum(['read', 'edit', 'command', 'analysis']).nullable(), problems: z.array(Problem),
}).strict();
export type SessionActivity = z.infer<typeof SessionActivity>;
export const RunSummary = z.object({
  deploymentId: DeploymentId, repo: z.string(), issue, runId: RunId,
  membership: z.enum(['scope', 'history']), lifecycle: z.string().nullable(),
  stage: Progress.shape.step, failure: Failure.nullable(),
  branch: z.string().max(256).nullable(), createdAt: z.iso.datetime().nullable(),
  pushedHead: sha.nullable(), reviewedHead: sha.nullable(),
  sessions: z.array(SessionActivity).max(16), problems: z.array(Problem),
}).strict();
export type RunSummary = z.infer<typeof RunSummary>;
export const RunEvent = z.object({
  at: z.iso.datetime(), event: z.enum(['run_start', 'run_end', 'worktree_cleaned', 'worktree_retained']), runId: RunId, issue,
}).strict();
export type RunEvent = z.infer<typeof RunEvent>;
const Check = z.object({ name: z.string().max(1024), status: z.string(), conclusion: z.string().nullable(), url: z.string().nullable() }).strict();
export const RunDetails = z.object({
  summary: RunSummary, prIdentity: PrIdentity,
  pr: z.object({ number: issue, url: z.string(), state: z.enum(['open', 'closed']), merged_at: z.iso.datetime().nullable(), head: z.object({ sha }).strict(),
    checks: z.array(Check), checksState: z.enum(['passed', 'failed', 'pending', 'missing', 'inaccessible', 'stale_head']) }).strict().nullable(),
  events: z.array(RunEvent).max(200),
}).strict();
export type RunDetails = z.infer<typeof RunDetails>;
export const runsList = defineRpc({ name: 'runs.list', input: z.object({ deploymentId: DeploymentId, issue: issue.optional() }).strict(), output: observationSchema(z.array(RunSummary)) });
export const runsRead = defineRpc({ name: 'runs.read', input: z.object({ deploymentId: DeploymentId, issue, runId: RunId }).strict(), output: observationSchema(RunDetails) });
