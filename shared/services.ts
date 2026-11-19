import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { DeploymentId } from './common';

// Closed vocabularies from systemctl's own documented output. A value outside
// its vocabulary is retained as 'unknown'; it is never coerced into a
// success-looking state or rejected as a whole record.
export const loadStates = ['loaded', 'not-found', 'bad-setting', 'error', 'masked', 'merged', 'stub', 'unknown'] as const;
export const activeStates = ['active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating', 'maintenance', 'refreshing', 'unknown'] as const;
export const subStates = ['running', 'waiting', 'elapsed', 'dead', 'exited', 'failed', 'start-pre', 'start', 'start-post',
  'auto-restart', 'auto-restart-queued', 'stop', 'stop-sigterm', 'stop-sigkill', 'stop-post', 'final-sigterm', 'final-sigkill',
  'reload', 'reload-signal', 'reload-notify', 'cleaning', 'condition', 'unknown'] as const;
export const unitFileStates = ['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias', 'masked', 'masked-runtime',
  'static', 'disabled', 'indirect', 'generated', 'transient', 'bad', 'unknown'] as const;

export const InventoryProblem = z.object({
  source: z.enum(['runtime', 'installed', 'host']),
  code: z.enum(['malformed_record', 'process_failed', 'process_timeout', 'process_limit', 'read_limit',
    'row_limit', 'deadline', 'disposed']),
}).strict();
export type InventoryProblem = z.infer<typeof InventoryProblem>;

// One observed unit ID; runtime and installed facts stay separately nullable so
// a source-specific read failure cannot fabricate the other source's fact.
export const InventoryUnit = z.object({
  id: z.string().min(5).max(200).regex(/^orbi[A-Za-z0-9_.:@-]*\.(?:service|timer)$/),
  kind: z.enum(['service', 'timer']),
  runtime: z.object({
    loadState: z.enum(loadStates), activeState: z.enum(activeStates), subState: z.enum(subStates),
  }).strict().nullable(),
  unitFileState: z.enum(unitFileStates).nullable(),
}).strict();
export type InventoryUnit = z.infer<typeof InventoryUnit>;

export const InventoryGroup = z.object({
  // Sanitized validated unit-family prefix, never a description or path.
  label: z.string().min(1).max(120).regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u),
  kind: z.enum(['runner-family', 'auxiliary', 'other']),
  units: z.array(InventoryUnit).max(256),
  // 'matched' is the only state that carries repo authority (a unique exact
  // prefix of an available deployment). 'incompatible' is display-only.
  association: z.enum(['matched', 'incompatible', 'unmatched', 'ambiguous']),
  deploymentId: DeploymentId.nullable(),
}).strict();
export type InventoryGroup = z.infer<typeof InventoryGroup>;

export const ServiceInventory = z.object({
  state: z.enum(['off', 'complete', 'partial', 'unavailable']),
  observedAt: z.iso.datetime().nullable(),
  sources: z.array(z.object({
    source: z.enum(['runtime', 'installed']),
    state: z.enum(['complete', 'partial', 'unavailable']),
    observedAt: z.iso.datetime(),
    problems: z.array(InventoryProblem).max(8),
  }).strict()).max(2),
  groups: z.array(InventoryGroup).max(256),
  problems: z.array(InventoryProblem).max(16),
}).strict();
export type ServiceInventory = z.infer<typeof ServiceInventory>;

export const servicesInventory = defineRpc({
  name: 'services.inventory', input: z.object({}).strict(), output: ServiceInventory,
});
