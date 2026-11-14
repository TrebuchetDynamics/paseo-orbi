import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const DeploymentId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export type DeploymentId = z.infer<typeof DeploymentId>;
export const Problem = z.object({
  source: z.enum(['config', 'compatibility', 'github', 'systemd', 'journal', 'filesystem']),
  code: z.enum(['invalid_config', 'invalid_identity', 'duplicate_deployment', 'too_many_deployments',
    'config_mismatch', 'unsafe_path', 'read_failed', 'read_limit', 'disposed',
    'unsupported_source_profile', 'process_failed', 'process_timeout', 'process_limit', 'refresh_failed',
    'auth_denied', 'rate_limited', 'not_found', 'network_failed', 'invalid_response', 'incomplete', 'deadline']),
}).strict();
export type Problem = z.infer<typeof Problem>;
export const DeploymentCatalog = z.object({
  state: z.enum(['unconfigured', 'invalid', 'configured']),
  entries: z.array(z.object({
    id: DeploymentId, label: z.string().min(1).max(80).regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u),
    repo: z.string(), adapter: z.string(),
    status: z.enum(['available', 'invalid_config', 'unsupported_source_profile']), problems: z.array(Problem),
  }).strict()),
  problems: z.array(Problem),
}).strict();
export type DeploymentCatalog = z.infer<typeof DeploymentCatalog>;
export const deploymentsList = defineRpc({ name: 'deployments.list', input: z.object({}).strict(), output: DeploymentCatalog });
export const observationSchema = <T extends z.ZodType>(data: T) => z.object({
  state: z.enum(['available', 'partial', 'stale', 'unavailable']),
  observedAt: z.iso.datetime(), lastSuccessfulAt: z.iso.datetime().nullable(), data: data.nullable(), problems: z.array(Problem),
}).strict();
export type Observation<T> = {
  state: 'available' | 'partial' | 'stale' | 'unavailable'; observedAt: string;
  lastSuccessfulAt: string | null; data: T | null; problems: Problem[];
};
