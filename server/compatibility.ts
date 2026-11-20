import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readBytes } from './read-ports';

const basePaths = ['docs/public-contracts.mdx', ...[
  'base_ci_red', 'config', 'delivery_labels', 'failure', 'journal', 'pi_activity',
  'run_state', 'runner_health', 'scene', 'scheduler_units', 'status_observe',
].map(name => `src/orbi/${name}.py`)];
const retentionPaths = [...basePaths, 'src/orbi/worktree_retention.py'];
export const profiles = {
  'orbi-0.7.41-release': { commit: 'fbafd09fe49a20299e96565f100633bca61ae2af', fingerprint: 'ff662193032fc0caf59e2742a3892c31af90a6d66726f38b2ac2256cb663140e', paths: [...basePaths].sort() },
  'orbi-0.7.41-1a8b2f96': { commit: '1a8b2f9603f6258cb105293f238a8d3f775f3393', fingerprint: 'ae5bd552aef7e1689b7352d99794f6dc0a04e257cf3668cad08be9473b9d859d', paths: [...retentionPaths].sort() },
  'orbi-0.7.48-release': {
    commit: 'f405e1dc4ff938ab99ec0742cfd3459d45e26948', fingerprint: 'f7d966479d4121b3cebecc116dd723eb0d0c7e2198d535b460230d06e118678e',
    paths: [...retentionPaths, ...['blocked_record', 'comment_kind', 'progress', 'question', 'requeue'].map(name => `src/orbi/${name}.py`)].sort(),
  },
} as const;
export type SourceProfile = keyof typeof profiles;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export async function fingerprint(root: string, profile: SourceProfile, signal?: AbortSignal) {
  let manifest = '';
  for (const path of profiles[profile].paths) manifest += `${path}\0${sha(await readBytes(root, resolve(root, path), signal))}\n`;
  return sha(manifest);
}
export async function compatible(root: string, adapter: string, signal?: AbortSignal): Promise<boolean> {
  // Use own-property lookup: no inherited profile names can be authorized.
  if (!Object.hasOwn(profiles, adapter)) return false;
  try { return await fingerprint(root, adapter as SourceProfile, signal) === profiles[adapter as SourceProfile].fingerprint; }
  catch { return false; }
}
