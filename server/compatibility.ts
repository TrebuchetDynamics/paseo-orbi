import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readBytes } from './read-ports';

const basePaths = ['docs/public-contracts.mdx', ...[
  'base_ci_red', 'config', 'delivery_labels', 'failure', 'journal', 'pi_activity',
  'run_state', 'runner_health', 'scene', 'scheduler_units', 'status_observe',
].map(name => `src/orbi/${name}.py`)];
export const profiles = {
  'orbi-0.7.41-release': { commit: 'fbafd09fe49a20299e96565f100633bca61ae2af', fingerprint: 'ff662193032fc0caf59e2742a3892c31af90a6d66726f38b2ac2256cb663140e', paths: [...basePaths].sort() },
  'orbi-0.7.41-1a8b2f96': { commit: '1a8b2f9603f6258cb105293f238a8d3f775f3393', fingerprint: 'ae5bd552aef7e1689b7352d99794f6dc0a04e257cf3668cad08be9473b9d859d', paths: [...basePaths, 'src/orbi/worktree_retention.py'].sort() },
} as const;
export type SourceProfile = keyof typeof profiles;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export async function fingerprint(root: string, profile: SourceProfile) {
  let manifest = '';
  for (const path of profiles[profile].paths) manifest += `${path}\0${sha(await readBytes(root, resolve(root, path)))}\n`;
  return sha(manifest);
}
export async function compatible(root: string, adapter: string): Promise<boolean> {
  // Use own-property lookup: no inherited profile names can be authorized.
  if (!Object.hasOwn(profiles, adapter)) return false;
  try { return await fingerprint(root, adapter as SourceProfile) === profiles[adapter as SourceProfile].fingerprint; }
  catch { return false; }
}
