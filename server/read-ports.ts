import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ConfigRepository } from './config';

export class ReadError extends Error {
  constructor(public readonly code: 'unsafe_path' | 'read_failed' | 'read_limit' | 'disposed' | 'process_failed' | 'process_timeout' | 'process_limit') { super(code); }
}
export const FILE_LIMIT = 256 * 1024;
export function absolutePath(path: string): boolean {
  return isAbsolute(path) && normalize(path) === path && !/[$~\x00-\x1f\x7f]/.test(path)
    && !path.split(sep).some(p => p === '.git' || p === 'env' || /^(?:lock|locks|lockfile|package-lock\.json|npm-shrinkwrap\.json)$/i.test(p) || /(?:\.lock$|provider)/i.test(p));
}

// Internal only: callers select finite approved files; no client path reaches this function.
async function checkedFile(root: string, path: string, metadataOnly: boolean, lifetime: { expired: boolean; close: () => Promise<void> }) {
  if (!absolutePath(root) || !absolutePath(path)) throw new ReadError('unsafe_path');
  const rel = relative(root, path);
  if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw new ReadError('unsafe_path');
  try {
    // Reject symlink components (including authorized roots), not merely a final symlink.
    if (await realpath(root) !== root || await realpath(path) !== path) throw new ReadError('unsafe_path');
    const before = await lstat(path);
    if (!before.isFile()) throw new ReadError('unsafe_path');
    if (lifetime.expired) throw new ReadError('read_limit');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    lifetime.close = () => handle.close();
    try {
      if (lifetime.expired) throw new ReadError('read_limit');
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || await realpath(path) !== path) throw new ReadError('unsafe_path');
      const after = await lstat(path);
      if (after.dev !== opened.dev || after.ino !== opened.ino) throw new ReadError('unsafe_path');
      if (metadataOnly) return { size: opened.size, mtimeMs: opened.mtimeMs };
      if (opened.size > FILE_LIMIT) throw new ReadError('read_limit');
      const bytes = Buffer.alloc(FILE_LIMIT + 1);
      let count = 0;
      while (count <= FILE_LIMIT) {
        if (lifetime.expired) throw new ReadError('read_limit');
        const chunk = await handle.read(bytes, count, bytes.length - count, count);
        if (!chunk.bytesRead) break;
        count += chunk.bytesRead;
      }
      if (count > FILE_LIMIT) throw new ReadError('read_limit');
      const final = await handle.stat();
      if (final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) throw new ReadError('read_failed');
      if (lifetime.expired) throw new ReadError('read_limit');
      return bytes.subarray(0, count);
    } finally { await handle.close(); }
  } catch (error) { throw error instanceof ReadError ? error : new ReadError('read_failed'); }
}
export async function boundedFile(root: string, path: string, metadataOnly = false, signal?: AbortSignal) {
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
    return await Promise.race([checkedFile(root, path, metadataOnly, lifetime), cancellation]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export async function readBytes(root: string, path: string, signal?: AbortSignal): Promise<Buffer> {
  return await boundedFile(root, path, false, signal) as Buffer;
}
export type ProcessOperation =
  | { kind: 'systemctl-show'; slot: number; unit: 'service' | 'timer' }
  | { kind: 'journalctl'; slot: number }
  | { kind: 'gh-api-get'; resource: 'issues'; page: number }
  | { kind: 'gh-api-get'; resource: 'comments'; issue: number; page: number };

export class ReadPorts {
  private disposed = false;
  private readonly lifetime = new AbortController();
  private children = new Map<ChildProcess, () => Promise<void>>();
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
  async stat(id: string, selector: 'health') {
    this.assertActive();
    const deployment = this.repository.resolve(id);
    if (selector !== 'health') throw new ReadError('unsafe_path');
    const result = await boundedFile(deployment.repoDir, resolve(deployment.repoDir, '.orbi/health.json'), true, this.lifetime.signal);
    this.assertActive();
    return result as { size: number; mtimeMs: number };
  }
  private assertActive() { if (this.disposed) throw new ReadError('disposed'); }
  async process(id: string, operation: ProcessOperation): Promise<string> {
    this.assertActive();
    const deployment = this.repository.resolve(id);
    let command: string, args: string[];
    if (operation.kind === 'systemctl-show' || operation.kind === 'journalctl') {
      if (!Number.isInteger(operation.slot) || operation.slot < 1 || operation.slot > deployment.capacity) throw new ReadError('unsafe_path');
      const prefix = deployment.unitName === null ? 'orbi' : `orbi-${deployment.unitName}`;
      if (operation.kind === 'systemctl-show') {
        if (operation.unit !== 'service' && operation.unit !== 'timer') throw new ReadError('unsafe_path');
        command = 'systemctl';
        args = ['--user', 'show', `${prefix}@${operation.slot}.${operation.unit}`, '--property=ActiveState,SubState,Result,ExecMainStatus,NextElapseUSecRealtime', '--no-pager'];
      } else {
        command = 'journalctl'; args = [`--user-unit=${prefix}@${operation.slot}.service`, '--output=json', '--lines=100', '--no-pager'];
      }
    } else if (operation.kind === 'gh-api-get') {
      if (!Number.isInteger(operation.page) || operation.page < 1 || operation.page > 10) throw new ReadError('unsafe_path');
      let endpoint = `repos/${deployment.repo}/issues`;
      if (operation.resource === 'comments') {
        if (!Number.isSafeInteger(operation.issue) || operation.issue < 1) throw new ReadError('unsafe_path');
        endpoint += `/${operation.issue}/comments`;
      } else if (operation.resource !== 'issues') throw new ReadError('unsafe_path');
      command = 'gh'; args = ['api', '--hostname', 'github.com', '--method', 'GET', `${endpoint}?per_page=100&page=${operation.page}`];
    } else throw new ReadError('unsafe_path');
    if (this.children.size >= 2) throw new ReadError('process_limit');
    return new Promise((resolveResult, reject) => {
      let child: ChildProcess;
      try { child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: process.env }); }
      catch { reject(new ReadError('process_failed')); return; }
      let failure: ReadError | undefined;
      let length = 0;
      const output: Buffer[] = [];
      const stop = (code: ReadError['code']) => { failure ??= new ReadError(code); child.kill('SIGKILL'); };
      const timer = setTimeout(() => stop('process_timeout'), 10000);
      const done = new Promise<void>(resolveDone => {
        child.once('close', code => {
          clearTimeout(timer); this.children.delete(child); resolveDone();
          if (failure) reject(failure);
          else if (code !== 0) reject(new ReadError('process_failed'));
          else resolveResult(Buffer.concat(output).toString('utf8'));
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
  async dispose() {
    this.disposed = true;
    this.lifetime.abort();
    await Promise.all([...this.children.values()].map(stop => stop()));
  }
}
