import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { DeploymentId, Problem } from './common';

// One point-in-time presence/type observation of the operator-designated shortcut.
// There is no target field: the target is never read, resolved, compared or displayed.
export const ShortcutState = z.enum(['symlink', 'not_symlink', 'absent', 'cannot_inspect', 'not_configured']);
export type ShortcutState = z.infer<typeof ShortcutState>;
export const WorkspaceShortcutStatus = z.object({
  deploymentId: DeploymentId, state: ShortcutState, observedAt: z.iso.datetime(), problem: Problem.nullable(),
}).strict();
export type WorkspaceShortcutStatus = z.infer<typeof WorkspaceShortcutStatus>;
export const workspaceShortcutStatus = defineRpc({
  // The pinned SDK admits only lowercase RPC names, so the one shortcut operation is
  // registered as workspace.shortcut.
  name: 'workspace.shortcut', input: z.object({ deploymentId: DeploymentId }).strict(),
  output: WorkspaceShortcutStatus,
});
