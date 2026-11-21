import { constants } from 'node:fs';
import { lstat, realpath, stat, open, opendir } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ConfigRepository } from './config';
import { artifactNames, type ArtifactMetadata } from '../shared/blockers';
import type { WorkspaceShortcutStatus } from '../shared/workspace-shortcut';
import { WorkspaceShortcutInspector } from './workspace-shortcut';

export class ReadError extends Error {
  constructor(public readonly code: 'unsafe_path' | 'read_failed' | 'read_limit' | 'disposed' | 'process_failed' | 'process_timeout' | 'process_limit') { super(code); }
}
export const FILE_LIMIT = 256 * 1024;
export function absolutePath(path: string): boolean {
  return isAbsolute(path) && normalize(path) === path && !/[$~\x00-\x1f\x7f]/.test(path)
    && !path.split(sep).some(p => p === '.git' || p === 'env' || /^(?:lock|locks|lockfile|package-lock\.json|npm-shrinkwrap\.json)$/i.test(p) || /(?:\.lock$|provider)/i.test(p));
}

// Internal only: callers select finite approved files; no client path reaches this function.
async function checkedFile(root: string, path: string, metadataOnly: boolean, lifetime: { expired: boolean; close: () => Promise<void> }, range?: { start: number; length: number }) {
  if (!absolutePath(root) || !absolutePath(path)) throw new ReadError('unsafe_path');
  const rel = relative(root, path);
  if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw new ReadError('unsafe_path');
  try {
    // Reject symlink components (including authorized roots), not merely a final symlink.
    if (await realpath(root) !== root) throw new ReadError('unsafe_path');
    if (lifetime.expired) throw new ReadError('read_limit');
    if (await realpath(path) !== path) throw new ReadError('unsafe_path');
    if (lifetime.expired) throw new ReadError('read_limit');
    const before = await lstat(path);
    if (!before.isFile()) throw new ReadError('unsafe_path');
    if (lifetime.expired) throw new ReadError('read_limit');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    lifetime.close = () => handle.close();
    try {
      if (lifetime.expired) throw new ReadError('read_limit');
      const opened = await handle.stat();
      if (lifetime.expired) throw new ReadError('read_limit');
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || await realpath(path) !== path) throw new ReadError('unsafe_path');
      const after = await lstat(path);
      if (after.dev !== opened.dev || after.ino !== opened.ino) throw new ReadError('unsafe_path');
      const metadata = { size: opened.size, mtimeMs: opened.mtimeMs, identity: `${opened.dev}:${opened.ino}` };
      if (metadataOnly) return metadata;
      if (!range && opened.size > FILE_LIMIT) throw new ReadError('read_limit');
      const limit = range?.length ?? FILE_LIMIT;
      const bytes = Buffer.alloc(limit + (range ? 0 : 1));
      let count = 0;
      while (count < bytes.length) {
        if (lifetime.expired) throw new ReadError('read_limit');
        const chunk = await handle.read(bytes, count, bytes.length - count, (range?.start ?? 0) + count);
        if (!chunk.bytesRead) break;
        count += chunk.bytesRead;
      }
      if (count > limit) throw new ReadError('read_limit');
      const final = await handle.stat();
      if (final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) throw new ReadError('read_failed');
      if (lifetime.expired) throw new ReadError('read_limit');
      return range ? { ...metadata, bytes: bytes.subarray(0, count) } : bytes.subarray(0, count);
    } finally { await handle.close(); }
  } catch (error) { throw error instanceof ReadError ? error : new ReadError('read_failed'); }
}
async function boundedOperation<T>(work: (lifetime: { expired: boolean; close: () => Promise<void> }) => Promise<T>, signal?: AbortSignal) {
  const lifetime = { expired: false, close: async () => {} };
  let rejectCancellation!: (error: ReadError) => void;
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  const stop = (code: 'read_limit' | 'disposed') => {
    lifetime.expired = true;
    // Closing an OS file cannot cancel a stuck kernel operation. Bound the caller
    // regardless, close now when possible, and also close late opens in checkedFile.
    void lifetime.close().catch(() => undefined);
    rejectCancellation(new ReadError(code));
  };
  const abort = () => stop('disposed');
  const timer = setTimeout(() => stop('read_limit'), 10000);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new ReadError('disposed');
    return await Promise.race([work(lifetime), cancellation]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export async function boundedDirectory(path: string, signal?: AbortSignal) {
  return boundedOperation(async lifetime => {
    try {
      if (!absolutePath(path) || await realpath(path) !== path) throw new ReadError('unsafe_path');
      if (lifetime.expired) throw new ReadError('read_limit');
      if (!(await stat(path)).isDirectory()) throw new ReadError('unsafe_path');
      if (lifetime.expired) throw new ReadError('read_limit');
    } catch (error) { throw error instanceof ReadError ? error : new ReadError('read_failed'); }
  }, signal);
}
export async function boundedFile(root: string, path: string, metadataOnly = false, signal?: AbortSignal) {
  return boundedOperation(lifetime => checkedFile(root, path, metadataOnly, lifetime), signal);
}
export async function readBytes(root: string, path: string, signal?: AbortSignal): Promise<Buffer> {
  return await boundedFile(root, path, false, signal) as Buffer;
}
// Shared bounded child execution for every fixed operation: no shell, stdin
// ignored, at most two concurrent children, 10-second per-child ceiling and
// 1 MiB combined stdout/stderr. Timeout and disposal kill each child's own
// process group (helpers can inherit the output pipes), then reap the child.
class ChildOperations {
  constructor(private readonly children: Map<ChildProcess, () => Promise<void>>) {}
  async run(command: string, args: string[], timeoutMs: number, options: { includeHttpError?: boolean; fixedLocale?: boolean } = {}): Promise<string> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new ReadError('unsafe_path');
    if (this.children.size >= 2) throw new ReadError('process_limit');
    const env = options.fixedLocale ? { ...process.env, LC_ALL: 'C', LANG: 'C', SYSTEMD_COLORS: '0' } : process.env;
    return new Promise((resolveResult, reject) => {
      let child: ChildProcess;
      try { child = spawn(command, args, { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env }); }
      catch { reject(new ReadError('process_failed')); return; }
      let failure: ReadError | undefined;
      let length = 0;
      const output: Buffer[] = [];
      const stop = (code: ReadError['code']) => {
        failure ??= new ReadError(code);
        // Linux server: give each operation its own process group so helpers
        // cannot keep stdout/stderr alive after the direct child is killed.
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch { child.kill('SIGKILL'); }
        }
      };
      const timer = setTimeout(() => stop('process_timeout'), timeoutMs);
      const done = new Promise<void>(resolveDone => {
        child.once('close', code => {
          clearTimeout(timer); this.children.delete(child); resolveDone();
          if (failure) reject(failure);
          else {
            const text = Buffer.concat(output).toString('utf8');
            // gh exits nonzero for HTTP errors, but --include still supplies the
            // bounded status/headers needed for safe typed backoff. Never return stderr.
            if (code !== 0 && !(options.includeHttpError && /^HTTP\//.test(text))) reject(new ReadError('process_failed'));
            else resolveResult(text);
          }
        });
      });
      this.children.set(child, () => { stop('disposed'); return done; });
      child.once('error', () => { failure = new ReadError('process_failed'); });
      const collect = (stdout: boolean) => (chunk: Buffer) => {
        length += chunk.length;
        if (length > 1024 * 1024) stop('read_limit');
        else if (stdout && !failure) output.push(chunk);
      };
      child.stdout!.on('data', collect(true)); child.stderr!.on('data', collect(false));
    });
  }
  async dispose() { await Promise.all([...this.children.values()].map(stop => stop())); }
}

export type ProcessOperation =
  | { kind: 'systemctl-show'; slot: number; unit: 'service' | 'timer' }
  | { kind: 'journalctl'; slot: number }
  | { kind: 'gh-api-get'; resource: 'issues'; state?: 'all' | 'open'; page: number }
  | { kind: 'gh-api-get'; resource: 'comments' | 'dependencies' | 'issue'; issue: number; page: number }
  | { kind: 'gh-api-get'; resource: 'pull'; pr: number; page: number }
  | { kind: 'gh-api-get'; resource: 'checks'; sha: string; page: number };

export class ReadPorts {
  private disposed = false;
  private readonly lifetime = new AbortController();
  private readonly children = new Map<ChildProcess, () => Promise<void>>();
  private readonly operations = new ChildOperations(this.children);
  // One shared presence/type observer: at most one in-flight shortcut inspection per
  // plugin instance, with its own 1000 ms budget and capacity hold.
  private readonly shortcuts = new WorkspaceShortcutInspector();
  constructor(private readonly repository: ConfigRepository) {}
  clock() { return new Date(); }
  async read(id: string, selector: 'health') {
    this.assertActive();
    const deployment = this.repository.resolve(id);
    if (selector !== 'health') throw new ReadError('unsafe_path');
    const result = await readBytes(deployment.repoDir, resolve(deployment.repoDir, '.orbi/health.json'), this.lifetime.signal);
    this.assertActive();
    return result;
  }
  // Only these attributed selectors can reach worktree files. No path/cursor RPC.
  private tree(id: string, issue: number, runId: string) {
    this.assertActive();
    const deployment = this.repository.resolve(id);
    if (!Number.isSafeInteger(issue) || issue < 1 || !/^[0-9a-f]{8}$/.test(runId)) throw new ReadError('unsafe_path');
    return { root: deployment.repoDir, path: resolve(deployment.repoDir, '.worktrees', `orbi-${deployment.repo.replace('/', '-')}-issue-${issue}-${runId}`) };
  }
  private async names(root: string, path: string, match: (name: string, directory: boolean) => boolean, limit: number) {
    return boundedOperation(async lifetime => {
      if (!absolutePath(path) || !path.startsWith(root + sep) || await realpath(root) !== root || await realpath(path) !== path) throw new ReadError('unsafe_path');
      const directory = await opendir(path);
      lifetime.close = () => directory.close();
      const names: string[] = [];
      try {
        for await (const entry of directory) {
          if (lifetime.expired) throw new ReadError('read_limit');
          if (match(entry.name, entry.isDirectory()) && !entry.isSymbolicLink()) {
            names.push(entry.name);
            // Do not return an arbitrary filename/mtime-selected subset.
            if (names.length > limit) throw new ReadError('read_limit');
          }
        }
        return names.sort();
      } finally { await directory.close().catch(() => undefined); }
    }, this.lifetime.signal).catch(error => { throw error instanceof ReadError ? error : new ReadError('read_failed'); });
  }
  async worktrees(id: string, issue?: number) {
    this.assertActive();
    const deployment = this.repository.resolve(id);
    if (issue !== undefined && (!Number.isSafeInteger(issue) || issue < 1)) throw new ReadError('unsafe_path');
    const prefix = `orbi-${deployment.repo.replace('/', '-')}-issue-`;
    const parse = (name: string) => name.startsWith(prefix) ? name.slice(prefix.length).match(/^([1-9][0-9]*)-([0-9a-f]{8})$/) : null;
    const names = await this.names(deployment.repoDir, resolve(deployment.repoDir, '.worktrees'), (name, directory) => {
      const value = parse(name);
      return directory && !!value && Number.isSafeInteger(Number(value[1])) && (issue === undefined || Number(value[1]) === issue);
    }, 200);
    return names.map(name => { const match = parse(name)!; return { issue: Number(match[1]), runId: match[2] }; });
  }
  async runState(id: string, issue: number, runId: string) {
    const tree = this.tree(id, issue, runId);
    return readBytes(tree.root, resolve(tree.path, '.orbi/run-state.json'), this.lifetime.signal);
  }
  async sessions(id: string, issue: number, runId: string) {
    const tree = this.tree(id, issue, runId);
    return this.names(tree.root, resolve(tree.path, '.pi-session'), (name, directory) => !directory && /^[A-Za-z0-9_.-]{1,200}\.jsonl$/.test(name), 16);
  }
  async sessionRange(id: string, issue: number, runId: string, name: string, start: number, length: number) {
    const tree = this.tree(id, issue, runId);
    if (!/^[A-Za-z0-9_.-]{1,200}\.jsonl$/.test(name) || !Number.isSafeInteger(start) || start < 0 || !Number.isInteger(length) || length < 1 || length > FILE_LIMIT) throw new ReadError('unsafe_path');
    return await boundedOperation(lifetime => checkedFile(tree.root, resolve(tree.path, '.pi-session', name), false, lifetime, { start, length }), this.lifetime.signal) as { bytes: Buffer; size: number; identity: string; mtimeMs: number };
  }
  async stat(id: string, selector: 'health') {
    this.assertActive();
    const deployment = this.repository.resolve(id);
    if (selector !== 'health') throw new ReadError('unsafe_path');
    const result = await boundedFile(deployment.repoDir, resolve(deployment.repoDir, '.orbi/health.json'), true, this.lifetime.signal);
    this.assertActive();
    return result as { size: number; mtimeMs: number };
  }
  // Narrow metadata capability for one configured leaf: presence and type only.
  // No client path, no target read/follow/compare, no enumeration and no write.
  async shortcut(id: string): Promise<WorkspaceShortcutStatus> {
    this.assertActive();
    const deployment = this.repository.resolve(id);
    const result = await this.shortcuts.inspect(deployment.workspaceShortcut, deployment.shortcutProblem, () => this.disposed);
    return { deploymentId: deployment.id, state: result.state, observedAt: this.clock().toISOString(), problem: result.problem };
  }
  // Stat-only evidence. No scene path comes from a comment, client or directory scan.
  async statArtifact(id: string, issue: number, runId: string, name: ArtifactMetadata['name']): Promise<ArtifactMetadata> {
    this.assertActive();
    const deployment = this.repository.resolve(id);
    if (!Number.isSafeInteger(issue) || issue < 1 || !/^[0-9a-f]{8}$/.test(runId) || !artifactNames.includes(name)) throw new ReadError('unsafe_path');
    const empty = (status: ArtifactMetadata['status']): ArtifactMetadata => ({ name, status, size: null, modifiedAt: null });
    // Pinned gitops.worktree_path: exact repo slug, issue and selected formal run.
    const scene = `orbi-${deployment.repo.replace('/', '-')}-issue-${issue}-${runId}`;
    const parts = ['.worktrees', scene, ...(name === 'worktree' ? [] : name.split('/'))];
    try {
      return await boundedOperation(async lifetime => {
        if (!absolutePath(deployment.repoDir) || await realpath(deployment.repoDir) !== deployment.repoDir) return empty('invalid');
        let path = deployment.repoDir;
        for (let i = 0; i < parts.length; i++) {
          if (lifetime.expired) throw new ReadError('read_limit');
          path = resolve(path, parts[i]);
          const info = await lstat(path);
          if (lifetime.expired) throw new ReadError('read_limit');
          const directory = i < parts.length - 1 || name === 'worktree';
          if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) return empty('invalid');
          if (await realpath(path) !== path) return empty('invalid');
          if (i === parts.length - 1) {
            // Recheck identity after canonicalization to reject observed replacements.
            const after = await lstat(path);
            if (after.dev !== info.dev || after.ino !== info.ino || after.isSymbolicLink()) return empty('invalid');
            return { name, status: 'present', size: info.size, modifiedAt: info.mtime.toISOString() };
          }
        }
        return empty('invalid');
      }, this.lifetime.signal);
    } catch (error) {
      if (error instanceof ReadError && error.code === 'disposed') throw error;
      const code = (error as { code?: string }).code;
      return empty(code === 'ENOENT' ? 'missing' : code === 'ENOTDIR' ? 'invalid' : 'unreadable');
    }
  }
  private assertActive() { if (this.disposed) throw new ReadError('disposed'); }
  async process(id: string, operation: ProcessOperation, timeoutMs = 10000): Promise<string> {
    this.assertActive();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new ReadError('unsafe_path');
    const deployment = this.repository.resolve(id);
    let command: string, args: string[];
    if (operation.kind === 'systemctl-show' || operation.kind === 'journalctl') {
      if (!Number.isInteger(operation.slot) || operation.slot < 1 || operation.slot > deployment.capacity) throw new ReadError('unsafe_path');
      const prefix = deployment.unitName === null ? 'orbi' : `orbi-${deployment.unitName}`;
      if (operation.kind === 'systemctl-show') {
        if (operation.unit !== 'service' && operation.unit !== 'timer') throw new ReadError('unsafe_path');
        command = 'systemctl';
        args = ['--user', 'show', `${prefix}@${operation.slot}.${operation.unit}`, '--property=Id,LoadState,ActiveState,SubState,UnitFileState,Result,ExecMainCode,ExecMainStatus,NRestarts,LastTriggerUSec,NextElapseUSecRealtime,NextElapseUSecMonotonic', '--no-pager'];
      } else {
        command = 'journalctl'; args = ['--user', '-u', `${prefix}@${operation.slot}.service`, '--no-pager', '--since', '-1 hour', '-n', '200', '-o', 'json'];
      }
    } else if (operation.kind === 'gh-api-get') {
      if (!Number.isInteger(operation.page) || operation.page < 1 || operation.page > 10) throw new ReadError('unsafe_path');
      const root = `repos/${deployment.repo}`;
      let endpoint: string;
      const paging = `per_page=100&page=${operation.page}`;
      if (operation.resource === 'issues') {
        const state = operation.state ?? 'all';
        if (state !== 'all' && state !== 'open') throw new ReadError('unsafe_path');
        endpoint = `${root}/issues?state=${state}&sort=updated&direction=desc&${paging}`;
      } else if (operation.resource === 'comments' || operation.resource === 'dependencies' || operation.resource === 'issue') {
        if (!Number.isSafeInteger(operation.issue) || operation.issue < 1) throw new ReadError('unsafe_path');
        endpoint = `${root}/issues/${operation.issue}`;
        if (operation.resource !== 'issue') endpoint += `${operation.resource === 'comments' ? '/comments' : '/dependencies/blocked_by'}?${paging}`;
      } else if (operation.resource === 'pull') {
        if (!Number.isSafeInteger(operation.pr) || operation.pr < 1) throw new ReadError('unsafe_path');
        endpoint = `${root}/pulls/${operation.pr}`;
      } else if (operation.resource === 'checks') {
        if (!/^[0-9a-f]{40}$/.test(operation.sha)) throw new ReadError('unsafe_path');
        endpoint = `${root}/commits/${operation.sha}/check-runs?${paging}`;
      } else throw new ReadError('unsafe_path');
      command = 'gh'; args = ['api', '--hostname', 'github.com', '--method', 'GET', '--include',
        '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint];
    } else throw new ReadError('unsafe_path');
    return this.operations.run(command, args, timeoutMs, { includeHttpError: operation.kind === 'gh-api-get' });
  }
  // Dedicated host-scoped inventory port: two fixed systemctl argv forms only.
  // It never resolves a deployment/config entry, so a name match can never
  // become a repository read capability. The caller passes the remaining
  // overall deadline; the shared child ceiling, byte cap and disposal apply.
  async hostInventory(operation: 'runtime' | 'installed', timeoutMs = 10000): Promise<string> {
    this.assertActive();
    if (operation !== 'runtime' && operation !== 'installed') throw new ReadError('unsafe_path');
    const args = operation === 'runtime'
      ? ['--user', 'list-units', '--all', '--type=service,timer', '--plain', '--no-legend', '--no-pager', '--full', 'orbi*.service', 'orbi*.timer']
      : ['--user', 'list-unit-files', '--type=service,timer', '--no-legend', '--no-pager', '--full', 'orbi*.service', 'orbi*.timer'];
    // Fixed C locale and disabled colors keep the plain columns stable.
    return this.operations.run('systemctl', args, timeoutMs, { fixedLocale: true });
  }
  async dispose() {
    this.disposed = true;
    this.lifetime.abort();
    await this.operations.dispose();
  }
}
