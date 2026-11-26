import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { contractFacts } from './contract-facts';
import { readBytes } from './read-ports';

const basePaths = ['docs/public-contracts.mdx', ...[
  'base_ci_red', 'config', 'delivery_labels', 'failure', 'journal', 'pi_activity',
  'run_state', 'runner_health', 'scene', 'scheduler_units', 'status_observe',
].map(name => `src/orbi/${name}.py`)];
const retentionPaths = [...basePaths, 'src/orbi/worktree_retention.py'];
const v0748Paths = [...retentionPaths, ...['blocked_record', 'comment_kind', 'progress', 'question', 'requeue'].map(name => `src/orbi/${name}.py`)];

// A subset profile pins every inspected file: any byte change rejects it.
// A contract profile pins the contract-facts manifest plus the two writer files
// the plugin reads whole. Other engine files may change; behavior changes with
// unchanged facts are not detected.
type SubsetProfile = { kind: 'subset'; commit: string; fingerprint: string; paths: readonly string[] };
type ContractProfile = { kind: 'contract'; commit: string; facts: string; writers: Readonly<Record<string, string>> };
export const profiles = {
  'orbi-0.7.41-release': { kind: 'subset', commit: 'fbafd09fe49a20299e96565f100633bca61ae2af', fingerprint: 'ff662193032fc0caf59e2742a3892c31af90a6d66726f38b2ac2256cb663140e', paths: [...basePaths].sort() },
  'orbi-0.7.41-1a8b2f96': { kind: 'subset', commit: '1a8b2f9603f6258cb105293f238a8d3f775f3393', fingerprint: 'ae5bd552aef7e1689b7352d99794f6dc0a04e257cf3668cad08be9473b9d859d', paths: [...retentionPaths].sort() },
  'orbi-0.7.48-release': {
    kind: 'subset', commit: 'f405e1dc4ff938ab99ec0742cfd3459d45e26948', fingerprint: 'f7d966479d4121b3cebecc116dd723eb0d0c7e2198d535b460230d06e118678e',
    paths: [...v0748Paths].sort(),
  },
  'orbi-0.7.65-release': {
    kind: 'contract', commit: 'a37c005cd2ff1657715ea11426ea1d8bbf9d09b2',
    facts: '1831c77a488fd75c93fbd24442b8d62c95410dc93a5553e404680caab38e7343',
    writers: {
      'src/orbi/runner_health.py': '01f882378aee9a59ed50ac8e98b50a9fe81dc1d02b53a86dd0746257fb645f79',
      'src/orbi/run_state.py': '00d8a40a8de85a3d19186928a82bb4c56a58d356c301a024dcb9a1432f8d1653',
    },
  },
} as const satisfies Record<string, SubsetProfile | ContractProfile>;
export type SourceProfile = keyof typeof profiles;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
// Subset: the pinned path manifest. Contract: the contract-facts manifest hash;
// compatible() additionally checks both whole writer files.
export async function fingerprint(root: string, profile: SourceProfile, signal?: AbortSignal) {
  const entry: SubsetProfile | ContractProfile = profiles[profile];
  if (entry.kind === 'contract') {
    const facts = await contractFacts(root, signal);
    if (!facts.ok) throw new Error(facts.reason);
    return sha(facts.manifest);
  }
  let manifest = '';
  for (const path of entry.paths) manifest += `${path}\0${sha(await readBytes(root, resolve(root, path), signal))}\n`;
  return sha(manifest);
}
export async function compatible(root: string, adapter: string, signal?: AbortSignal): Promise<boolean> {
  // Use own-property lookup: no inherited profile names can be authorized.
  if (!Object.hasOwn(profiles, adapter)) return false;
  try {
    const entry: SubsetProfile | ContractProfile = profiles[adapter as SourceProfile];
    if (entry.kind === 'subset') return await fingerprint(root, adapter as SourceProfile, signal) === entry.fingerprint;
    const facts = await contractFacts(root, signal);
    if (!facts.ok || sha(facts.manifest) !== entry.facts) return false;
    for (const [path, expected] of Object.entries(entry.writers)) {
      if (sha(await readBytes(root, resolve(root, path), signal)) !== expected) return false;
    }
    return true;
  } catch { return false; }
}
