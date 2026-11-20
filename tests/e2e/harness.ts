import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ChildProcess } from 'node:child_process';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, realpath, lstat, readdir, rm, chmod, symlink, readlink, access, stat, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fixture } from '../helpers/fixtures';

const exec = promisify(execFile);
export type Inputs = { repo: string; sha: string; output: string; approval: string };
const approvalUrl = (issue: 12 | 13) => new RegExp(`^https://github\\.com/TrebuchetDynamics/paseo-orbi/issues/${issue}#issuecomment-\\d+$`);
function explicit(env: NodeJS.ProcessEnv, issue: 12 | 13, message: string): Inputs {
  if (env.PASEO_E2E_ENABLE_TRUSTED_PLUGINS !== '1' || !approvalUrl(issue).test(env.PASEO_E2E_APPROVAL_URL ?? '')) throw new Error(message);
  const repo = env.PASEO_E2E_CANDIDATE_REPO ?? '', sha = env.PASEO_E2E_CANDIDATE_SHA ?? '', output = env.PASEO_E2E_OUTPUT ?? '';
  if (!isAbsolute(repo) || resolve(repo) !== repo || !/^[0-9a-f]{40}$/.test(sha) || !isAbsolute(output) || resolve(output) !== output || !output.includes('/.artifacts/paseo-qualification/') || output === repo || output.startsWith(repo + '/node_modules/'))
    throw new Error('Explicit absolute candidate repository, committed full SHA and new .artifacts/paseo-qualification/<run-id> output required.');
  return { repo, sha, output, approval: env.PASEO_E2E_APPROVAL_URL! };
}
export function approveLaunch(env: NodeJS.ProcessEnv, effect: (input: Inputs) => unknown) {
  // Browser consent on #12 never authorizes the native lane, and vice versa.
  return effect(explicit(env, 12, 'Owner approval required on execution issue #12. Read and verify the trusted-plugin consent before setting the approval URL and flag.'));
}
export function approveNativeLaunch(env: NodeJS.ProcessEnv, effect: (input: Inputs) => unknown) {
  return effect(explicit(env, 13, 'Owner approval required on execution issue #13. Read and verify the Linux native trusted-plugin consent before setting the approval URL and flag.'));
}
export function isolation(root: string, home: string, host: string, owned: boolean, fresh: boolean) {
  if (!isAbsolute(root) || !home.startsWith(root + '/') || resolve(home) !== home || !owned || !fresh || !/^tcp:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(host) || Number(host.split(':').at(-1)) > 65535)
    throw new Error('Refusing nonisolated home or unsafe/unowned host');
}
export async function checkFreshPath(path: string, inspect: (path: string) => Promise<{ isSymbolicLink: () => boolean }> = lstat) {
  let current = path;
  while (true) {
    try {
      const info = await inspect(current);
      if (current === path || info.isSymbolicLink()) throw new Error('Reused/outside or symlink runtime/evidence path');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
export function environment(root: string, bin: string, home: string): NodeJS.ProcessEnv {
  return { PATH: `${bin}:${dirname(process.execPath)}`, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'),
    TMPDIR: join(root, 'tmp'), LANG: 'C.UTF-8', TZ: 'UTC', CI: '1', NO_COLOR: '1',
    NPM_CONFIG_USERCONFIG: join(root, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: join(root, 'global-npmrc'), NPM_CONFIG_CACHE: join(root, 'npm-cache'),
    PLAYWRIGHT_BROWSERS_PATH: join(root, 'browser-cache'), PASEO_HOME: home, PASEO_ORBI_E2E_OWNER: root };
}
export async function boundedWait(check: () => Promise<boolean>, ms: number, sleep: (ms: number) => Promise<void> = pause, now = Date.now) {
  const deadline = now() + ms;
  do { const ready = await check(); if (ready && now() <= deadline) return; if (now() >= deadline) break; await sleep(Math.min(100, deadline - now())); } while (now() <= deadline);
  throw new Error(`Qualification deadline exceeded (${ms}ms); inspect sanitized evidence and repair prerequisites.`);
}
export async function reservePort() {
  const server = createServer();
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const port = (server.address() as { port: number }).port;
  return { port, release: () => new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok())) };
}
export async function portClosed(port: number) {
  const server = createServer();
  return new Promise<boolean>(ok => { server.once('error', () => ok(false)); server.listen(port, '127.0.0.1', () => server.close(() => ok(true))); });
}
export type Identity = { pid: number; ppid: number; pgid: number; start: string };
export async function identity(pid: number): Promise<Identity | null> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    if (['Z', 'X', 'x'].includes(fields[0])) return null;
    return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19] };
  } catch { return null; }
}
export async function processTable() {
  return (await Promise.all((await readdir('/proc')).filter(n => /^\d+$/.test(n)).map(n => identity(Number(n))))).filter((p): p is Identity => !!p);
}
const same = (a: Identity | null, b: Identity | null): boolean => !!a && !!b && a.pid === b.pid && a.pgid === b.pgid && a.start === b.start;
export async function stopOwned(owned: Identity[], seams: { table: () => Promise<Identity[]>; signal: (pgid: number, signal: NodeJS.Signals) => unknown; sleep: (ms: number) => Promise<void>;
  reconcile?: () => Promise<Identity[]>; validate?: (group: Identity[]) => Promise<void>; deadline?: number; now?: () => number;
} = { table: processTable, signal: (pgid, signal) => process.kill(-pgid, signal), sleep: pause }) {
  const now = seams.now ?? (() => Number(process.hrtime.bigint()) / 1e6), deadline = seams.deadline ?? now() + 4000;
  const ownGroup = (await identity(process.pid))?.pgid;
  if (!ownGroup) throw new Error('Cannot observe harness kernel PGID; cleanup refused');
  const errors = new Set<string>();
  const check = async () => {
    try { if (seams.reconcile) for (const p of await seams.reconcile()) if (!owned.some(q => same(p, q))) owned.push(p); } catch (error) { errors.add(String(error)); }
    const table = await seams.table(), live = owned.filter(p => table.some(q => same(p, q))), safe: Identity[] = [];
    for (const group of new Set(live.map(p => p.pgid))) {
      try {
        if (group <= 1 || group === ownGroup) throw new Error('Unsafe process group: harness actual kernel PGID refused');
        const members = table.filter(p => p.pgid === group);
        if (members.some(p => !owned.some(q => same(p, q)))) throw new Error('Unaccounted descendant/group member: cleanup refused');
        if (owned.some(p => p.pgid === group && table.some(q => q.pid === p.pid && !same(p, q)))) throw new Error('PID reuse: cleanup identity mismatch');
        await seams.validate?.(members);
        safe.push(...members);
      } catch (error) { errors.add(String(error)); }
    }
    for (const p of owned) if (table.some(q => q.pid === p.pid && !same(p, q))) errors.add('PID reuse: cleanup identity mismatch');
    return { live, safe };
  };
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const { safe } = await check();
    for (const group of new Set(safe.map(p => p.pgid))) {
      // Reconcile identity, executable and group membership immediately before EACH signal.
      const current = await check();
      if (!current.safe.some(p => p.pgid === group)) continue;
      if (now() >= deadline) { errors.add('Fixed shutdown deadline exceeded'); break; }
      try { seams.signal(group, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') errors.add(String(e)); }
      await check();
    }
    for (let n = 0; n < 20 && now() < deadline; n++) {
      if (!(await check()).live.length) { if (errors.size) throw new Error([...errors].join('; ')); return; }
      await seams.sleep(Math.min(50, Math.max(0, deadline - now())));
    }
  }
  if ((await check()).live.length) errors.add('Owned subprocess survived bounded TERM/KILL cleanup');
  if (errors.size) throw new Error([...errors].join('; '));
}
export function sanitize(text: string, roots: string[] = []) {
  let result = text.replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+|[A-Z_]*(?:SECRET|TOKEN|PROMPT|REASONING|PRIVATE)[A-Z_]*CANARY)/gi, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@').replace(/[?&](?:token|password|key)=[^\s&]+/gi, '?[REDACTED]').replace(/\/(?:home|Users)\/[^/\s]+/g, '[PROFILE]');
  for (const root of roots.filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(root).join('[OWNED]');
  return result;
}
export async function command(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeout = 60000) {
  if (file === process.execPath && args[0] === resolve('tests/e2e/runtime/node_modules/@getpaseo/cli/bin/paseo')) {
    if (env.NODE_OPTIONS || env.ORBI_PROCESS_CONFIG || args[1] !== '--host' || args[2] !== `tcp://${env.PASEO_LISTEN}` || args[3] !== 'plugin' || await realpath(cwd) !== cwd) throw new Error('Qualification management environment/endpoint refused');
    managementArgs(args.slice(4), cwd);
  }
  return (await exec(file, args, { env, cwd, timeout, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' })).stdout;
}
export type InstallationHost = {
  alias: string; host: string; installation: 'never-attempted' | 'uncertain' | 'confirmed';
  cliCall: (...args: string[]) => Promise<string>;
};
function pluginList(text: string): { id: string }[] {
  const rows = JSON.parse(text);
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string')) throw new Error('Invalid plugin list response');
  return rows;
}
function diagnostic(error: unknown) {
  const detail = error as { stderr?: string; stdout?: string } | null;
  return sanitize([String(error), detail?.stderr, detail?.stdout].filter(Boolean).join('\n'));
}
export async function exposePs(bin: string, effects = { access, symlink }) {
  try { await effects.access('/usr/bin/ps', constants.X_OK); }
  catch { throw new Error('Missing runtime prerequisite: executable /usr/bin/ps required before daemon launch'); }
  await effects.symlink('/usr/bin/ps', join(bin, 'ps'));
}
export async function installWhenRpcReady(host: InstallationHost & { candidate: string; startup: { deadline: number } }, sleep: (ms: number) => Promise<void> = pause, now = Date.now) {
  const remaining = host.startup.deadline - now();
  if (remaining <= 0) throw new Error('60-second host startup deadline exceeded');
  await boundedWait(async () => {
    if (now() >= host.startup.deadline) throw new Error('60-second host startup deadline exceeded');
    try { pluginList(await host.cliCall('ls', '--json')); return true; }
    catch (error) {
      // Pinned CLI's pre-ready WebSocket upgrade rejection, not arbitrary 503s/refusals.
      const stderr = (error as { stderr?: string })?.stderr ?? '';
      let response: { code?: string; message?: string } | undefined;
      try { response = JSON.parse(stderr).error; } catch { /* non-JSON failures are not startup readiness */ }
      if (response?.code === 'DAEMON_UNREACHABLE' && response.message === `Cannot connect to daemon at ${host.host}: Unexpected server response: 503`) return false;
      throw error;
    }
  }, remaining, sleep, now);
  if (now() >= host.startup.deadline) throw new Error('60-second host startup deadline exceeded');
  host.installation = 'uncertain'; // never automatically retry a possibly server-side install
  await host.cliCall('install', host.candidate, '--id', 'paseo-orbi');
  host.installation = 'confirmed';
}
export async function cleanupInstallations<T extends InstallationHost>(hosts: T[], effects: {
  snapshot: () => Promise<Identity[]>; stop: (owned: Identity[]) => Promise<void>;
  verify: (owned: Identity[]) => Promise<void>; log: (host: T) => Promise<void>; safe?: () => Identity[];
}) {
  const errors: string[] = [], removals: { host: string; state: T['installation']; operation: string; diagnostic?: string }[] = [];
  let owned: Identity[] = [];
  try { owned = await effects.snapshot(); } catch (error) { errors.push(diagnostic(error)); }
  for (const host of hosts) {
    const removal = { host: host.alias, state: host.installation, operation: 'not-attempted', diagnostic: undefined as string | undefined };
    removals.push(removal);
    try {
      if (host.installation !== 'never-attempted') {
        removal.operation = 'unresolved';
        if (host.installation === 'uncertain' && !pluginList(await host.cliCall('ls', '--json')).some(row => row.id === 'paseo-orbi')) {
          // This observation is neither a remove success nor proof an in-flight install stopped.
          removal.operation = 'absent-after-uncertain';
        } else {
          await host.cliCall('remove', 'paseo-orbi'); removal.operation = 'removed';
        }
      }
    } catch (error) {
      removal.diagnostic = diagnostic(error);
      errors.push(`Removal unresolved: ${host.alias}: ${removal.diagnostic}`);
    }
    try { await effects.log(host); } catch (error) { errors.push(diagnostic(error)); }
  }
  // Always account for processes again, even after an empty list or removal error.
  // A failed ownership snapshot is not permission to signal unknown processes.
  let snapshotValid = true;
  try { owned = [...owned, ...await effects.snapshot()]; } catch (error) { snapshotValid = false; errors.push(diagnostic(error)); }
  if (snapshotValid || effects.safe) {
    try { await effects.stop([...owned, ...effects.safe?.() ?? []]); } catch (error) { errors.push(diagnostic(error)); }
  }
  try { await effects.verify(owned); } catch (error) { errors.push(diagnostic(error)); }
  return { errors, removals };
}
export async function finishFailedStart(primary: unknown, cleanup: () => Promise<void>): Promise<never> {
  try { await cleanup(); }
  catch (secondary) { throw new AggregateError([primary, secondary], `Startup failed: ${String(primary)}; cleanup failed: ${String(secondary)}`); }
  throw primary;
}
export async function prepareTelemetry(root: string, alias: string, profile: 'release' | 'installed') {
  const data = await fixture(profile, root); // existing pinned source data, no engine execution
  const registry = join(root, `${alias}-reads.jsonl`), calls = join(root, `${alias}-calls.jsonl`), state = join(root, `${alias}-state.json`);
  await writeFile(registry, ''); await writeFile(calls, '');
  const records = JSON.parse(await readFile(new URL('../fixtures/runs/records.json', import.meta.url), 'utf8'));
  const guidance = JSON.parse(await readFile(new URL('../fixtures/blockers/guidance.json', import.meta.url), 'utf8'));
  const scene = join(data.repoDir, '.worktrees/orbi-Example-project-issue-42-84360d31');
  await mkdir(join(scene, '.orbi'), { recursive: true }); await mkdir(join(scene, '.pi-session'));
  await writeFile(join(scene, '.orbi/run-state.json'), JSON.stringify({ repo: 'Example/project', issue: 42, run_id: '84360d31', branch: 'orbi/Example-project-issue-42', created_at: new Date().toISOString() }));
  await writeFile(join(scene, '.pi-session/one.jsonl'), [records.session, records.message].map(r => JSON.stringify(r)).join('\n') + '\n');
  const setState = async (scenario: string) => {
    await writeFile(state, JSON.stringify({ scenario, alias, records, guidance }));
    await mkdir(join(data.repoDir, '.orbi'), { recursive: true });
    await writeFile(join(data.repoDir, '.orbi/health.json'), ['unavailable', 'partial', 'stale'].includes(scenario) ? '{}' : JSON.stringify({ runs: scenario === 'empty' ? [] : [{ repo: 'Example/project', issue: 42, run_id: '84360d31', outcome: 'pr_opened', fingerprint: 'synthetic', ts: Date.now() / 1000 }], last_pickup_ts: Date.now() / 1000, alerted: [] }));
  };
  await setState('available');
  return { data, registry, calls, state, setState };
}
// All registration records are requests, never authority. Kernel capture plus the exact
// immutable launch specification is the only route into this cumulative ledger.
const protocol = createRequire(import.meta.url)('./fixtures/process-register.cjs');
export const psArguments: (parent: string, args: string[]) => boolean = protocol.psArguments;
export const monotonic: () => number = protocol.now;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export type ProcessSpec = { role: 'root' | 'supervisor' | 'daemon' | 'plugin' | 'terminal-launcher' | 'terminal-worker' | 'fixture' | 'ps' | 'esbuild'; entry: string; digest: string;
  args: string[] | 'launcher' | 'worker' | 'fixture' | 'ps'; nodeArgs?: string[]; native?: { target: string; digest: string } };
type Captured = { identity: Identity; spec: ProcessSpec; args: string[]; nativeObserved: boolean };
const edges: Record<string, string[]> = { root: ['supervisor'], supervisor: ['daemon'], daemon: ['plugin', 'terminal-launcher', 'ps', 'esbuild'], 'terminal-launcher': ['terminal-worker'], 'terminal-worker': ['ps'], plugin: ['fixture'] };
export function registrationRuntime(version = process.version, platform = process.platform, execve = (process as unknown as { execve?: unknown }).execve) {
  if (version !== 'v22.19.0' || platform !== 'linux' || typeof execve !== 'function') throw new Error('Process registration requires Linux Node 22.19.0 with process.execve; no spawn fallback');
}
export function managementArgs(args: string[], candidate: string) {
  const text = JSON.stringify(args), exact = (a: string[]) => text === JSON.stringify(a);
  if (isAbsolute(candidate) && resolve(candidate) === candidate && exact(['install', candidate, '--id', 'paseo-orbi'])) return args;
  if (exact(['ls', '--json']) || exact(['ls', 'paseo-orbi', '--json']) || ['remove', 'reload', 'enable', 'disable'].some(op => exact([op, 'paseo-orbi']))) return args;
  throw new Error('Qualification management command refused: exact candidate-directory installation and fixed paseo-orbi operations only');
}
export async function createRegistration(input: { root: string; home: string; directory: string; env: NodeJS.ProcessEnv; specs: ProcessSpec[]; startupDeadline: number; runtime?: string; esbuild?: string }) {
  registrationRuntime();
  if (input.env.PASEO_ORBI_E2E_OWNER !== input.root || input.env.PASEO_HOME !== input.home || await realpath(input.root) !== input.root || await realpath(input.home) !== input.home || !input.directory.startsWith(input.root + '/') || resolve(input.directory) !== input.directory) throw new Error('Registration requires canonical owned host invariants');
  await mkdir(input.directory, { mode: 0o700 });
  const collector = await identity(process.pid);
  if (!collector) throw new Error('Cannot capture collector kernel identity');
  const preload = join(input.directory, 'process-register.cjs'), gate = join(input.directory, 'native-exec-gate.cjs');
  await writeFile(preload, await readFile(new URL('./fixtures/process-register.cjs', import.meta.url)), { mode: 0o400, flag: 'wx' });
  await writeFile(gate, await readFile(new URL('./fixtures/native-exec-gate.cjs', import.meta.url)), { mode: 0o400, flag: 'wx' });
  const preloadDigest = hash(await readFile(preload)), gateDigest = hash(await readFile(gate));
  const configPath = join(input.directory, 'config.json');
  const node = await realpath(process.execPath), nodeStat = await stat(node), nodeDigest = hash(await readFile(node));
  const config = { directory: input.directory, home: input.home, session: `${input.root}:${input.home}`, collector, specs: input.specs,
    runtime: input.runtime, esbuild: input.esbuild, node, nodeDigest };
  const env: NodeJS.ProcessEnv = { ...input.env, NODE_OPTIONS: `--require=${preload}`, ORBI_PROCESS_CONFIG: configPath };
  delete env.ESBUILD_BINARY_PATH;
  const invariants = ['PASEO_ORBI_E2E_OWNER', 'PASEO_HOME', 'PATH', 'NODE_OPTIONS', 'ORBI_PROCESS_CONFIG', 'ORBI_E2E_REGISTRY'] as const;
  const ledger: Captured[] = [], errors: string[] = [], seen = new Map<string, string>(), acknowledgments = new Map<string, string>(), requests = new Map<number, string>(), pending = new Map<string, number>();
  let rootChild: ChildProcess | undefined, anchor: Identity | null = null, timer: NodeJS.Timeout | undefined;
  let phase: 'startup' | 'running' | 'shutdown' = 'startup';
  let deadline = monotonic() + Math.max(0, input.startupDeadline - performance.now());
  let collecting: Promise<void> | undefined, configDigest = '';
  const failure = (error: unknown) => { const message = String(error); if (!errors.length) errors.push(message.slice(0, 1024)); protocol.fail(input.directory, message); };
  const writeControl = async () => {
    const path = join(input.directory, 'control');
    await writeFile(path + '.tmp', JSON.stringify({ session: config.session, phase, deadline }), { mode: 0o600, flag: 'wx' });
    await rename(path + '.tmp', path);
  };
  const configure = async (specs: ProcessSpec[]) => {
    if (rootChild) throw new Error('Registration launch configuration is immutable');
    config.specs = structuredClone(specs);
    const bytes = JSON.stringify(config);
    if (Buffer.byteLength(bytes) > 65536 || specs.length > 16) throw new Error('Registration configuration capacity exceeded');
    await writeFile(configPath + '.tmp', bytes, { mode: 0o400, flag: 'wx' });
    await rename(configPath + '.tmp', configPath);
    configDigest = hash(bytes);
  };
  await configure(input.specs); await writeControl();
  async function validateProcess(p: Identity, spec: ProcessSpec, args?: string[]) {
    const live = await identity(p.pid);
    if (!live || !same(p, live)) throw new Error('Registration child dead/reused');
    const exe = await readlink(`/proc/${p.pid}/exe`), executable = await stat(`/proc/${p.pid}/exe`);
    if (exe !== node || executable.dev !== nodeStat.dev || executable.ino !== nodeStat.ino || executable.size !== nodeStat.size || executable.mtimeMs !== nodeStat.mtimeMs || executable.ctimeMs !== nodeStat.ctimeMs) throw new Error('Unrecognized executable/runtime content');
    const argv = protocol.read(`/proc/${p.pid}/cmdline`, 16384).split('\0').filter(Boolean);
    const nodeArgs = spec.nodeArgs ?? [];
    if (argv[0] !== process.execPath || JSON.stringify(argv.slice(1, 1 + nodeArgs.length)) !== JSON.stringify(nodeArgs) || argv[1 + nodeArgs.length] !== spec.entry || !protocol.argsMatch(spec, argv.slice(2 + nodeArgs.length), config)) throw new Error('Exact entry/argv provenance mismatch');
    if (args && JSON.stringify(args) !== JSON.stringify(argv.slice(2 + nodeArgs.length))) throw new Error('Spawn argv mismatch');
    if (await realpath(spec.entry) !== spec.entry || hash(await readFile(spec.entry)) !== spec.digest) throw new Error('Entry content mismatch');
    const values = protocol.read(`/proc/${p.pid}/environ`, 65536).split('\0');
    for (const key of invariants) if (env[key] !== undefined && !values.includes(`${key}=${env[key]}`)) throw new Error(`Immutable host invariant mismatch: ${key}`);
    for (const field of values.filter(Boolean)) {
      const split = field.indexOf('='), key = field.slice(0, split), value = field.slice(split + 1);
      if (key === 'ESBUILD_BINARY_PATH' && value === config.esbuild) continue;
      if (key === 'LC_ALL' && value === 'C' && spec.role === 'ps') continue;
      if (key === 'ELECTRON_RUN_AS_NODE' && value === '1' && ['terminal-launcher', 'terminal-worker', 'ps'].includes(spec.role)) continue;
      if (key === 'NODE_CHANNEL_FD' && value === '3' && ['daemon', 'plugin'].includes(spec.role)) continue;
      if (key === 'NODE_CHANNEL_SERIALIZATION_MODE' && value === (spec.role === 'plugin' ? 'advanced' : 'json') && ['daemon', 'plugin'].includes(spec.role)) continue;
      if (env[key] !== value) throw new Error(`Unrecognized role environment overlay: ${key}`);
    }
    // Source-supported overlays (LC_ALL=C, Node IPC, ELECTRON_RUN_AS_NODE) are
    // deliberately not compared as an identical environment. Restored esbuild is
    // not necessarily visible in exec-time /proc/environ.
    if (!same(p, (await identity(p.pid))!)) throw new Error('Registration identity changed during validation');
    return argv.slice(2 + nodeArgs.length) as string[];
  }
  async function verify(group?: Identity[]) {
    for (const captured of ledger.filter(c => !group || group.some(p => same(p, c.identity)))) {
      const p = await identity(captured.identity.pid);
      if (!p) continue; // retained historical ownership; zombies cannot execute
      if (!same(p, captured.identity)) throw new Error('PID reuse: cleanup identity mismatch');
      try {
        let exe = await readlink(`/proc/${p.pid}/exe`);
        if (exe === node && !captured.nativeObserved) {
          const current = await stat(`/proc/${p.pid}/exe`);
          if (current.dev !== nodeStat.dev || current.ino !== nodeStat.ino || current.size !== nodeStat.size || current.mtimeMs !== nodeStat.mtimeMs || current.ctimeMs !== nodeStat.ctimeMs) {
            // execve may happen between the two /proc reads. Reobserve only the
            // one permitted transition, then validate native content/argv below.
            exe = await readlink(`/proc/${p.pid}/exe`);
            if (!captured.spec.native || exe !== captured.spec.native.target) throw new Error('Runtime executable changed');
          }
        }
        if (captured.spec.native && exe === captured.spec.native.target) {
          if (hash(await readFile(`/proc/${p.pid}/exe`)) !== captured.spec.native.digest) throw new Error('Native executable content changed');
          const args = protocol.read(`/proc/${p.pid}/cmdline`, 16384).split('\0').filter(Boolean);
          if (JSON.stringify(args) !== JSON.stringify([exe, ...captured.args])) throw new Error('Native argv transition mismatch');
          captured.nativeObserved = true;
        } else if (exe !== node || captured.nativeObserved) throw new Error('Unapproved executable transition');
        const after = await identity(p.pid);
        if (after && !same(p, after)) throw new Error('Identity changed around executable validation');
      } catch (error) {
        // Short-lived ps/launcher may exit after capture and before exec observation.
        // That does not revoke historical ownership or authorize another executable.
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        for (let retry = 0; retry < 5 && await identity(p.pid); retry++) await pause(5);
        if (await identity(p.pid)) throw error;
      }
    }
  }
  async function scan() {
    if (hash(protocol.read(preload, 65536)) !== preloadDigest || hash(protocol.read(gate, 65536)) !== gateDigest) throw new Error('Generated preload/gate content changed');
    if (hash(protocol.read(configPath, 65536)) !== configDigest) throw new Error('Immutable host configuration changed');
    const names = await readdir(input.directory);
    const fixed = new Set(['process-register.cjs', 'native-exec-gate.cjs', 'config.json', 'control', 'control.tmp', 'failure']);
    if (names.length > 262 || names.some(n => !fixed.has(n) && !/^slot-(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(n))) throw new Error('Unknown/overflow registration storage');
    if ([...pending.keys()].some(n => !names.includes(n))) throw new Error('Missing immutable registration history');
    if (names.includes('failure')) throw new Error(`Process registration failure: ${protocol.read(join(input.directory, 'failure'), 512)}`);
    for (const name of names.filter(n => n.startsWith('slot-')).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))) {
      const slot = join(input.directory, name), info = await lstat(slot);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Nonprivate registration slot');
      const files = await readdir(slot);
      if (files.length > 4 || files.some(n => !['request', 'request.tmp', 'ack', 'ack.tmp'].includes(n))) throw new Error('Unknown/overflow pending registration storage');
      for (const file of files) {
        try { protocol.read(join(slot, file), 4096); } catch (error) { if (!file.endsWith('.tmp') || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (!pending.has(name)) pending.set(name, monotonic() + 5000);
      if (!files.includes('request')) { if (seen.has(name)) throw new Error('Missing immutable registration request'); if (monotonic() >= Math.min(pending.get(name)!, deadline)) throw new Error('Missing/partial registration record'); continue; }
      const bytes = protocol.read(join(slot, 'request'), 4096), digest = hash(bytes);
      if (seen.has(name)) {
        if (seen.get(name) !== digest) throw new Error('Conflicting immutable registration');
        if (protocol.read(join(slot, 'ack'), 4096) !== acknowledgments.get(name)) throw new Error('Conflicting/missing acknowledgment');
        continue;
      }
      let record;
      try { record = JSON.parse(bytes); } catch { throw new Error('Malformed registration request (contents withheld)'); }
      const p = record?.identity as Identity;
      if (record.session !== config.session || !/^[0-9a-f]{32}$/.test(record.nonce) || !Number.isFinite(record.created) || record.deadline !== record.created + 5000 || record.created > monotonic() || monotonic() >= Math.min(record.deadline, deadline, pending.get(name)!)) throw new Error('Registration session/nonce/deadline invalid');
      const actual = await identity(p?.pid), parent = await identity(record.parent?.pid);
      if (!actual || !same(actual, p) || !parent || !same(parent, record.parent) || actual.ppid !== parent.pid) throw new Error('Unproven/dead/reused child or parent ancestry');
      const argv = protocol.read(`/proc/${p.pid}/cmdline`, 16384).split('\0').filter(Boolean);
      const spec = config.specs.find(s => s.role === record.role && s.entry === record.entry && JSON.stringify(s.native ?? null) === JSON.stringify(record.native) && JSON.stringify(argv.slice(1, 2 + (s.nodeArgs?.length ?? 0))) === JSON.stringify([...(s.nodeArgs ?? []), s.entry]) && protocol.argsMatch(s, argv.slice(2 + (s.nodeArgs?.length ?? 0)), config));
      if (!spec) throw new Error('Unrecognized role/content/argv request');
      const parentCapture = ledger.find(c => same(c.identity, parent));
      if (spec.role === 'root') {
        if (!anchor || !same(anchor, actual) || rootChild?.pid !== actual.pid || !same(parent, collector!)) throw new Error('Root request is not actual spawned child');
      } else if (!parentCapture || !edges[parentCapture.spec.role]?.includes(spec.role)) throw new Error('Unrecognized role edge');
      await verify();
      const args = await validateProcess(actual, spec);
      if (spec.role === 'fixture') {
        const { operation } = await import(new URL('./fixtures/tool.mjs', import.meta.url).href);
        const data = JSON.parse(protocol.read(env.ORBI_E2E_STATE!, 65536));
        if (!operation(spec.entry.split('/').at(-1), args, data).allowed) throw new Error('Fixture argv refused');
      }
      if (spec.role === 'ps' && !psArguments(parentCapture!.spec.role, args)) throw new Error('ps parent/argv pair refused');
      if (spec.role === 'terminal-worker' && spec.args === 'worker' && args[1] !== parentCapture?.args[2]) throw new Error('Worker launch record mismatch');
      if (!same(parent, (await identity(parent.pid))!) || !same(actual, (await identity(actual.pid))!)) throw new Error('Parent/child changed before capture');
      const existing = ledger.find(c => c.identity.pid === actual.pid);
      if (existing && (!same(existing.identity, actual) || existing.spec.role !== spec.role)) throw new Error('Conflicting registered identity');
      if (requests.has(actual.pid) && requests.get(actual.pid) !== digest) throw new Error('Conflicting nonce/content for captured identity');
      if (monotonic() >= Math.min(record.deadline, deadline)) throw new Error('Admission phase deadline expired before commit');
      // Commit ownership BEFORE publishing permission to run application code.
      if (!existing) ledger.push({ identity: actual, spec, args, nativeObserved: false });
      seen.set(name, digest);
      requests.set(actual.pid, digest);
      const ack = JSON.stringify({ session: config.session, identity: actual, nonce: record.nonce, digest });
      if (monotonic() >= Math.min(record.deadline, deadline)) throw new Error('Admission deadline expired before acknowledgment');
      protocol.publish(join(slot, 'ack'), ack);
      acknowledgments.set(name, ack);
    }
    await verify();
  }
  const collect = async () => {
    if (!collecting) collecting = scan().catch(error => { failure(error); }).finally(() => { collecting = undefined; });
    await collecting;
    if (errors.length) throw new Error(errors.join('; '));
  };
  return {
    directory: input.directory, env, preload, gate, ledger, errors, configure, verify, collect,
    async captureRoot(child: ChildProcess) {
      if (rootChild) throw new Error('Root spawn already captured');
      rootChild = child; // synchronous retention before the first await
      anchor = child.pid ? await identity(child.pid) : null;
      if (!anchor) { failure('Missing actual spawn identity; no PID-only signaling authority'); throw new Error(errors.join('; ')); }
      const spec = config.specs.find(s => s.role === 'root');
      if (!spec) { failure('Missing root spawn specification'); throw new Error(errors.join('; ')); }
      const args = await validateProcess(anchor, spec);
      if (anchor.ppid !== collector!.pid || !same(collector!, (await identity(collector!.pid))!)) throw new Error('Root spawn parent mismatch');
      ledger.push({ identity: anchor, spec, args, nativeObserved: false });
      return anchor;
    },
    service() { if (!timer) { timer = setInterval(() => { void collect().catch(() => {}); }, 10); timer.unref(); } },
    async running() { if (phase !== 'startup') throw new Error('Invalid admission phase transition'); phase = 'running'; deadline = Number.MAX_SAFE_INTEGER; await writeControl(); },
    async shutdown(fixedDeadline: number) { if (phase !== 'shutdown') { phase = 'shutdown'; deadline = fixedDeadline; await writeControl(); } },
    async close() { if (timer) clearInterval(timer); await collecting; },
  };
}
export type Registration = Awaited<ReturnType<typeof createRegistration>>;
// Validate source bytes before deriving any allowed role. Merely matching a version
// or a copied-runtime prefix is not provenance. No runtime code is imported/executed.
export async function pinnedProcessSpecs(home: string, bin: string, cli: string, registrationDirectory: string) {
  const provenance = JSON.parse(await readFile(new URL('./fixtures/process-registration-provenance.json', import.meta.url), 'utf8'));
  const modules = resolve(dirname(cli), '../../..');
  if (await realpath(cli) !== cli) throw new Error('Pinned CLI must be canonical');
  for (const [relative, digest] of Object.entries(provenance.sources)) if (hash(await readFile(join(modules, relative))) !== digest) throw new Error(`Pinned runtime source content mismatch: ${relative}`);
  const req = createRequire(join(modules, '@getpaseo/server/package.json'));
  const bundle = join(modules, '@getpaseo/server/dist/server/terminal-worker/terminal-worker.mjs');
  const pty = await readFile(req.resolve('node-pty/package.json'));
  if (hash(pty) !== provenance.nodePtyPackageSha256) throw new Error('Pinned node-pty metadata content mismatch');
  const runtime = `0.15.4-${createHash('sha256').update(await readFile(bundle)).update(pty).update(`${process.platform}-${process.arch}`).digest('hex').slice(0, 12)}`;
  const worker = join(home, 'terminal-worker', runtime, 'terminal-worker.mjs');
  const esbuildPackage = JSON.parse(await readFile(req.resolve('esbuild/package.json'), 'utf8'));
  if (esbuildPackage.version !== provenance.esbuildVersion) throw new Error('Unsupported esbuild version');
  const nativeEsbuild = await realpath(req.resolve(`@esbuild/${process.platform}-${process.arch}/bin/esbuild`));
  await access('/usr/bin/ps', constants.X_OK);
  const nativePs = await realpath('/usr/bin/ps');
  const ps = join(bin, 'ps'), esbuild = join(bin, 'esbuild');
  for (const path of [ps, esbuild]) {
    await writeFile(path, `#!${process.execPath}\nrequire(${JSON.stringify(join(registrationDirectory, 'native-exec-gate.cjs'))});\n`, { mode: 0o700, flag: 'wx' });
  }
  const spec = async (role: ProcessSpec['role'], entry: string, args: ProcessSpec['args']): Promise<ProcessSpec> => ({ role, entry, args, digest: hash(await readFile(entry)) });
  const specs: ProcessSpec[] = [await spec('root', cli, ['daemon', 'run', '--home', home]),
    await spec('supervisor', join(modules, '@getpaseo/server/dist/scripts/supervisor-entrypoint.js'), []),
    await spec('daemon', join(modules, '@getpaseo/server/dist/server/server/daemon-worker.js'), []),
    await spec('plugin', join(modules, '@getpaseo/server/dist/server/server/plugins/plugin-process.js'), []),
    { role: 'terminal-launcher', entry: worker, digest: hash(await readFile(bundle)), args: 'launcher' },
    { role: 'terminal-worker', entry: worker, digest: hash(await readFile(bundle)), args: 'worker' },
    { ...await spec('ps', ps, 'ps'), native: { target: nativePs, digest: hash(await readFile(nativePs)) } },
    { ...await spec('esbuild', esbuild, ['--service=0.25.12', '--ping']), native: { target: nativeEsbuild, digest: hash(await readFile(nativeEsbuild)) } }];
  for (const name of ['gh', 'systemctl', 'journalctl']) specs.push(await spec('fixture', join(bin, name), 'fixture'));
  return { specs, runtime, esbuild };
}
export type Host = Awaited<ReturnType<typeof makeHost>>;
export async function makeHost(root: string, alias: string, profile: 'release' | 'installed', candidate: string, cli: string, mode: 'available' | 'unconfigured', retained: unknown[] = []) {
  registrationRuntime();
  if (await realpath(candidate) !== candidate || !isAbsolute(candidate)) throw new Error('Candidate must be canonical absolute directory');
  const home = join(root, alias); await mkdir(home);
  const bin = join(root, `${alias}-bin`); await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node'));
  const { data, registry, calls, state, setState } = await prepareTelemetry(root, alias, profile);
  const standin = await readFile(new URL('./fixtures/tool.mjs', import.meta.url), 'utf8');
  for (const name of ['gh', 'systemctl', 'journalctl']) { const path = join(bin, name); await writeFile(path, `#!${process.execPath}\n${standin}`); await chmod(path, 0o700); }
  const port = await reservePort();
  const host = `tcp://127.0.0.1:${port.port}`;
  const env: NodeJS.ProcessEnv = { ...environment(root, bin, home), PASEO_LISTEN: `127.0.0.1:${port.port}`, PASEO_WEB_UI_ENABLED: 'true', PASEO_RELAY_ENABLED: 'false',
    PASEO_ORBI_CONFIG: data.authorization, ORBI_E2E_REGISTRY: registry, ORBI_E2E_CALLS: calls, ORBI_E2E_STATE: state };
  if (mode === 'unconfigured') delete env.PASEO_ORBI_CONFIG;
  const startup = { deadline: Date.now() + 60000 }, shutdown = { deadline: Infinity };
  let log = '';
  const handle = { installation: 'never-attempted' as InstallationHost['installation'], alias, profile, home, state, cli, candidate, startup, shutdown, port: port.port, url: `http://127.0.0.1:${port.port}`, host, data, env,
    daemonEnv: {} as NodeJS.ProcessEnv, registration: null as Registration | null, child: null as ChildProcess | null, registry, calls, initial: null as Identity | null, setState,
    cliCall: async (...args: string[]): Promise<string> => {
      managementArgs(args, candidate);
      await handle.registration?.collect();
      await assertListenerOwned(handle);
      const remaining = Math.min(startup.deadline - Date.now(), shutdown.deadline - monotonic());
      if (remaining <= 0) throw new Error('Fixed host startup/shutdown deadline exceeded');
      return command(process.execPath, [cli, '--host', host, 'plugin', ...args], env, candidate, Math.min(10000, remaining));
    },
    log: () => sanitize(log, [root, data.root]),
  };
  // Cleanup can see the port, removal state, logs and actual spawn reference even
  // when any subsequent initialization fails. A ChildProcess alone grants no lease.
  retained.push(handle);
  try {
    isolation(root, home, host, true, true);
    for (const path of [env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME]) await mkdir(path!, { recursive: true });
    await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1, daemon: { listen: env.PASEO_LISTEN, relay: { enabled: false }, mcp: { enabled: false, injectIntoAgents: false }, browserTools: { enabled: false }, usage: { enabled: false }, enableTerminalAgentHooks: false }, agents: { resumeOnStartup: false, metadataGeneration: { providers: [] } }, features: { webUi: { enabled: true }, dictation: { enabled: false }, voiceMode: { enabled: false } }, pluginsEnabled: true }));
    const directory = join(root, `${alias}-registration`);
    const pinned = await pinnedProcessSpecs(home, bin, cli, directory);
    const registration = await createRegistration({ root, home, directory, env, ...pinned, startupDeadline: performance.now() + Math.max(0, startup.deadline - Date.now()) });
    handle.registration = registration; handle.daemonEnv = registration.env;
    await port.release();
    if (!(await portClosed(port.port))) throw new Error('Occupied/unowned port; refusing launch');
    const child = spawn(process.execPath, [cli, 'daemon', 'run', '--home', home], { env: handle.daemonEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    handle.child = child; // actual returned reference retained synchronously
    child.stdout.on('data', b => { log = (log + String(b)).slice(-262144); }); child.stderr.on('data', b => { log = (log + String(b)).slice(-262144); });
    child.on('error', e => { log = (log + e.message).slice(-262144); });
    handle.initial = await registration.captureRoot(child);
    registration.service();
    return handle as typeof handle & { initial: Identity };
  } catch (error) { log = (log + String(error)).slice(-262144); await port.release().catch(() => undefined); throw error; }
}
export function requireListenerOwnership(occupied: boolean, owned: boolean) {
  if (occupied && !owned) throw new Error('Occupied/unowned port; refusing host commands');
}
export async function assertListenerOwned(host: { initial: Identity | null; port: number; registration?: Registration | null }) {
  const tcp = (await readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1).map(line => line.trim().split(/\s+/));
  const listeners = tcp.filter(row => row[1] === `0100007F:${host.port.toString(16).toUpperCase().padStart(4, '0')}` && row[3] === '0A');
  const table = await processTable(), owned = host.registration?.ledger.map(c => c.identity) ?? (host.initial ? [host.initial] : []), inodes = new Set<string>();
  requireListenerOwnership(true, table.some(p => same(p, host.initial)));
  await host.registration?.collect();
  if (!host.registration) {
    // Read-only listener authorization for existing serialized lease consumers.
    // This is not enrollment and is never passed to process signaling.
    for (let changed = true; changed;) { changed = false; for (const p of table) if (!owned.some(q => same(p, q)) && owned.some(q => q.pid === p.ppid && table.some(t => same(t, q)))) { owned.push(p); changed = true; } }
  }
  for (const p of owned) {
    try { for (const fd of await readdir(`/proc/${p.pid}/fd`)) { try { inodes.add(await readlink(`/proc/${p.pid}/fd/${fd}`)); } catch { /* closed fd */ } } } catch { /* exited process */ }
  }
  requireListenerOwnership(true, listeners.length === 1 && inodes.has(`socket:[${listeners[0][9]}]`));
}
export async function ownedProcesses(hosts: Host[], root: string, extra: Identity[] = []) {
  const owned = [...extra];
  for (const host of hosts) {
    await host.registration?.collect();
    owned.push(...host.registration?.ledger.map(c => c.identity) ?? []);
    // Legacy fixture telemetry and upstream worker JSON cannot enroll anything.
    const legacy = protocol.read(host.registry, 1024 * 1024);
    if (legacy.trim()) throw new Error('Unrecognized marker-only fixture registration');
    const directory = join(host.home, 'terminal-worker');
    let files: string[] = [];
    try { files = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (files.length > 512) throw new Error('Upstream worker record capacity exceeded');
    for (const name of files.filter(n => n.endsWith('.json'))) {
      // Optional discovery is bounded separately from 4KiB admission records.
      let record: { terminals?: unknown[]; pid?: number };
      try { record = JSON.parse(protocol.read(join(directory, name), 1024 * 1024)); } catch { throw new Error('Malformed/oversized upstream worker discovery record (contents withheld)'); }
      if (Array.isArray(record.terminals) && record.terminals.length) throw new Error('Unaccounted terminal programs; cleanup refused');
      if (typeof record.pid === 'number') {
        const current = await identity(record.pid);
        if (current && !owned.some(p => same(p, current))) throw new Error('Unaccounted worker JSON process; no retrospective enrollment');
      }
    }
  }
  for (const p of await processTable()) {
    let env = ''; try { env = protocol.read(`/proc/${p.pid}/environ`, 65536); } catch { continue; }
    if (env.split('\0').includes(`PASEO_ORBI_E2E_OWNER=${root}`) && !owned.some(q => same(q, p))) throw new Error('Unaccounted owned descendant; refusing broad kill');
  }
  return owned;
}
// Fresh isolated HOME/XDG/npm/tmp tree for preparation and daemon launches.
export async function setupEnvironment(root: string) {
  await mkdir(join(root, 'tmp')); await writeFile(join(root, 'npmrc'), ''); await writeFile(join(root, 'global-npmrc'), '');
  const isolated = environment(root, dirname(process.execPath), join(root, 'setup-home'));
  await mkdir(isolated.HOME!);
  return isolated;
}
// Exact committed archive and reviewed preparation only; shared by the browser and native lanes.
export async function prepareCandidate(input: Pick<Inputs, 'repo' | 'sha'>, root: string, isolated: NodeJS.ProcessEnv) {
  if (await realpath(input.repo) !== input.repo) throw new Error('Candidate repository must be canonical');
  const candidate = join(root, 'candidate'); await mkdir(candidate);
  const npm = await realpath(join(dirname(process.execPath), 'npm'));
  const sha = (await command('/usr/bin/git', ['-C', input.repo, 'rev-parse', '--verify', `${input.sha}^{commit}`], isolated, root)).trim();
  if (sha !== input.sha) throw new Error('Candidate SHA must name the exact committed tree');
  const archive = join(root, 'candidate.tar');
  await command('/usr/bin/git', ['-C', input.repo, 'archive', '--format=tar', `--output=${archive}`, input.sha], isolated, root);
  await command('/usr/bin/tar', ['-xf', archive, '-C', candidate], isolated, root);
  // Reject tracked symlinks and accidental credential/runtime payloads before preparation.
  const inspect = async (dir: string): Promise<void> => { for (const name of await readdir(dir)) { const path = join(dir, name), stat = await lstat(path); if (stat.isSymbolicLink() || /^(?:\.git|node_modules|\.npmrc|\.env|credentials)$/.test(name)) throw new Error('Unsafe committed candidate payload'); if (stat.isDirectory()) await inspect(path); } }; await inspect(candidate);
  const runtime = JSON.parse(await readFile(resolve('tests/e2e/runtime/node_modules/@getpaseo/cli/package.json'), 'utf8'));
  if (runtime.version !== '0.15.4') throw new Error('Run explicit pinned runtime setup first');
  await command(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts'], isolated, candidate, 180000);
  const manifest = JSON.parse(await readFile(join(candidate, 'paseo-plugin.json'), 'utf8'));
  if (JSON.stringify(manifest.build) !== JSON.stringify([['npm', 'ci', '--omit=dev', '--ignore-scripts']])) throw new Error('Unreviewed preparation command');
  return { candidate, sha };
}
// Both lanes consume the same fixture hosts, ports and identity-safe accounting.
export async function startHosts(hosts: Host[], root: string, candidate: string, cli: string, mode: 'available' | 'unconfigured' = 'available') {
  for (const [alias, profile] of [['host-a', 'release'], ['host-b', 'installed']] as const) {
    const host = await makeHost(root, alias, profile, candidate, cli, mode, hosts);
    const deadline = host.startup.deadline;
    await boundedWait(async () => {
      await host.registration?.collect();
      if (!(await portClosed(host.port))) await assertListenerOwned(host);
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1000);
      try { return (await fetch(`${host.url}/api/health`, { signal: controller.signal })).ok; } catch { return false; } finally { clearTimeout(timer); }
    }, Math.max(1, deadline - Date.now()));
    await installWhenRpcReady(host);
    await boundedWait(async () => { const rows = JSON.parse(await host.cliCall('ls', 'paseo-orbi', '--json')); return rows.length === 1 && rows[0].id === 'paseo-orbi' && rows[0].status === 'running'; }, Math.max(1, deadline - Date.now()));
    host.startup.deadline = Infinity;
    await host.registration?.running();
  }
}
export function lease(running: { root: string; input: Inputs; hosts: Host[] }) {
  return { root: running.root, input: running.input, hosts: running.hosts.map(h => ({
    initial: h.initial, alias: h.alias, profile: h.profile, home: h.home, state: h.state, cli: h.cli, candidate: h.candidate, port: h.port, url: h.url, host: h.host, env: h.env,
    registry: h.registry, calls: h.calls, data: { authorization: h.data.authorization, entry: h.data.entry },
  })) };
}
// Ownership-aware teardown shared by both lanes. Extra identities (owned display/app
// groups) are only ever verified and signalled by proven pid+pgid+start identity.
export async function release(input: Pick<Inputs, 'output' | 'repo'>, root: string, hosts: Host[], extra: { identities?: Identity[] } = {}) {
  const extras = extra.identities ?? [], deadline = monotonic() + 15000, phaseErrors: string[] = [];
  for (const host of hosts) {
    host.startup.deadline = Infinity; host.shutdown.deadline = deadline;
    try { await host.registration?.shutdown(deadline); } catch (error) { phaseErrors.push(diagnostic(error)); }
  }
  const result = await cleanupInstallations(hosts, {
    snapshot: () => ownedProcesses(hosts, root, extras),
    safe: () => [...extras, ...hosts.flatMap(h => h.registration?.ledger.map(c => c.identity) ?? [])],
    stop: owned => stopOwned([...owned, ...hosts.flatMap(h => h.registration?.ledger.map(c => c.identity) ?? [])], {
      table: processTable, signal: (pgid, signal) => process.kill(-pgid, signal), sleep: pause, deadline,
      reconcile: () => ownedProcesses(hosts, root, extras),
      validate: async group => { for (const host of hosts) if (host.registration?.ledger.some(c => group.some(p => same(p, c.identity)))) await host.registration.verify(group); },
    }),
    log: host => writeFile(join(input.output, `${host.alias}.log`), host.log()),
    verify: async owned => {
      const failures: string[] = [];
      for (const host of hosts) if (!(await portClosed(host.port))) failures.push(`Owned port still listening: ${host.alias}`);
      const table = await processTable();
      if (owned.some(p => table.some(q => same(p, q)))) failures.push('Owned subprocess remains after cleanup');
      if (extras.some(p => table.some(q => same(p, q)))) failures.push('Owned native process remains after cleanup');
      // Re-scan the owner marker after termination, including ambiguous-absent installs.
      if ((await ownedProcesses(hosts, root, extras)).some(p => table.some(q => same(p, q)))) failures.push('Owned descendant remains after cleanup');
      if (failures.length) throw new Error(failures.join('; '));
    },
  });
  for (const host of hosts) await host.registration?.close();
  const errors = [...phaseErrors, ...result.errors, ...hosts.flatMap(h => h.registration?.errors.map(error => `${h.alias}: accounting: ${sanitize(error)}`) ?? [])];
  if (monotonic() >= deadline) errors.push('Fixed shutdown deadline exceeded');
  const report = { status: errors.length ? 'fail' : 'pass', ...result, errors };
  if (errors.length) {
    await writeFile(join(input.output, 'cleanup.json'), sanitize(JSON.stringify(report), [root, input.repo, input.output]));
    throw new Error('Ownership-aware cleanup failed; runtime trees retained for investigation. Inspect cleanup.json for removal and process diagnostics.');
  }
  for (const host of hosts) await host.data.cleanup();
  await rm(root, { recursive: true });
  await writeFile(join(input.output, 'cleanup.json'), JSON.stringify(report));
  return report;
}

export async function start(env = process.env, mode: 'available' | 'unconfigured' = 'available') {
  let input!: Inputs; approveLaunch(env, value => { input = value; }); // no effects before approval
  registrationRuntime();
  // Every existing output ancestor must be canonical. mkdir is exclusive: never reuse evidence/runtime state.
  await checkFreshPath(input.output);
  await mkdir(dirname(input.output), { recursive: true });
  if (await realpath(dirname(input.output)) !== dirname(input.output)) throw new Error('Outside/symlink evidence parent');
  await mkdir(input.output);
  const root = await mkdtemp(join(await realpath('/tmp'), 'paseo-orbi-e2e-')), hosts: Host[] = [];
  const cli = resolve('tests/e2e/runtime/node_modules/@getpaseo/cli/bin/paseo');
  const cleanup = async () => { await release(input, root, hosts); };
  try {
    const isolated = await setupEnvironment(root);
    const { candidate, sha } = await prepareCandidate(input, root, isolated);
    await writeFile(join(input.output, 'receipt.json'), JSON.stringify({ approval: input.approval, candidate: '[EXACT_COMMITTED_ARCHIVE]', evidenceKind: 'browser', pluginSha: sha, dirty: false, nodeVersion: process.version, daemonVersion: '0.15.4', appVersion: '0.15.4', playwrightVersion: '1.65.1', observedAt: new Date().toISOString() }, null, 2));
    await startHosts(hosts, root, candidate, cli, mode);
    return { input, root, hosts, cleanup };
  } catch (error) {
    const primary = new Error(sanitize(diagnostic(error), [root, input.repo, input.output]));
    await writeFile(join(input.output, 'startup.log'), primary.message);
    return finishFailedStart(primary, cleanup);
  }
}

// Playwright invokes global setup only for execution, never for --list/imports.
export default async function globalSetup() {
  const running = await start();
  const path = join(running.root, 'lease.json');
  await writeFile(path, JSON.stringify(lease(running)));
  process.env.PASEO_E2E_LEASE = path;
  return running.cleanup;
}
