import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, realpath, lstat, readdir, rm, chmod, symlink, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fixture } from '../helpers/fixtures';

const exec = promisify(execFile);
export type Inputs = { repo: string; sha: string; output: string; approval: string };
export function approveLaunch(env: NodeJS.ProcessEnv, effect: (input: Inputs) => unknown) {
  if (env.PASEO_E2E_ENABLE_TRUSTED_PLUGINS !== '1' || !/^https:\/\/github\.com\/TrebuchetDynamics\/paseo-orbi\/issues\/12#issuecomment-\d+$/.test(env.PASEO_E2E_APPROVAL_URL ?? ''))
    throw new Error('Owner approval required on execution issue #12. Read and verify the trusted-plugin consent before setting the approval URL and flag.');
  const repo = env.PASEO_E2E_CANDIDATE_REPO ?? '', sha = env.PASEO_E2E_CANDIDATE_SHA ?? '', output = env.PASEO_E2E_OUTPUT ?? '';
  if (!isAbsolute(repo) || resolve(repo) !== repo || !/^[0-9a-f]{40}$/.test(sha) || !isAbsolute(output) || resolve(output) !== output || !output.includes('/.artifacts/paseo-qualification/') || output === repo || output.startsWith(repo + '/node_modules/'))
    throw new Error('Explicit absolute candidate repository, committed full SHA and new .artifacts/paseo-qualification/<run-id> output required.');
  return effect({ repo, sha, output, approval: env.PASEO_E2E_APPROVAL_URL! });
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
    if (fields[0] === 'Z') return null;
    return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19] };
  } catch { return null; }
}
export async function processTable() {
  return (await Promise.all((await readdir('/proc')).filter(n => /^\d+$/.test(n)).map(n => identity(Number(n))))).filter((p): p is Identity => !!p);
}
const same = (a: Identity, b: Identity) => a.pid === b.pid && a.pgid === b.pgid && a.start === b.start;
export async function stopOwned(owned: Identity[], seams: { table: () => Promise<Identity[]>; signal: (pgid: number, signal: NodeJS.Signals) => unknown; sleep: (ms: number) => Promise<void> } = { table: processTable, signal: (pgid, signal) => process.kill(-pgid, signal), sleep: pause }) {
  const check = async () => {
    const table = await seams.table();
    const live = owned.filter(p => table.some(q => same(p, q)));
    for (const p of live) if (table.some(q => q.pgid === p.pgid && !owned.some(o => same(o, q)))) throw new Error('Unaccounted descendant/group member: cleanup refused');
    for (const p of owned) if (table.some(q => q.pid === p.pid && !same(p, q))) throw new Error('PID reuse: cleanup identity mismatch');
    return live;
  };
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const live = await check();
    for (const group of new Set(live.map(p => p.pgid))) { if (group <= 1 || group === process.pid) throw new Error('Unsafe process group'); try { seams.signal(group, signal); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } }
    for (let n = 0; n < 20; n++) { if (!(await check()).length) return; await seams.sleep(50); }
  }
  if ((await check()).length) throw new Error('Owned subprocess survived bounded TERM/KILL cleanup');
}
export function sanitize(text: string, roots: string[] = []) {
  let result = text.replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+|[A-Z_]*(?:SECRET|TOKEN|PROMPT|REASONING|PRIVATE)[A-Z_]*CANARY)/gi, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@').replace(/[?&](?:token|password|key)=[^\s&]+/gi, '?[REDACTED]');
  for (const root of roots.filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(root).join('[OWNED]');
  return result;
}
export async function command(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeout = 60000) {
  return (await exec(file, args, { env, cwd, timeout, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' })).stdout;
}
export type Host = Awaited<ReturnType<typeof makeHost>>;
async function makeHost(root: string, alias: string, profile: 'release' | 'installed', candidate: string, cli: string, mode: 'available' | 'unconfigured') {
  const home = join(root, alias); await mkdir(home);
  const bin = join(root, `${alias}-bin`); await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node'));
  // npm's absolute script is used for preparation; only node and strict fixture tools are exposed to the daemon.
  const npm = await realpath(join(dirname(process.execPath), 'npm')); await symlink(npm, join(bin, 'npm'));
  const data = await fixture(profile, root); // existing pinned source data, no engine execution
  const registry = join(root, `${alias}-reads.jsonl`), calls = join(root, `${alias}-calls.jsonl`), state = join(root, `${alias}-state.json`);
  await writeFile(registry, ''); await writeFile(calls, '');
  const standin = await readFile(new URL('./fixtures/tool.mjs', import.meta.url), 'utf8');
  for (const name of ['gh', 'systemctl', 'journalctl']) { const path = join(bin, name); await writeFile(path, `#!${process.execPath}\n${standin}`); await chmod(path, 0o700); }
  const port = await reservePort();
  try {
  const host = `tcp://127.0.0.1:${port.port}`;
  isolation(root, home, host, true, true);
  const env: NodeJS.ProcessEnv = { ...environment(root, bin, home), PASEO_LISTEN: `127.0.0.1:${port.port}`, PASEO_WEB_UI_ENABLED: 'true', PASEO_RELAY_ENABLED: 'false',
    PASEO_ORBI_CONFIG: data.authorization, ORBI_E2E_REGISTRY: registry, ORBI_E2E_CALLS: calls, ORBI_E2E_STATE: state };
  if (mode === 'unconfigured') delete env.PASEO_ORBI_CONFIG;
  for (const path of [env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME]) await mkdir(path!, { recursive: true });
  await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1, daemon: { listen: env.PASEO_LISTEN, relay: { enabled: false }, mcp: { enabled: false, injectIntoAgents: false }, browserTools: { enabled: false }, usage: { enabled: false }, enableTerminalAgentHooks: false }, agents: { resumeOnStartup: false, metadataGeneration: { providers: [] } }, features: { webUi: { enabled: true }, dictation: { enabled: false }, voiceMode: { enabled: false } }, pluginsEnabled: true }));
  const records = JSON.parse(await readFile(new URL('../fixtures/runs/records.json', import.meta.url), 'utf8'));
  const guidance = JSON.parse(await readFile(new URL('../fixtures/blockers/guidance.json', import.meta.url), 'utf8'));
  const scene = join(data.repoDir, '.worktrees/orbi-Example-project-issue-42-84360d31');
  await mkdir(join(scene, '.orbi'), { recursive: true }); await mkdir(join(scene, '.pi-session'));
  await writeFile(join(scene, '.orbi/run-state.json'), JSON.stringify({ repo: 'Example/project', issue: 42, run_id: '84360d31', branch: 'orbi/Example-project-issue-42', created_at: new Date().toISOString() }));
  await writeFile(join(scene, '.pi-session/one.jsonl'), [records.session, records.message].map(r => JSON.stringify(r)).join('\n') + '\n');
  const setState = async (scenario: string) => {
    await writeFile(state, JSON.stringify({ scenario, alias, records, guidance }));
    await mkdir(join(data.repoDir, '.orbi'), { recursive: true });
    await writeFile(join(data.repoDir, '.orbi/health.json'), scenario === 'unavailable' || scenario === 'partial' ? '{}' : JSON.stringify({ runs: [], last_pickup_ts: Date.now() / 1000, alerted: [] }));
  };
  await setState('available');
  await port.release();
  if (!(await portClosed(port.port))) throw new Error('Occupied/unowned port; refusing launch');
  const startup = { deadline: Date.now() + 60000 };
  const child = spawn(process.execPath, [cli, 'daemon', 'run', '--home', home], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', b => { log = (log + String(b)).slice(-262144); }); child.stderr.on('data', b => { log = (log + String(b)).slice(-262144); });
  child.on('error', e => { log += e.message; });
  const initial = await identity(child.pid!);
  if (!initial) throw new Error('Owned daemon failed to spawn');
  const cliCall = async (...args: string[]): Promise<string> => {
    await assertListenerOwned({ initial, port: port.port });
    const remaining = startup.deadline - Date.now();
    if (remaining <= 0) throw new Error('60-second host startup deadline exceeded');
    return command(process.execPath, [cli, '--host', host, 'plugin', ...args], env, candidate, Math.min(10000, remaining));
  };
  const handle = { alias, profile, home, state, cli, candidate, startup, port: port.port, url: `http://127.0.0.1:${port.port}`, host, data, env, registry, calls, initial, setState, cliCall,
    log: () => sanitize(log, [root, data.root]),
    async configure(kind: 'available' | 'unconfigured' | 'invalid' | 'rejected') {
      if (kind === 'unconfigured') await rm(data.authorization, { force: true });
      else if (kind === 'invalid') await writeFile(data.authorization, '{}');
      else await data.save(kind === 'rejected' ? [{ ...data.entry, adapter: 'unknown-source-profile' }] : [data.entry]);
      await cliCall('reload', 'paseo-orbi');
    },
  };
  return handle;
  } catch (error) { await port.release().catch(() => undefined); throw error; }
}
export function requireListenerOwnership(occupied: boolean, owned: boolean) {
  if (occupied && !owned) throw new Error('Occupied/unowned port; refusing host commands');
}
async function assertListenerOwned(host: { initial: Identity; port: number }) {
  const tcp = (await readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1).map(line => line.trim().split(/\s+/));
  const listeners = tcp.filter(row => row[1] === `0100007F:${host.port.toString(16).toUpperCase().padStart(4, '0')}` && row[3] === '0A');
  const table = await processTable(), owned = [host.initial], inodes = new Set<string>();
  for (let changed = true; changed;) { changed = false; for (const p of table) if (!owned.some(q => same(p, q)) && owned.some(q => q.pid === p.ppid && table.some(t => same(t, q)))) { owned.push(p); changed = true; } }
  for (const p of owned) {
    try { for (const fd of await readdir(`/proc/${p.pid}/fd`)) { try { inodes.add(await readlink(`/proc/${p.pid}/fd/${fd}`)); } catch { /* closed fd */ } } } catch { /* exited process */ }
  }
  requireListenerOwnership(true, listeners.length === 1 && inodes.has(`socket:[${listeners[0][9]}]`));
}
export async function ownedProcesses(hosts: Host[], root: string) {
  const table = await processTable(), owned = hosts.map(h => h.initial);
  // Snapshot daemon descendants BEFORE removal; detached read children additionally register themselves.
  for (let changed = true; changed;) {
    changed = false;
    for (const p of table) if (!owned.some(q => same(p, q)) && owned.some(q => q.pid === p.ppid && table.some(t => same(t, q)))) { owned.push(p); changed = true; }
  }
  for (const host of hosts) for (const line of (await readFile(host.registry, 'utf8')).trim().split('\n').filter(Boolean)) {
    const p = JSON.parse(line) as Identity;
    const current = table.find(q => q.pid === p.pid);
    if (current && !same(current, p)) throw new Error('Fixture PID reuse detected');
    if (current && !owned.some(q => same(q, current))) {
      const env = await readFile(`/proc/${p.pid}/environ`, 'utf8');
      if (!env.split('\0').includes(`PASEO_ORBI_E2E_OWNER=${root}`) || !env.split('\0').includes(`ORBI_E2E_REGISTRY=${host.registry}`)) throw new Error('Unproven fixture process ownership');
      owned.push(current);
    }
  }
  for (const p of table) {
    let env = ''; try { env = await readFile(`/proc/${p.pid}/environ`, 'utf8'); } catch { continue; }
    if (env.split('\0').includes(`PASEO_ORBI_E2E_OWNER=${root}`) && !owned.some(q => same(q, p))) throw new Error('Unaccounted owned descendant; refusing broad kill');
  }
  return owned;
}
export async function start(env = process.env, mode: 'available' | 'unconfigured' = 'available') {
  let input!: Inputs; approveLaunch(env, value => { input = value; }); // no effects before approval
  if (process.version !== 'v22.19.0' || process.platform !== 'linux') throw new Error('Qualification requires Linux and Node 22.19.0');
  if (await realpath(input.repo) !== input.repo) throw new Error('Candidate repository must be canonical');
  // Every existing output ancestor must be canonical. mkdir is exclusive: never reuse evidence/runtime state.
  await checkFreshPath(input.output);
  await mkdir(dirname(input.output), { recursive: true });
  if (await realpath(dirname(input.output)) !== dirname(input.output)) throw new Error('Outside/symlink evidence parent');
  await mkdir(input.output);
  const root = await mkdtemp(join(await realpath('/tmp'), 'paseo-orbi-e2e-')), hosts: Host[] = [];
  await mkdir(join(root, 'tmp')); await writeFile(join(root, 'npmrc'), ''); await writeFile(join(root, 'global-npmrc'), '');
  const candidate = join(root, 'candidate'); await mkdir(candidate);
  const isolated = environment(root, dirname(process.execPath), join(root, 'setup-home')); await mkdir(isolated.HOME!);
  const npm = await realpath(join(dirname(process.execPath), 'npm'));
  const cli = resolve('tests/e2e/runtime/node_modules/@getpaseo/cli/bin/paseo');
  const cleanup = async () => {
    const errors: string[] = [];
    let owned: Identity[] = [];
    try { owned = await ownedProcesses(hosts, root); } catch (e) { errors.push(String(e)); }
    for (const host of hosts) {
      host.startup.deadline = Infinity;
      try { await host.cliCall('remove', 'paseo-orbi'); } catch { errors.push(`Removal failed: ${host.alias}`); }
      await writeFile(join(input.output, `${host.alias}.log`), host.log());
    }
    try { owned = [...owned, ...await ownedProcesses(hosts, root)]; await stopOwned(owned); } catch (e) { errors.push(String(e)); }
    for (const host of hosts) {
      if (!(await portClosed(host.port))) errors.push(`Owned port still listening: ${host.alias}`);
      const table = await processTable();
      if (owned.some(p => table.some(q => same(p, q)))) errors.push('Owned subprocess remains after cleanup');
    }
    if (errors.length) { await writeFile(join(input.output, 'cleanup.json'), JSON.stringify({ status: 'fail', errors: errors.map(e => sanitize(e, [root])) })); throw new Error('Ownership-aware cleanup failed; runtime trees retained for investigation.'); }
    for (const host of hosts) await host.data.cleanup();
    await rm(root, { recursive: true });
    await writeFile(join(input.output, 'cleanup.json'), JSON.stringify({ status: 'pass' }));
  };
  try {
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
    await writeFile(join(input.output, 'receipt.json'), JSON.stringify({ approval: input.approval, candidate: '[EXACT_COMMITTED_ARCHIVE]', evidenceKind: 'browser', pluginSha: sha, dirty: false, nodeVersion: process.version, daemonVersion: '0.15.4', appVersion: '0.15.4', playwrightVersion: '1.65.1', observedAt: new Date().toISOString() }, null, 2));
    for (const [alias, profile] of [['host-a', 'release'], ['host-b', 'installed']] as const) {
      const host = await makeHost(root, alias, profile, candidate, cli, mode); hosts.push(host);
      const deadline = host.startup.deadline;
      await boundedWait(async () => {
        if (!(await portClosed(host.port))) await assertListenerOwned(host);
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1000);
        try { return (await fetch(`${host.url}/api/health`, { signal: controller.signal })).ok; } catch { return false; } finally { clearTimeout(timer); }
      }, Math.max(1, deadline - Date.now()));
      await host.cliCall('install', candidate, '--id', 'paseo-orbi');
      await boundedWait(async () => { const rows = JSON.parse(await host.cliCall('ls', 'paseo-orbi', '--json')); return rows.length === 1 && rows[0].id === 'paseo-orbi' && rows[0].status === 'running'; }, Math.max(1, deadline - Date.now()));
      host.startup.deadline = Infinity;
    }
    return { input, root, hosts, cleanup };
  } catch (error) {
    await writeFile(join(input.output, 'startup.log'), sanitize(String(error), [root, input.repo, input.output]));
    await cleanup(); throw error;
  }
}

// Playwright invokes global setup only for execution, never for --list/imports.
export default async function globalSetup() {
  const running = await start();
  const lease = join(running.root, 'lease.json');
  await writeFile(lease, JSON.stringify({ root: running.root, input: running.input, hosts: running.hosts.map(h => ({
    alias: h.alias, profile: h.profile, home: h.home, state: h.state, cli: h.cli, candidate: h.candidate, port: h.port, url: h.url, host: h.host, env: h.env,
    registry: h.registry, calls: h.calls, data: { authorization: h.data.authorization, entry: h.data.entry },
  })) }));
  process.env.PASEO_E2E_LEASE = lease;
  return running.cleanup;
}
