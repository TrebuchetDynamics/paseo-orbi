import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { approveLaunch, approveNativeLaunch, stopOwned, type Host, type Identity } from './e2e/harness';
import { DESKTOP_SETTINGS, OWNER_DEFERRED, PIN, SHELL_WRAPPER, TARGET_ID, acquireAppImage, displayNumber, launchApp, nativeEnvironment, openNative, requireRuntime, startDisplay, writeDesktopProfile, writeShell } from './e2e/native/fixture';

const evidence = await import(new URL('./e2e/evidence.mjs', import.meta.url).href);
const nativeVerify = await import(new URL('./e2e/native/verify.mjs', import.meta.url).href);
const { provenance, sha256, pngSize, views, themes } = evidence;
const nativeApproval = 'https://github.com/TrebuchetDynamics/paseo-orbi/issues/13#issuecomment-6909863490';
const approved = { PASEO_E2E_ENABLE_TRUSTED_PLUGINS: '1', PASEO_E2E_APPROVAL_URL: nativeApproval, PASEO_E2E_CANDIDATE_REPO: '/candidate', PASEO_E2E_CANDIDATE_SHA: 'a'.repeat(40), PASEO_E2E_OUTPUT: '/owned/.artifacts/paseo-qualification/3d9ce678' };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function ownedRoot() { const root = await mkdtemp(join(tmpdir(), 'orbi-native-unit-')); roots.push(root); return root; }
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });

it('native approval refuses issue-12 receipts, inherited flags and non-owned outputs before any effect', async () => {
  let effects = 0;
  for (const env of [{}, { ...approved, PASEO_E2E_ENABLE_TRUSTED_PLUGINS: '' }, { ...approved, PASEO_E2E_APPROVAL_URL: 'https://github.com/TrebuchetDynamics/paseo-orbi/issues/12#issuecomment-1' },
    { ...approved, PASEO_E2E_OUTPUT: '/home/user' }, { ...approved, PASEO_E2E_CANDIDATE_SHA: 'main' }]) expect(() => approveNativeLaunch(env, () => effects++)).toThrow(/approval|explicit/i);
  expect(effects).toBe(0);
  // The browser lane still requires its own #12 consent: native trust is not inherited backwards.
  expect(() => approveLaunch({ ...approved, PASEO_E2E_APPROVAL_URL: nativeApproval }, () => effects++)).toThrow(/approval/i);
  approveNativeLaunch(approved, value => { effects++; expect(value.approval).toBe(nativeApproval); }); expect(effects).toBe(1);
  const seams = nativeSeams(); await expect(openNative({}, seams)).rejects.toThrow(/approval/i);
  expect(seams.runtime).not.toHaveBeenCalled(); expect(seams.release).not.toHaveBeenCalled();
});

it('desktop profile is a fresh owned pinned document that suppresses the built-in daemon and legacy import', async () => {
  const root = await ownedRoot(), userData = join(root, 'app/user-data');
  const settings = await writeDesktopProfile(root, userData);
  expect(settings).toBe(join(userData, 'desktop-settings.json'));
  const raw = await readFile(settings, 'utf8');
  expect(raw).toBe(JSON.stringify({ version: 1, settings: { daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: false } }, migrations: { legacyRendererSettingsImported: true, daemonStopOnQuitDefaultApplied: true } }) + '\n');
  expect(JSON.parse(raw)).toEqual(DESKTOP_SETTINGS);
  expect(DESKTOP_SETTINGS.settings.daemon.manageBuiltInDaemon).toBe(false);
  expect(DESKTOP_SETTINGS.settings.daemon.keepRunningAfterQuit).toBe(false);
  expect(DESKTOP_SETTINGS.migrations).toEqual({ legacyRendererSettingsImported: true, daemonStopOnQuitDefaultApplied: true });
  await expect(writeDesktopProfile(root, '/etc/paseo')).rejects.toThrow(/outside/);
  await expect(writeDesktopProfile(root, join(root, '../user-data'))).rejects.toThrow(/outside/);
  const writes: string[] = [];
  await writeDesktopProfile(root, join(root, 'app/effects'), { mkdir: async () => {}, writeFile: async (path: string) => { writes.push(path); } } as never);
  expect(writes).toEqual([join(root, 'app/effects/desktop-settings.json')]);
});

it('native environment stays allowlisted, separate from fixture daemon homes and uses only the owned no-profile shell', async () => {
  const root = await ownedRoot(), home = join(root, 'app/home'), appHome = join(root, 'app/paseo-home');
  for (const path of [home, appHome, join(root, 'app/user-data'), join(root, 'app/bin')]) await mkdir(path, { recursive: true });
  const shell = await writeShell(root, join(root, 'app/login-shell'));
  expect(await readFile(shell, 'utf8')).toBe(SHELL_WRAPPER);
  expect((await stat(shell)).mode & 0o777).toBe(0o700);
  vi.stubEnv('GH_TOKEN', 'TOKEN_SECRET_CANARY'); vi.stubEnv('PASEO_HOST', 'tcp://elsewhere:6767');
  const env = nativeEnvironment({ root, bin: join(root, 'app/bin'), home, appHome, userData: join(root, 'app/user-data'), shell, display: ':99' });
  for (const key of ['GH_TOKEN', 'PASEO_HOST', 'OPENAI_API_KEY', 'SSH_AUTH_SOCK', 'PASEO_DISABLE_SINGLE_INSTANCE_LOCK']) expect(env[key]).toBeUndefined();
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'PASEO_HOME', 'PASEO_ELECTRON_USER_DATA_DIR', 'SHELL']) expect(env[key]).toMatch(/^\/.*app\//);
  expect(env.HOME).toBe(home); expect(env.PASEO_HOME).toBe(appHome); expect(env.SHELL).toBe(shell); expect(env.DISPLAY).toBe(':99');
  expect(env.PATH).toBe(join(root, 'app/bin')); expect(env.PATH).not.toMatch(/(?:^|:)\/(?:usr\/)?bin(?:$|:)/);
  expect(env.PASEO_ORBI_E2E_OWNER).toBe(root); expect(env.PASEO_RELAY_ENABLED).toBe('false');
  expect(SHELL_WRAPPER).toBe('#!/bin/bash\nexec /bin/bash --noprofile --norc "$@"\n');
  expect(() => nativeEnvironment({ root, bin: join(root, 'app/bin'), home: '/outside/home', appHome, userData: join(root, 'app/user-data'), shell, display: ':99' })).toThrow(/outside/);
  expect(() => displayNumber(':0')).toThrow(/display/); expect(displayNumber(':99')).toBe(99); expect(() => displayNumber(':1e3')).toThrow(/display/);
  expect(() => requireRuntime('v26.0.0', 'linux')).toThrow(/22\.19\.0/); expect(() => requireRuntime('v22.19.0', 'darwin')).toThrow(/Linux/);
  expect(() => requireRuntime('v22.19.0', 'linux')).not.toThrow();
});

it('refuses an unpinned AppImage digest, an occupied display and a missing packaged binary', async () => {
  const writes: string[] = [], executed: { file: string; args: string[]; cwd: string }[] = [];
  const effects = { download: async () => Buffer.from('not the pinned bytes'), sha256: () => 'b'.repeat(64), mkdir: async () => {}, chmod: async () => {},
    writeFile: async (path: string) => { writes.push(path); }, exec: async (file: string, args: string[], options: { cwd: string }) => { executed.push({ file, args, cwd: options.cwd }); }, exists: async () => true };
  await expect(acquireAppImage('/owned', effects as never)).rejects.toThrow(/SHA-256/);
  expect(writes).toEqual([]); expect(executed).toEqual([]);
  writes.length = 0;
  const split = { ...effects, download: async () => Buffer.from('appimage'), sha256: () => PIN.appImageSha256, exists: async (path: string) => path.endsWith('Paseo.bin') };
  const acquired = await acquireAppImage('/owned', split as never);
  expect(acquired).toEqual({ appImage: '/owned/app/Paseo-x86_64.AppImage', executable: '/owned/app/squashfs-root/Paseo.bin', digest: PIN.appImageSha256 });
  expect(writes).toEqual(['/owned/app/Paseo-x86_64.AppImage']);
  expect(executed).toEqual([{ file: '/owned/app/Paseo-x86_64.AppImage', args: ['--appimage-extract'], cwd: '/owned/app' }]);
  expect(PIN.appImage).toBe('https://github.com/getpaseo/paseo/releases/download/v0.15.4/Paseo-x86_64.AppImage');
  expect(PIN.appImageSha256).toBe('a35de13bb9642e75e418c2906ef54ab24c5364140645199d2cf2d9ef3d5c7797');

  let socketChecks = 0;
  const display = await startDisplay({ root: '/owned', display: ':99' }, {
    access: async () => {}, mkdir: async () => {}, exists: async () => ++socketChecks > 1, identity: async (pid: number) => ({ pid, ppid: 1, pgid: pid, start: '1' }),
    spawn: () => ({ pid: 4242, stderr: { on: () => {} } }), sleep: async () => {}, stop: vi.fn(async () => {}) } as never);
  expect(display).toEqual({ display: ':99', socket: '/tmp/.X11-unix/X99', identity: { pid: 4242, ppid: 1, pgid: 4242, start: '1' } });
  await expect(startDisplay({ root: '/owned', display: ':99' }, { access: async () => { throw missing(); } } as never)).rejects.toThrow(/Xvfb/);
  await expect(startDisplay({ root: '/owned', display: ':99' }, { access: async () => {}, exists: async () => true } as never)).rejects.toThrow(/refusing to attach/);
  const stop = vi.fn(async () => {});
  await expect(startDisplay({ root: '/owned', display: ':99' }, { access: async () => {}, mkdir: async () => {}, exists: async () => false, spawn: () => ({ pid: 4243, stderr: { on: () => {} } }),
    identity: async (pid: number) => ({ pid, ppid: 1, pgid: pid, start: '1' }), sleep: async (ms: number) => { if (ms > 0) throw new Error('deadline'); }, stop } as never)).rejects.toThrow(/deadline/);
  expect(stop).toHaveBeenCalledWith([{ pid: 4243, ppid: 1, pgid: 4243, start: '1' }]);
});

it('launches only the extracted packaged binary with the Chromium sandbox and closes a partial launch', async () => {
  const options: Record<string, unknown>[] = [], closed = vi.fn(async () => {});
  const firstWindow = vi.fn(async () => ({ on: () => {} }));
  const app = { firstWindow, close: closed } as never;
  const launched = await launchApp({ bin: '/owned/app/squashfs-root/Paseo.bin', env: { HOME: '/owned/app/home', GH_TOKEN: undefined } as never },
    { launch: async value => { options.push(value); return app; } });
  expect(launched.app).toBe(app); expect(closed).not.toHaveBeenCalled();
  expect(options[0]).toMatchObject({ executablePath: '/owned/app/squashfs-root/Paseo.bin', chromiumSandbox: true, timeout: 60000 });
  expect(options[0].executablePath).not.toMatch(/AppImage|AppRun|chrome-sandbox$/);
  expect(options[0].env).toEqual({ HOME: '/owned/app/home' });
  const failing = { firstWindow: async () => { throw new Error('inspector attach refused'); }, close: closed } as never;
  await expect(launchApp({ bin: '/owned/app/squashfs-root/Paseo.bin', env: {} }, { launch: async () => failing })).rejects.toThrow(/inspector attach refused/);
  expect(closed).toHaveBeenCalledTimes(1);
  const secondary = new Error('close refused');
  const broken = { firstWindow: async () => { throw new Error('no renderer'); }, close: async () => { throw secondary; } } as never;
  const error = await launchApp({ bin: '/owned/app/squashfs-root/Paseo.bin', env: {} }, { launch: async () => broken }).catch(value => value);
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors.map((e: Error) => e.message)).toContain('close refused');
  await expect(launchApp({ bin: '/owned/app/squashfs-root/Paseo.bin', env: {}, timeoutMs: 20 }, { launch: async () => ({ firstWindow: () => new Promise(() => {}), close: closed } as never) })).rejects.toThrow(/no window/);
});

it('failed native startup reuses identity-safe teardown and refuses unproven processes', async () => {
  const root = await ownedRoot(), output = join(root, '.artifacts/paseo-qualification/3d9ce678');
  const seams = nativeSeams(root, { acquire: async () => { throw new Error('AppImage SHA-256 mismatch'); } });
  const error = await openNative({ ...approved, PASEO_E2E_OUTPUT: output }, seams).catch(value => value);
  expect(String(error)).toMatch(/SHA-256/); expect(seams.release).toHaveBeenCalledTimes(1);
  expect(seams.hosts).not.toHaveBeenCalled(); expect(await readFile(join(output, 'startup.log'), 'utf8')).toMatch(/SHA-256/);
  expect(String(seams.release.mock.calls[0][0].output)).toBe(output);
  const secondary = new Error('cleanup refused');
  const secondOutput = join(await ownedRoot(), '.artifacts/paseo-qualification/run-2');
  const second = nativeSeams(await ownedRoot(), { display: async () => { throw new Error('display failed'); }, release: async () => { throw secondary; } });
  const aggregate = await openNative({ ...approved, PASEO_E2E_OUTPUT: secondOutput }, second).catch(value => value);
  expect(aggregate).toBeInstanceOf(AggregateError); expect(aggregate.errors[0].message).toMatch(/display failed/); expect(aggregate.errors[1]).toBe(secondary);
  const thirdOutput = join(await ownedRoot(), '.artifacts/paseo-qualification/run-3');
  const lease = await openNative({ ...approved, PASEO_E2E_OUTPUT: thirdOutput }, nativeSeams(await ownedRoot())).then(value => value.lease);
  expect(lease.native).toMatchObject({ targetId: TARGET_ID, display: ':99', executable: '/owned/app/squashfs-root/Paseo.bin' });
  expect(lease.native.environment.PASEO_ELECTRON_USER_DATA_DIR).toMatch(/\/app\/user-data$/);
  expect(JSON.parse(await readFile(join(thirdOutput, 'receipt.json'), 'utf8'))).toMatchObject({ evidenceKind: 'native', pluginSha: 'a'.repeat(40), appVersion: '0.15.4' });
  const target = JSON.parse(await readFile(join(thirdOutput, 'receipt.json'), 'utf8')).targets;
  expect(target.map((t: any) => [t.platform, t.status, t.targetClass])).toEqual([['desktop', 'fail', 'emulator'], ['ios', 'not_run', 'simulator'], ['android', 'not_run', 'emulator']]);
  expect(target[0].virtualDisplay).toMatchObject({ server: 'Xvfb', display: ':99' });
  expect(target.slice(1).map((t: any) => t.missingInput)).toEqual([OWNER_DEFERRED.ios, OWNER_DEFERRED.android]);

  const display = { pid: 5001, ppid: 1, pgid: 5001, start: '1' }, reused = { ...display, start: '2' };
  const signal = vi.fn();
  await expect(stopOwned([display], { table: async () => [reused], signal, sleep: async () => {} })).rejects.toThrow(/reuse/);
  await expect(stopOwned([display], { table: async () => [display, { pid: 5002, ppid: 5001, pgid: 5001, start: '3' }], signal, sleep: async () => {} })).rejects.toThrow(/Unaccounted/);
  expect(signal).not.toHaveBeenCalled();
});

function nativeSeams(root?: string, overrides: Record<string, unknown> = {}): any {
  return {
    runtime: vi.fn(),
    root: async () => root ?? ownedRoot(),
    prepare: vi.fn(async () => ({ candidate: '/owned/candidate', sha: 'a'.repeat(40), cli: '/owned/cli' })),
    acquire: vi.fn(async () => ({ executable: '/owned/app/squashfs-root/Paseo.bin', digest: PIN.appImageSha256 })),
    display: vi.fn(async () => ({ display: ':99', socket: '/tmp/.X11-unix/X99', identity: { pid: 7001, ppid: 1, pgid: 7001, start: '1' } })),
    hosts: vi.fn(async (hosts: Host[]) => { hosts.push(fakeHost()); }),
    release: vi.fn(async () => ({ status: 'pass' })),
    ...overrides,
  };
}
function fakeHost() {
  return { initial: { pid: 8001, ppid: 1, pgid: 8001, start: '1' }, alias: 'host-a', profile: 'release', home: '/owned/host-a', state: '/owned/state.json', cli: '/owned/cli', candidate: '/owned/candidate',
    port: 4321, url: 'http://127.0.0.1:4321', host: 'tcp://127.0.0.1:4321', env: {}, registry: '/owned/registry.jsonl', calls: '/owned/calls.jsonl', startup: { deadline: Infinity },
    data: { authorization: '/owned/auth.json', entry: {}, cleanup: async () => {} }, log: () => '', setState: async () => {}, cliCall: async () => '[]' } as unknown as Host;
}

function png(width: number, height: number) {
  const crc = (buffer: Buffer) => { let n = 0xffffffff; for (const byte of buffer) { n ^= byte; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (name: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(name), data]), result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE(crc(body), result.length - 4); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
async function curatedNative() {
  const root = await ownedRoot();
  const fixture = (await provenance())[0], observedAt = '2026-11-20T00:00:00Z';
  const manifest: any = { evidenceKind: 'native', status: 'partial', pluginSha: 'a'.repeat(40), dirty: false, runId: '3d9ce678', observedAt, approvalUrl: nativeApproval,
    artifactUrl: 'https://github.com/TrebuchetDynamics/paseo-orbi/actions/runs/123/artifacts/456', expiresAt: '2026-12-15T00:00:00Z', cleanup: { status: 'pass' }, daemonVersion: '0.15.4', appVersion: '0.15.4',
    playwrightVersion: '1.65.1', nodeVersion: 'v22.19.0', executionStatus: 'passed', tests: [{ id: 'native linux journeys', title: 'native linux journeys', status: 'pass' }], screenshots: [],
    targets: [
      { id: TARGET_ID, platform: 'desktop', targetClass: 'emulator', osVersion: 'Linux 7.0.0-test', paseoVersion: '0.15.4', status: 'pass', virtualDisplay: { server: 'Xvfb', display: ':99', socket: '/tmp/.X11-unix/X99', screen: '1920x1080x24' } },
      { id: 'ios-pending', platform: 'ios', targetClass: 'simulator', osVersion: 'unknown', paseoVersion: 'unknown', status: 'not_run', missingInput: OWNER_DEFERRED.ios },
      { id: 'android-pending', platform: 'android', targetClass: 'emulator', osVersion: 'unknown', paseoVersion: 'unknown', status: 'not_run', missingInput: OWNER_DEFERRED.android },
    ] };
  for (const view of views) for (const theme of themes) {
    const id = `${TARGET_ID}-${view}-available-${theme}`, bytes = png(320, 240);
    await writeFile(join(root, `${id}.png`), bytes);
    manifest.screenshots.push({ id, targetId: TARGET_ID, view, theme, scenario: 'available', path: `${id}.png`, pixelWidth: pngSize(bytes).width, pixelHeight: pngSize(bytes).height, sha256: sha256(bytes),
      pluginSha: manifest.pluginSha, dirty: false, observedAt, daemonVersion: '0.15.4', appVersion: '0.15.4', toolVersion: 'electron-for-test', hostAlias: 'host-a', fixture, expected: 'pass', observed: 'pass',
      inspection: { horizontalClipping: false, scrollReachable: true, contrast: 'pass', stateVisible: true, reviewedBy: 'unit-fixture-only', at: observedAt } });
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { root, manifest };
}
const knownPartial = ['full-native PASS requires all three targets passing; partial is non-success', 'manifest is partial; not qualification success'];
const run = promisify(execFile);
// The documented command, not just the imported function.
async function wrapper(directory: string) {
  try { return { code: 0, stdout: (await run(process.execPath, ['tests/e2e/native/verify.mjs', directory], { encoding: 'utf8', timeout: 60000 })).stdout }; }
  catch (error: any) { return { code: Number(error.code ?? 1), stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` }; }
}

it('native verifier accepts only Linux evidence whose sole diagnostics are the two full-native ones', async () => {
  const { root } = await curatedNative();
  const result = await nativeVerify.verifyNative(root);
  expect(result.ok).toBe(true); expect(result.diagnostics).toEqual(knownPartial); expect(result.validation.status).toBe('partial');
  expect(result.validation.errors.slice().sort()).toEqual(knownPartial.slice().sort());
  const cli = await wrapper(root);
  expect(cli.code).toBe(0); expect(cli.stdout).toMatch(/Linux native evidence integrity PASS/); expect(cli.stdout).toMatch(/expected to be partial with a nonzero raw exit/);
  const raw = JSON.parse(await readFile(join(root, 'native-validation.json'), 'utf8'));
  expect(raw.wrapper).toEqual({ ok: true, errors: [] }); expect(raw.raw.errors.slice().sort()).toEqual(knownPartial.slice().sort());

  const { root: partialRoot, manifest } = await curatedNative();
  for (const [name, mutate] of [
    ['desktop not_run', (m: any) => { m.targets[0].status = 'not_run'; m.targets[0].osVersion = 'unknown'; m.targets[0].paseoVersion = 'unknown'; m.targets[0].missingInput = 'no linux'; }],
    ['desktop physical', (m: any) => { m.targets[0].targetClass = 'physical'; }],
    ['no virtual display', (m: any) => { delete m.targets[0].virtualDisplay; }],
    ['mobile not owner deferred', (m: any) => { m.targets[2].missingInput = 'no android access'; }],
    ['missing desktop image', (m: any) => { m.screenshots.splice(0, 1); }],
    ['manifest claims pass', (m: any) => { m.status = 'pass'; }],
    ['desktop pending inspection', (m: any) => { m.targets[0].status = 'fail'; }],
    ['uninspected image', (m: any) => { m.screenshots[0].inspection = null; }],
    ['no artifact link', (m: any) => { m.artifactUrl = null; }],
    ['duplicate platform', (m: any) => { m.targets[1].platform = 'android'; }],
  ] as const) {
    await writeFile(join(partialRoot, 'manifest.json'), JSON.stringify(mutate(manifest) ?? manifest));
    expect((await nativeVerify.verifyNative(partialRoot)).ok, name).toBe(false);
  }
  const broken = await curatedNative(), first = join(broken.root, broken.manifest.screenshots[0].path);
  await writeFile(first, 'not a PNG');
  expect((await nativeVerify.verifyNative(broken.root)).ok).toBe(false);
  const missing = await curatedNative(); await rm(join(missing.root, 'manifest.json'));
  expect((await nativeVerify.verifyNative(missing.root)).ok).toBe(false);
  expect((await wrapper(missing.root)).code).toBe(1);
  expect((await wrapper(broken.root)).code).toBe(1);
  const rejected = await curatedNative();
  const failClosed = await nativeVerify.verifyNative(rejected.root, { validate: async () => { throw new Error('validator crashed'); } });
  expect(failClosed.ok).toBe(false); expect(failClosed.errors.join()).toMatch(/validator crashed/);
  const extra = await nativeVerify.verifyNative(rejected.root, { validate: async () => ({ status: 'partial', errors: [...knownPartial, 'screenshot hash: injected'] }) });
  expect(extra.ok).toBe(false); expect(extra.errors.join()).toMatch(/injected/);
}, 30000); // three real child-process wrapper runs plus repeated PNG decoding
