import { constants } from 'node:fs';
import { lstat, open, stat, statfs } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Problem } from '../shared/common';
import type { ShortcutState } from '../shared/workspace-shortcut';
import type { ShortcutDescriptor } from './config';

// Presence/type only: the designated leaf is observed with lstat relative to a
// held parent descriptor. No readlink, leaf open, target stat/read, realpath or
// directory enumeration is performed here, and nothing is written.
export type ShortcutResult = Readonly<{ state: ShortcutState; problem: Problem | null }>;
type Held = { handle: FileHandle; dev: bigint; ino: bigint };
const BUDGET_MS = 1000;
// Linux PROC_SUPER_MAGIC from the pinned statfs(2) interface.
const PROC_SUPER_MAGIC = 0x9fa0n;
// Every component is opened relative to the previously held directory; O_NOFOLLOW
// refuses a symlink in the final pathname component instead of following it.
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const cannot = (code: Problem['code'], source: Problem['source'] = 'filesystem'): ShortcutResult =>
  ({ state: 'cannot_inspect', problem: { source, code } });
const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
};
// Only a final-component ENOENT proves absence. A missing or unusable parent,
// a non-directory component, a symlink component and denied access stay indeterminate.
const lookupFailure = (error: unknown): ShortcutResult => {
  const code = errorCode(error);
  if (code === 'ENOENT') return cannot('not_found');
  if (code === 'ELOOP' || code === 'ENOTDIR') return cannot('unsafe_path');
  return cannot('read_failed');
};
// Linux procfs is the only supported descriptor route: the filesystem type and
// this process's fd table are verified on every inspection. A one-time probe is
// not a defense against privileged overmounting or ptrace, so ordinary mounts
// and a trusted deployment remain assumptions, never a claim.
async function procfsRoute(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  if (!Number.isInteger(constants.O_DIRECTORY) || !Number.isInteger(constants.O_NOFOLLOW)) return false;
  try {
    const filesystem = await statfs('/proc', { bigint: true });
    // bigint:true is requested, but compare through BigInt so a numeric statfs result
    // never reads as a supported route by accident.
    if (BigInt(filesystem.type) !== PROC_SUPER_MAGIC) return false;
    return (await lstat('/proc/self/fd')).isDirectory();
  } catch { return false; }
}
async function identify(handle: FileHandle): Promise<Held> {
  const info = await handle.stat({ bigint: true });
  return { handle, dev: info.dev, ino: info.ino };
}
const fdPath = (held: Held) => `/proc/self/fd/${held.handle.fd}`;
// The fd route must still name the acquired directory rather than a reused or
// redirected descriptor.
async function heldRoute(held: Held): Promise<boolean> {
  const info = await stat(fdPath(held), { bigint: true });
  return info.dev === held.dev && info.ino === held.ino;
}

async function observe(descriptor: ShortcutDescriptor, expired: () => boolean, disposed: () => boolean) {
  const handles: FileHandle[] = [];
  const acquire = async (path: string) => {
    const handle = await open(path, DIRECTORY_FLAGS);
    handles.push(handle);
    return handle;
  };
  const stopped = (): ShortcutResult | null => disposed() ? cannot('disposed') : expired() ? cannot('deadline') : null;
  let result: ShortcutResult;
  try {
    result = await (async (): Promise<ShortcutResult> => {
      if (!await procfsRoute()) return cannot('runtime_unsupported');
      let parent = await identify(await acquire('/'));
      if (!await heldRoute(parent)) return cannot('unsafe_path');
      for (const component of descriptor.directory.slice(1).split('/')) {
        const stop = stopped(); if (stop) return stop;
        const child = await identify(await acquire(`${fdPath(parent)}/${component}`));
        // Revalidate both the new child and the retained parent route.
        if (!await heldRoute(child) || !await heldRoute(parent)) return cannot('unsafe_path');
        parent = child;
      }
      const stop = stopped(); if (stop) return stop;
      if (!await heldRoute(parent)) return cannot('unsafe_path');
      const anchor = { dev: parent.dev, ino: parent.ino };
      // No trailing slash: the leaf itself is observed, never a directory it names.
      const leaf = await lstat(`${fdPath(parent)}/${descriptor.name}`, { bigint: true })
        .then(info => ({ info }), error => ({ error }));
      const after = await identify(parent.handle);
      if (after.dev !== anchor.dev || after.ino !== anchor.ino || !await heldRoute(parent)) return cannot('unsafe_path');
      const finalStop = stopped(); if (finalStop) return finalStop;
      // Only this final lookup's ENOENT proves absence under the established anchor.
      if ('error' in leaf) return errorCode(leaf.error) === 'ENOENT' ? { state: 'absent', problem: null } : lookupFailure(leaf.error);
      // A dangling symlink is still a symlink; any other type is only present.
      return { state: leaf.info.isSymbolicLink() ? 'symlink' : 'not_symlink', problem: null };
    })();
  } catch (error) { result = lookupFailure(error); }
  let leaked = false;
  for (const handle of [...handles].reverse()) {
    // A close failure means an uncertain leaked descriptor: the caller keeps the
    // capacity hold instead of admitting unbounded work.
    try { await handle.close(); } catch { leaked = true; }
  }
  return { result, leaked };
}

export class WorkspaceShortcutInspector {
  private active = 0;
  async inspect(descriptor: ShortcutDescriptor | null, problem: Problem | null, disposed: () => boolean): Promise<ShortcutResult> {
    if (disposed()) return cannot('disposed');
    if (descriptor === null) return { state: 'not_configured', problem };
    if (this.active > 0) return cannot('read_limit');
    this.active++;
    const startedAt = performance.now();
    const expired = () => performance.now() - startedAt >= BUDGET_MS;
    const work = observe(descriptor, expired, disposed).then(
      value => ({ kind: 'settled' as const, value }),
      () => ({ kind: 'settled' as const, value: { result: cannot('read_failed'), leaked: true } }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<{ kind: 'deadline' }>(resolve => { timer = setTimeout(() => resolve({ kind: 'deadline' }), BUDGET_MS); });
    const outcome = await Promise.race([work, deadline]);
    if (outcome.kind === 'deadline') {
      // Node cannot cancel an in-flight open/lstat. Return after expiry without
      // scheduling another step or publishing a late result, and keep the
      // capacity reservation until the unsettled work releases its descriptors.
      void work.then(value => { if (!value.value.leaked) this.active--; });
      return cannot('deadline');
    }
    clearTimeout(timer);
    if (!outcome.value.leaked) this.active--;
    return outcome.value.result;
  }
}
