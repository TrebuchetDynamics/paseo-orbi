import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { test as base, expect } from '@playwright/test';
import { release as osRelease } from 'node:os';
import { approveNativeLaunch, boundedWait, checkFreshPath, finishFailedStart, identity, lease, portClosed, prepareCandidate, release, reservePort, sanitize, setupEnvironment, startHosts, stopOwned, type Host, type Identity, type Inputs } from '../harness';
const digestOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const exec = promisify(execFile);
const exists = async (path: string) => { try { await stat(path); return true; } catch { return false; } };

// Source-bound pins. Paseo 1c00b365 main.ts sets userData from
// PASEO_ELECTRON_USER_DATA_DIR before requestSingleInstanceLock (line 873) and
// loads paseo://app; daemon-manager.ts returns early when manageBuiltInDaemon is false.
export const PIN = {
  commit: '1c00b365c9e0b74c1580eba33d905d693125ae21',
  appVersion: '0.15.4',
  appImage: 'https://github.com/getpaseo/paseo/releases/download/v0.15.4/Paseo-x86_64.AppImage',
  appImageSha256: 'a35de13bb9642e75e418c2906ef54ab24c5364140645199d2cf2d9ef3d5c7797',
  executable: 'squashfs-root/Paseo.bin',
} as const;
// Pinned desktop-settings.ts document: omitted releaseChannel/notifications fall back to
// their schema defaults; both migrations are already applied so no legacy import runs.
export const DESKTOP_SETTINGS = {
  version: 1,
  settings: { daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: false } },
  migrations: { legacyRendererSettingsImported: true, daemonStopOnQuitDefaultApplied: true },
} as const;
// The app imports a login shell; a personal profile must never restore secrets or settings.
export const SHELL_WRAPPER = '#!/bin/bash\nexec /bin/bash --noprofile --norc "$@"\n';
export const TARGET_ID = 'desktop-linux-xvfb';
export const VIRTUAL_DISPLAY = { server: 'Xvfb', screen: '1920x1080x24' } as const;
export const OWNER_DEFERRED = {
  ios: 'owner-deferred: iOS qualification was explicitly deferred by the owner for this Linux-only delivery',
  android: 'owner-deferred: Android qualification was explicitly deferred by the owner for this Linux-only delivery',
} as const;

export function requireRuntime(version = process.version, platform = process.platform) {
  if (platform !== 'linux' || version !== 'v22.19.0') throw new Error('Native qualification requires Linux and Node 22.19.0');
}
export function ownedPath(root: string, path: string) {
  if (!isAbsolute(root) || resolve(root) !== root || !isAbsolute(path) || resolve(path) !== path || !path.startsWith(root + '/'))
    throw new Error('Refusing native runtime path outside the owned root');
  return path;
}
export function displayNumber(display: string) {
  const match = /^:([5-9]|[1-9][0-9]{1,3})$/.exec(display);
  if (!match) throw new Error('Owned virtual display :N between :5 and :9999 required; never reuse a personal display');
  return Number(match[1]);
}
export async function writeDesktopProfile(root: string, userData: string, effects: { mkdir: typeof mkdir; writeFile: typeof writeFile } = { mkdir, writeFile }) {
  ownedPath(root, userData);
  const settings = ownedPath(root, join(userData, 'desktop-settings.json'));
  await effects.mkdir(userData, { recursive: true });
  await effects.writeFile(settings, `${JSON.stringify(DESKTOP_SETTINGS)}\n`);
  return settings;
}
export async function writeShell(root: string, shell: string, effects: { writeFile: typeof writeFile; chmod: typeof chmod } = { writeFile, chmod }) {
  ownedPath(root, shell);
  await effects.writeFile(shell, SHELL_WRAPPER); await effects.chmod(shell, 0o700);
  return shell;
}
// Allowlisted environment only. No inherited HOME/XDG/PASEO_HOST/credentials and no
// PASEO_DISABLE_SINGLE_INSTANCE_LOCK: the pinned profile owns the lock and the daemon.
export function nativeEnvironment(input: { root: string; bin: string; home: string; appHome: string; userData: string; shell: string; display: string }): NodeJS.ProcessEnv {
  for (const path of [input.bin, input.home, input.appHome, input.userData, input.shell]) ownedPath(input.root, path);
  displayNumber(input.display);
  return { PATH: input.bin, HOME: input.home, XDG_CONFIG_HOME: join(input.home, 'config'), XDG_DATA_HOME: join(input.home, 'data'), XDG_CACHE_HOME: join(input.home, 'cache'),
    TMPDIR: join(input.home, 'tmp'), LANG: 'C.UTF-8', TZ: 'UTC', CI: '1', NO_COLOR: '1', PASEO_HOME: input.appHome, PASEO_ELECTRON_USER_DATA_DIR: input.userData,
    SHELL: input.shell, DISPLAY: input.display, PASEO_RELAY_ENABLED: 'false', PASEO_ORBI_E2E_OWNER: input.root };
}

export type DisplayEffects = {
  access: (path: string, mode: number) => Promise<void>;
  mkdir: typeof mkdir;
  exists: (path: string) => Promise<boolean>;
  spawn: (file: string, args: string[], options: { env: NodeJS.ProcessEnv; detached: boolean; stdio: ['ignore', 'pipe', 'pipe'] }) => { pid?: number; stderr: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null };
  identity: (pid: number) => Promise<Identity | null>;
  sleep: (ms: number) => Promise<void>;
  stop: (owned: Identity[]) => Promise<void>;
};
export async function startDisplay(input: { root: string; display: string; server?: string }, effects: Partial<DisplayEffects> = {}) {
  const e: DisplayEffects = { access, mkdir, exists, spawn, identity, sleep: pause, stop: stopOwned, ...effects };
  const server = input.server ?? '/usr/bin/Xvfb', number = displayNumber(input.display), socket = `/tmp/.X11-unix/X${number}`;
  try { await e.access(server, constants.X_OK); }
  catch { throw new Error('Missing runtime prerequisite: executable /usr/bin/Xvfb required for the owned virtual display'); }
  if (await e.exists(socket)) throw new Error(`Display ${input.display} socket exists; refusing to attach to an existing display`);
  const home = ownedPath(input.root, join(input.root, 'display'));
  await e.mkdir(home, { recursive: true });
  let log = '';
  const child = e.spawn(server, [input.display, '-screen', '0', VIRTUAL_DISPLAY.screen, '-nolisten', 'tcp'], { env: { PATH: dirname(server), HOME: home, TMPDIR: home, PASEO_ORBI_E2E_OWNER: input.root }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', chunk => { log = (log + String(chunk)).slice(-8192); });
  const initial = child.pid ? await e.identity(child.pid) : null;
  if (!initial) throw new Error('Owned Xvfb failed to spawn');
  try { await boundedWait(() => e.exists(socket), 30000, e.sleep); }
  catch (error) { return finishFailedStart(new Error(`Owned virtual display ${input.display} did not become ready within the 30-second deadline: ${sanitize(log)}`), () => e.stop([initial])); }
  return { display: input.display, socket, identity: initial };
}

export type AcquireEffects = {
  download: (url: string) => Promise<Buffer>;
  sha256: (bytes: Buffer) => string;
  mkdir: typeof mkdir; writeFile: typeof writeFile; chmod: typeof chmod;
  exec: (file: string, args: string[], options: { cwd: string }) => Promise<unknown>;
  exists: (path: string) => Promise<boolean>;
};
async function downloadAppImage(url: string) {
  if (url !== PIN.appImage) throw new Error('Unapproved AppImage source; refusing download');
  // Bounded acquisition: a stalled download must fail the run, never hang it.
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 600000);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`AppImage download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally { clearTimeout(timer); }
}
// Official 0.15.4 AppImage into owned storage only. The pinned SHA-256 is verified before
// extraction, and extraction never runs the packaging wrapper (which may disable sandboxing).
export async function acquireAppImage(root: string, effects: Partial<AcquireEffects> = {}) {
  const e: AcquireEffects = { download: downloadAppImage, sha256: bytes => createHash('sha256').update(bytes).digest('hex'), mkdir, writeFile, chmod, exists,
    exec: (file, args, options) => exec(file, args, { cwd: options.cwd, timeout: 300000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: options.cwd, TMPDIR: options.cwd } }), ...effects };
  const dir = ownedPath(root, join(root, 'app'));
  await e.mkdir(dir, { recursive: true });
  const appImage = ownedPath(root, join(dir, 'Paseo-x86_64.AppImage'));
  const bytes = await e.download(PIN.appImage), digest = e.sha256(bytes);
  if (digest !== PIN.appImageSha256) throw new Error(`AppImage SHA-256 mismatch (expected ${PIN.appImageSha256}, got ${digest}); refusing to execute`);
  await e.writeFile(appImage, bytes); await e.chmod(appImage, 0o500);
  await e.exec(appImage, ['--appimage-extract'], { cwd: dir });
  const executable = ownedPath(root, join(dir, PIN.executable));
  if (!(await e.exists(executable))) throw new Error('Packaged AppImage did not contain squashfs-root/Paseo.bin; refusing to run a launcher wrapper');
  return { appImage, executable, digest };
}

export type LaunchEffects = { launch: (options: Record<string, unknown>) => Promise<ElectronApplication> };
// One worker, chromiumSandbox explicitly on (Playwright defaults to false), bounded startup,
// and a partial launch is closed by identity rather than left running.
export async function launchApp(input: { bin: string; env: NodeJS.ProcessEnv; timeoutMs?: number }, effects: Partial<LaunchEffects> = {}) {
  const launch = effects.launch ?? (options => electron.launch(options as Parameters<typeof electron.launch>[0]));
  const timeout = input.timeoutMs ?? 60000;
  if (!input.bin.endsWith(PIN.executable)) throw new Error('Refusing to launch anything but the extracted packaged binary');
  const env = Object.fromEntries(Object.entries(input.env).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
  const app = await launch({ executablePath: input.bin, env, chromiumSandbox: true, timeout });
  let timer: NodeJS.Timeout | undefined;
  try {
    const window = await Promise.race([app.firstWindow(), new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error(`Native app produced no window within ${Math.round(timeout / 1000)} seconds`)), timeout); })]);
    if (!window) throw new Error('Native app produced no window');
    return { app, window };
  } catch (error) {
    return finishFailedStart(error, () => app.close());
  } finally { if (timer) clearTimeout(timer); }
}

export type NativeSeams = {
  runtime: () => void;
  root: () => Promise<string>;
  prepare: (root: string, input: Inputs) => Promise<{ candidate: string; sha: string; cli: string }>;
  acquire: (root: string) => Promise<{ executable: string; digest: string }>;
  display: (root: string) => Promise<{ display: string; socket: string; identity: Identity }>;
  hosts: (hosts: Host[], root: string, candidate: string, cli: string) => Promise<void>;
  release: (input: Pick<Inputs, 'output' | 'repo'>, root: string, hosts: Host[], extra: { identities: Identity[] }) => Promise<unknown>;
};
export function nativeSeams(): NativeSeams {
  return {
    runtime: () => requireRuntime(),
    root: async () => mkdtemp(join(await realpath('/tmp'), 'paseo-orbi-native-')),
    prepare: async (root, input) => { const isolated = await setupEnvironment(root); const { candidate, sha } = await prepareCandidate(input, root, isolated); return { candidate, sha, cli: resolve('tests/e2e/runtime/node_modules/@getpaseo/cli/bin/paseo') }; },
    acquire: root => acquireAppImage(root),
    display: root => startDisplay({ root, display: process.env.PASEO_E2E_DISPLAY ?? ':99' }),
    hosts: (hosts, root, candidate, cli) => startHosts(hosts, root, candidate, cli),
    release: (input, root, hosts, extra) => release(input, root, hosts, extra),
  };
}
// Native preparation and isolation. It never launches the app (the spec worker owns that)
// and writes the honest receipt: mobile slots stay not_run, desktop stays fail until the
// execution owner has inspected every image.
export async function openNative(env: NodeJS.ProcessEnv, seams: NativeSeams = nativeSeams()) {
  let input!: Inputs;
  approveNativeLaunch(env, value => { input = value; }); // no effects before approval
  seams.runtime();
  await checkFreshPath(input.output);
  await mkdir(dirname(input.output), { recursive: true });
  if (await realpath(dirname(input.output)) !== dirname(input.output)) throw new Error('Outside/symlink evidence parent');
  await mkdir(input.output);
  const root = await seams.root(), hosts: Host[] = [], identities: Identity[] = [];
  const dispose = async () => { await seams.release(input, root, hosts, { identities }); };
  try {
    const { candidate, sha, cli } = await seams.prepare(root, input);
    const acquired = await seams.acquire(root);
    const display = await seams.display(root);
    identities.push(display.identity);
    const app = join(root, 'app'); await mkdir(app);
    const bin = join(app, 'bin'); await mkdir(bin);
    const home = join(app, 'home'); await mkdir(home);
    for (const child of ['config', 'data', 'cache', 'tmp']) await mkdir(join(home, child));
    const appHome = join(app, 'paseo-home'); await mkdir(appHome);
    const userData = join(app, 'user-data'); await mkdir(userData);
    const settings = await writeDesktopProfile(root, userData);
    const shell = await writeShell(root, join(root, 'app/login-shell'));
    const environment = nativeEnvironment({ root, bin, home, appHome, userData, shell, display: display.display });
    const targets = [
      { id: TARGET_ID, platform: 'desktop', targetClass: 'emulator', osVersion: `${process.platform} ${osRelease()}`, paseoVersion: PIN.appVersion, status: 'fail', pendingManualInspection: true,
        virtualDisplay: { ...VIRTUAL_DISPLAY, display: display.display, socket: display.socket } },
      { id: 'ios-pending', platform: 'ios', targetClass: 'simulator', osVersion: 'unknown', paseoVersion: 'unknown', status: 'not_run', missingInput: OWNER_DEFERRED.ios },
      { id: 'android-pending', platform: 'android', targetClass: 'emulator', osVersion: 'unknown', paseoVersion: 'unknown', status: 'not_run', missingInput: OWNER_DEFERRED.android },
    ];
    await writeFile(join(input.output, 'receipt.json'), JSON.stringify({ approval: input.approval, candidate: '[EXACT_COMMITTED_ARCHIVE]', evidenceKind: 'native', pluginSha: sha, dirty: false,
      nodeVersion: process.version, daemonVersion: '0.15.4', appVersion: PIN.appVersion, playwrightVersion: '1.65.1', observedAt: new Date().toISOString(), targets }, null, 2));
    await seams.hosts(hosts, root, candidate, cli);
    const { port, release: free } = await reservePort();
    await free();
    if (!(await portClosed(port))) throw new Error('Occupied loopback port; refusing to model a disconnected host');
    const native = { targetId: TARGET_ID, display: display.display, socket: display.socket, executable: acquired.executable, appImageDigest: acquired.digest, environment, home, appHome, userData, settings, shell,
      virtualDisplay: { ...VIRTUAL_DISPLAY, display: display.display, socket: display.socket }, disconnectedHost: `tcp://127.0.0.1:${port}` };
    return { input, root, hosts: hosts.slice(), display, environment, native, lease: { ...lease({ root, input, hosts }), native }, dispose };
  } catch (error) {
    const primary = new Error(sanitize(String((error as Error)?.message ?? error), [root, input.repo, input.output]));
    await writeFile(join(input.output, 'startup.log'), primary.message);
    return finishFailedStart(primary, dispose);
  }
}

export type NativeLease = { root: string; input: Inputs; hosts: Host[]; native: {
  targetId: string; display: string; socket: string; executable: string; appImageDigest: string; environment: NodeJS.ProcessEnv;
  home: string; appHome: string; userData: string; settings: string; shell: string; virtualDisplay: { server: string; screen: string; display: string; socket: string }; disconnectedHost: string } };
export async function readLease(path = process.env.PASEO_E2E_LEASE) {
  if (!path) throw new Error('No owned native lease; run the approved native global setup, never a personal profile or display.');
  return JSON.parse(await readFile(path, 'utf8')) as NativeLease;
}
// Windows are opened by the app itself; only actual test-window pixels are captured.
export async function capture(page: Page, running: NativeLease, c: { id: string; view: string; theme: string; scenario: string; tool: string; supplemental?: boolean }) {
  // The evidence helpers stay the single PNG/provenance decoder; loaded here so this module
  // remains Node-typed for the root offline typecheck.
  const { pngSize, provenance } = await import(new URL('../evidence.mjs', import.meta.url).href);
  await page.evaluate(() => (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document.fonts.ready);
  await page.waitForTimeout(1000);
  const geometry = () => page.evaluate(() => {
    const document = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; scrollHeight: number } } }).document;
    return { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight };
  });
  const before = await geometry(); await page.waitForTimeout(150); expect(await geometry()).toEqual(before);
  await expect(page.locator('body')).not.toContainText(/(?:SECRET|TOKEN|PROMPT|REASONING|PRIVATE)[A-Z_]*CANARY/);
  const path = `${c.id}.png`, bytes = await page.screenshot({ path: join(running.input.output, path), fullPage: true }), size = pngSize(bytes) as { width: number; height: number };
  const fixture = (await provenance()).find((p: { profile: string }) => p.profile === running.hosts[0].profile);
  // Every image carries its own OS and virtual-display provenance, not only its target's.
  await writeFile(join(running.input.output, `${c.id}.shot.json`), JSON.stringify({ ...c, targetId: running.native.targetId, path, pixelWidth: size.width, pixelHeight: size.height, sha256: digestOf(bytes),
    pluginSha: running.input.sha, dirty: false, daemonVersion: '0.15.4', appVersion: PIN.appVersion, osVersion: `${process.platform} ${osRelease()}`, toolVersion: c.tool, hostAlias: 'host-a',
    virtualDisplay: running.native.virtualDisplay, fixture, observedAt: new Date().toISOString(), expected: 'pass', observed: 'pass', inspection: null }, null, 2));
  return size;
}

type WorkerFixtures = { native: { lease: NativeLease; app: ElectronApplication; page: Page; errors: string[]; tool: string } };
export const test = base.extend<{}, WorkerFixtures>({
  // The one worker owns the single window; the lease carries the owned profile, display and hosts.
  native: [async ({}, use) => {
    const running = await readLease();
    const { app, window } = await launchApp({ bin: running.native.executable, env: running.native.environment });
    const errors: string[] = [];
    window.on('pageerror', error => errors.push(sanitize(error.message, [running.root, process.cwd()])));
    window.on('console', message => { if (message.type() === 'error') errors.push(sanitize(message.text(), [running.root, process.cwd()])); });
    const tool = await app.evaluate(() => `electron@${process.versions.electron} xvfb@${process.env.DISPLAY ?? ''}`);
    try { await use({ lease: running, app, page: window, errors, tool }); }
    finally {
      await writeFile(join(running.input.output, 'native-app.log'), errors.join('\n'));
      await app.close();
      expect(errors, 'unexpected native renderer errors').toEqual([]);
      // Same read-only invariant as the browser lane: the observer never mutated a host.
      for (const host of running.hosts) {
        const calls = (await readFile(host.calls, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { allowed: boolean });
        expect(calls.every(call => call.allowed === true), 'observer attempted an unapproved command').toBe(true);
      }
    }
  }, { scope: 'worker' }],
});
export { expect };
export default async function globalSetup() {
  const running = await openNative(process.env);
  const path = join(running.root, 'lease.json');
  await writeFile(path, JSON.stringify(running.lease));
  process.env.PASEO_E2E_LEASE = path;
  return running.dispose;
}
