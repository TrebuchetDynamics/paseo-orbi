import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { DeploymentId, Problem, observationSchema } from './common';

const token = z.string().regex(/^[a-z][a-z0-9-]*$/).nullable();
export const UnitSnapshot = z.object({
  id: z.string(), loadState: token, activeState: token, subState: token, unitFileState: token,
  result: token, lastTrigger: z.string().nullable(), nextTrigger: z.string().nullable(),
  problems: z.array(Problem),
}).strict();
export type UnitSnapshot = z.infer<typeof UnitSnapshot>;
export const FleetSnapshot = z.object({
  deploymentId: DeploymentId, repo: z.string(), profile: z.string(),
  configuredCapacity: z.number().int().min(1).max(5), occupancy: z.null(),
  units: z.array(UnitSnapshot).max(10),
  health: z.object({
    lastPickupAt: z.iso.datetime().nullable(),
    recentRuns: z.array(z.object({
      repo: z.string(), issue: z.number().int().positive(), runId: z.string(),
      outcome: z.string(), at: z.iso.datetime(),
    }).strict()).max(50),
  }).strict().nullable(),
}).strict();
export type FleetSnapshot = z.infer<typeof FleetSnapshot>;
export const fleetRead = defineRpc({
  name: 'fleet.read', input: z.object({ deploymentId: DeploymentId }).strict(),
  output: observationSchema(FleetSnapshot),
});
