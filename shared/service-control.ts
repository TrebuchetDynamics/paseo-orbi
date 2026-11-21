import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { ControlActionSchema, DeploymentId } from './common';
import { activeStates, loadStates, subStates } from './services';

// Operator-authorized service controls. This is a separate, narrow mutation
// contract: a caller names an approved deployment, a slot inside that
// deployment's approved range and an approved action. No unit name, command,
// argv, path, environment or free-form text can be supplied, so an action can
// only ever reach the exact target the operator approved.

// Every answer either reports a real, re-observed outcome or states that nothing
// ran. 'denied' never mutated; 'pending' means another operation for the same
// deployment was already in flight and this request was not submitted.
export const controlOutcomes = ['pending', 'succeeded', 'failed', 'unknown', 'denied'] as const;
export type ControlOutcome = (typeof controlOutcomes)[number];
export const controlReasons = [
  // Authorization (checked before any execution).
  'deployment_unavailable', 'action_not_approved', 'target_out_of_range',
  // Lifecycle ownership: a restart never kills a possible active delivery.
  'active_delivery',
  // Grant withdrawn, or another operation already runs for this deployment.
  'disposed', 'busy',
  // Execution and re-observation facts. A timeout is not proof of cancellation.
  'process_failed', 'process_timeout', 'process_limit', 'observe_failed',
] as const;
export type ControlReason = (typeof controlReasons)[number];

// Closed systemd vocabularies, re-read after the action. 'unknown' keeps a value
// outside the documented vocabulary instead of coercing it into a success word.
export const ControlObservation = z.object({
  loadState: z.enum(loadStates), activeState: z.enum(activeStates), subState: z.enum(subStates),
}).strict();
export type ControlObservation = z.infer<typeof ControlObservation>;

export const ServiceControlResult = z.object({
  // Server-generated identity of this submission. A caller cannot choose it.
  operationId: z.string().regex(/^ctl-[1-9][0-9]{0,8}$/),
  deploymentId: DeploymentId,
  slot: z.number().int().min(1).max(5),
  action: ControlActionSchema,
  outcome: z.enum(controlOutcomes),
  reason: z.enum(controlReasons).nullable(),
  // The pinned host supplies no authenticated identity to a plugin handler, so
  // this records that absence (null) instead of inventing an actor. No secret,
  // pointer or environment value is ever recorded here.
  actor: z.string().max(120).nullable(),
  submittedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  // Actual state re-read after the submission through the read port.
  observed: ControlObservation.nullable(),
}).strict();
export type ServiceControlResult = z.infer<typeof ServiceControlResult>;

export const servicesControl = defineRpc({
  name: 'services.control',
  input: z.object({
    deploymentId: DeploymentId, slot: z.number().int().min(1).max(5), action: ControlActionSchema,
  }).strict(),
  output: ServiceControlResult,
});
