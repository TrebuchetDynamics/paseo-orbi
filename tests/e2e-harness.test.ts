import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigRepository } from '../server/config';
import { GitHubReader } from '../server/github';
import { RunsReader } from '../server/runs';
import { BlockersReader } from '../server/blockers';
import { ReadPorts } from '../server/read-ports';
import { readFleet } from '../server/fleet';
import { deflateSync } from 'node:zlib';
import { approveLaunch, isolation, environment, stopOwned, boundedWait, sanitize, checkFreshPath, requireListenerOwnership, start, prepareTelemetry, type Identity, installWhenRpcReady, exposePs, cleanupInstallations, finishFailedStart, type InstallationHost } from './e2e/harness';
const evidenceUrl = new URL('./e2e/evidence.mjs', import.meta.url);
const toolUrl = new URL('./e2e/fixtures/tool.mjs', import.meta.url);
const { default: EvidenceReporter, matrix, requiredTests, validate, sha256, provenance, pngSize } = await import(evidenceUrl.href);
const { operation } = await import(toolUrl.href);
const approved = { PASEO_E2E_ENABLE_TRUSTED_PLUGINS: '1', PASEO_E2E_APPROVAL_URL: 'https://github.com/TrebuchetDynamics/paseo-orbi/issues/12#issuecomment-123', PASEO_E2E_CANDIDATE_REPO: '/candidate', PASEO_E2E_CANDIDATE_SHA: 'a'.repeat(40), PASEO_E2E_OUTPUT: '/owned/.artifacts/paseo-qualification/84360d31' };

it('refuses_unapproved_or_nonisolated_launch', async () => {
  let effects = 0;
  for (const input of [{}, { ...approved, PASEO_E2E_ENABLE_TRUSTED_PLUGINS: '' }, { ...approved, PASEO_E2E_APPROVAL_URL: 'https://example.com/yes' }, { ...approved, PASEO_E2E_CANDIDATE_SHA: 'main' }, { ...approved, PASEO_E2E_CANDIDATE_REPO: '.' }, { ...approved, PASEO_E2E_OUTPUT: '/home/user' }]) expect(() => approveLaunch(input, () => effects++)).toThrow(/approval|explicit/i);
  expect(effects).toBe(0);
  await expect(start({})).rejects.toThrow(/approval/i);
  for (const [occupied, owned] of [[true, false]] as const) expect(() => requireListenerOwnership(occupied, owned)).toThrow(/unowned/);
  expect(() => requireListenerOwnership(true, true)).not.toThrow();
  await expect(checkFreshPath('/owned/home', async () => ({ isSymbolicLink: () => false }))).rejects.toThrow(/Reused/);
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  await expect(checkFreshPath('/outside/link/home', async path => { if (path.endsWith('/home')) throw missing; return { isSymbolicLink: () => path.endsWith('/link') }; })).rejects.toThrow(/symlink/);
  for (const [home, host, owned, fresh] of [['/outside', 'tcp://127.0.0.1:1234', true, true], ['/owned/home', 'tcp://0.0.0.0:1234', true, true], ['/owned/home', 'tcp://127.0.0.1:1234', false, true], ['/owned/home', 'tcp://127.0.0.1:1234', true, false], ['/owned/home', 'tcp://127.0.0.1:99999', true, true], ['/owned/../home', 'default', true, true]] as const)
    expect(() => isolation('/owned', home, host, owned, fresh)).toThrow(/nonisolated/);
  approveLaunch(approved, () => effects++); expect(effects).toBe(1);
});
it('scrubs provider, token, host, home and tool caches rather than spreading inherited settings', () => {
  vi.stubEnv('GH_TOKEN', 'TOKEN_SECRET_CANARY'); vi.stubEnv('PASEO_HOST', 'tcp://elsewhere:6767'); vi.stubEnv('HOME', '/private-profile');
  const env = environment('/owned', '/owned/bin', '/owned/home');
  for (const key of ['GH_TOKEN', 'PASEO_HOST', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'SSH_AUTH_SOCK']) expect(env[key]).toBeUndefined();
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG', 'NPM_CONFIG_CACHE', 'PLAYWRIGHT_BROWSERS_PATH', 'TMPDIR']) expect(env[key]).toMatch(/^\/owned\//);
  expect(sanitize('Bearer abcd https://user:password@example.com/?token=abcdef /owned TOKEN_SECRET_CANARY', ['/owned'])).not.toMatch(/abcd|password|abcdef|TOKEN_SECRET_CANARY|\/owned/);
  vi.unstubAllEnvs();
});
it('bounded startup wait and detached simulated read child cleanup use explicit ownership and escalation', async () => {
  let now = 0, checks = 0;
  await expect(boundedWait(async () => { checks++; return false; }, 200, async ms => { now += ms; }, () => now)).rejects.toThrow(/deadline/);
  expect(checks).toBeLessThanOrEqual(4);
  const daemon = { pid: 1001, ppid: 1, pgid: 1001, start: '10' }, detached = { pid: 1002, ppid: 1, pgid: 1002, start: '11' };
  let table: Identity[] = [daemon, detached]; const signals: unknown[] = [];
  await stopOwned([daemon, detached], { table: async () => table, signal: (pgid, signal) => { signals.push([pgid, signal]); if (signal === 'SIGKILL') table = table.filter(p => p.pgid !== pgid); }, sleep: async () => {} });
  expect(signals).toEqual([[1001, 'SIGTERM'], [1002, 'SIGTERM'], [1001, 'SIGKILL'], [1002, 'SIGKILL']]); expect(table).toEqual([]);
  const signal = vi.fn();
  await expect(stopOwned([daemon], { table: async () => [{ ...daemon, start: 'reused' }], signal, sleep: async () => {} })).rejects.toThrow(/reuse/);
  await expect(stopOwned([daemon], { table: async () => [daemon, { ...detached, pgid: daemon.pgid }], signal, sleep: async () => {} })).rejects.toThrow(/Unaccounted/);
  expect(signal).not.toHaveBeenCalled();
  let sleeps = 0;
  await expect(stopOwned([daemon], { table: async () => [daemon], signal, sleep: async () => { sleeps++; } })).rejects.toThrow(/survived/);
  expect(sleeps).toBe(40);
});
function lifecycleHost(installation: InstallationHost['installation'] = 'never-attempted') {
  return { alias: 'host-a', host: 'tcp://127.0.0.1:1234', candidate: '/owned/candidate', startup: { deadline: 60000 }, installation, cliCall: vi.fn(async (..._args: string[]) => '[]') };
}
const notReady = () => Object.assign(new Error('command failed'), { stderr: JSON.stringify({ error: { code: 'DAEMON_UNREACHABLE', message: 'Cannot connect to daemon at tcp://127.0.0.1:1234: Unexpected server response: 503', details: 'Check the selected endpoint and credentials. SSH transport does not install or start the daemon.' } }) + '\n' });
it('waits_for_rpc_ready_before_install', async () => {
  // HTTP health has already passed: only an unfiltered RPC list proves readiness.
  const host = lifecycleHost(); let now = 59800;
  host.cliCall.mockRejectedValueOnce(notReady()).mockResolvedValueOnce('[]').mockResolvedValueOnce('installed');
  await installWhenRpcReady(host, async ms => { now += ms; }, () => now);
  expect(host.cliCall.mock.calls).toEqual([['ls', '--json'], ['ls', '--json'], ['install', '/owned/candidate', '--id', 'paseo-orbi']]);
  expect(host.installation).toBe('confirmed'); expect(now).toBeLessThanOrEqual(60000);
});
it('RPC readiness shares the startup deadline and never retries refusal or a mutating install', async () => {
  const host = lifecycleHost(); let now = 59800;
  host.cliCall.mockRejectedValue(notReady());
  await expect(installWhenRpcReady(host, async ms => { now += ms; }, () => now)).rejects.toThrow(/deadline/);
  expect(host.cliCall.mock.calls.every(args => args.join(' ') === 'ls --json')).toBe(true);
  expect(host.cliCall.mock.calls.length).toBeLessThanOrEqual(3); expect(now).toBe(60000);
  expect(host.installation).toBe('never-attempted');
  for (const failure of [new Error('ECONNREFUSED'), Object.assign(new Error('failed'), { stderr: 'Error: permission denied' }), ...[{ code: 'AUTH_FAILED', message: 'Cannot connect to daemon at tcp://127.0.0.1:1234: Unexpected server response: 503' }, { code: 'DAEMON_UNREACHABLE', message: 'Cannot connect to daemon at tcp://127.0.0.1:9999: Unexpected server response: 503' }].map(error => Object.assign(new Error('failed'), { stderr: JSON.stringify({ error }) }))]) {
    const refused = lifecycleHost(); refused.cliCall.mockRejectedValue(failure);
    await expect(installWhenRpcReady(refused, async () => {}, () => 0)).rejects.toBe(failure); expect(refused.cliCall).toHaveBeenCalledTimes(1);
  }
  const malformed = lifecycleHost(); malformed.cliCall.mockResolvedValue('{}');
  await expect(installWhenRpcReady(malformed, async () => {}, () => 0)).rejects.toThrow(/list/); expect(malformed.installation).toBe('never-attempted');
  const ambiguous = lifecycleHost(); const failure = new Error('install timed out');
  ambiguous.cliCall.mockResolvedValueOnce('[]').mockRejectedValueOnce(failure);
  await expect(installWhenRpcReady(ambiguous, async () => {}, () => 0)).rejects.toBe(failure);
  expect(ambiguous.cliCall).toHaveBeenCalledTimes(2); expect(ambiguous.installation).toBe('uncertain');
});
it('isolated_runtime_exposes_only_required_ps', async () => {
  const access = vi.fn(async () => {}), link = vi.fn(async () => {});
  const before = environment('/owned', '/owned/bin', '/owned/home');
  await exposePs('/owned/bin', { access, symlink: link });
  expect(access).toHaveBeenCalledWith('/usr/bin/ps', 1);
  expect(link.mock.calls).toEqual([['/usr/bin/ps', '/owned/bin/ps']]);
  expect(environment('/owned', '/owned/bin', '/owned/home')).toEqual(before);
  expect(before.PATH).not.toMatch(/(?:^|:)(?:\/usr\/bin|\/bin)(?:$|:)/);
  link.mockClear(); access.mockRejectedValue(new Error('ENOENT'));
  await expect(exposePs('/owned/bin', { access, symlink: link })).rejects.toThrow(/prerequisite.*\/usr\/bin\/ps/i);
  expect(link).not.toHaveBeenCalled(); // missing prerequisite creates no ps link; no daemon is launched by this seam
});
function cleanupSeams() {
  return { snapshot: vi.fn(async () => [] as Identity[]), stop: vi.fn(async (_owned: Identity[]) => {}), verify: vi.fn(async (_owned: Identity[]) => {}), log: vi.fn(async (_host: InstallationHost) => {}) };
}
it('failed_install_cleanup_preserves_primary_error', async () => {
  const host = lifecycleHost('uncertain');
  host.cliCall.mockResolvedValueOnce('[{"id":"paseo-orbi","status":"running"}]').mockRejectedValueOnce(Object.assign(new Error('command failed'), { stderr: 'removal rejected TOKEN_SECRET_CANARY' }));
  const effects = cleanupSeams(); const result = await cleanupInstallations([host], effects);
  expect(host.cliCall.mock.calls).toEqual([['ls', '--json'], ['remove', 'paseo-orbi']]);
  expect(result.errors.join()).toMatch(/removal rejected/);
  expect(result.errors.join()).not.toContain('TOKEN_SECRET_CANARY');
  expect(effects.stop).toHaveBeenCalled(); expect(effects.verify).toHaveBeenCalled();
  const primary = new Error('Unexpected server response: 503'), secondary = new Error(result.errors.join());
  try { await finishFailedStart(primary, async () => { throw secondary; }); throw new Error('expected failure'); }
  catch (error) { expect(error).toBeInstanceOf(AggregateError); expect((error as AggregateError).errors).toEqual([primary, secondary]); expect(String(error)).toMatch(/503.*removal rejected/s); }
  await expect(finishFailedStart(primary, async () => {})).rejects.toBe(primary);
});
it('cleanup distinguishes never-attempted, ambiguous absent/present, confirmed and unverifiable without waiving teardown', async () => {
  for (const state of ['never-attempted', 'uncertain', 'confirmed'] as const) {
    const host = lifecycleHost(state), effects = cleanupSeams();
    const result = await cleanupInstallations([host], effects);
    expect(result.errors).toEqual([]);
    expect(result.removals[0].operation).toBe(state === 'never-attempted' ? 'not-attempted' : state === 'uncertain' ? 'absent-after-uncertain' : 'removed');
    expect(host.cliCall.mock.calls).toEqual(state === 'never-attempted' ? [] : state === 'uncertain' ? [['ls', '--json']] : [['remove', 'paseo-orbi']]);
    expect(effects.snapshot).toHaveBeenCalledTimes(2); expect(effects.stop).toHaveBeenCalled(); expect(effects.verify).toHaveBeenCalled();
  }
  const present = lifecycleHost('uncertain'); present.cliCall.mockResolvedValue('[{"id":"paseo-orbi"}]');
  expect((await cleanupInstallations([present], cleanupSeams())).removals[0].operation).toBe('removed');
  for (const response of ['unreachable', '{}']) {
    const host = lifecycleHost('uncertain'), effects = cleanupSeams();
    if (response === 'unreachable') host.cliCall.mockRejectedValue(new Error('endpoint unavailable')); else host.cliCall.mockResolvedValue(response);
    const result = await cleanupInstallations([host], effects);
    expect(result.errors.join()).toMatch(/unresolved/i); expect(result.removals[0].operation).toBe('unresolved');
    expect(effects.stop).toHaveBeenCalled(); expect(effects.verify).toHaveBeenCalled();
  }
  const host = lifecycleHost('uncertain'), effects = cleanupSeams();
  effects.verify.mockRejectedValue(new Error('Owned port still listening'));
  expect((await cleanupInstallations([host], effects)).errors.join()).toMatch(/still listening/);
  effects.snapshot.mockRejectedValue(new Error('Unaccounted owned descendant'));
  effects.stop.mockClear();
  expect((await cleanupInstallations([host], effects)).errors.join()).toMatch(/Unaccounted/);
  expect(effects.stop).not.toHaveBeenCalled();
});

it('strict stand-ins allow only actual ReadPorts GET/show/journal argv and never forward arbitrary commands', async () => {
  const data = { scenario: 'available', alias: 'host-a', records: JSON.parse(await readFile(new URL('./fixtures/runs/records.json', import.meta.url), 'utf8')), guidance: JSON.parse(await readFile(new URL('./fixtures/blockers/guidance.json', import.meta.url), 'utf8')) };
  const gh = ['api', '--hostname', 'github.com', '--method', 'GET', '--include', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', 'repos/Example/project/issues?state=open&sort=updated&direction=desc&per_page=100&page=1'];
  expect(operation('gh', gh, data)).toMatchObject({ allowed: true, code: 0 });
  for (const args of [['auth', 'token'], gh.map(s => s === 'GET' ? 'POST' : s), [...gh, '--jq', '.'], [...gh.slice(0, -1), 'repos/Private/repo/issues'], [...gh.slice(0, -1), 'repos/Example/project/issues?state=open&sort=updated&direction=desc&per_page=100&page=11']]) expect(operation('gh', args, data).allowed).toBe(false);
  for (const command of ['git', 'orbi', 'bash', 'npm']) expect(operation(command, [], data).allowed).toBe(false);
  expect(operation('systemctl', ['--user', 'stop', 'orbi-demo@1.service'], data).allowed).toBe(false);
  expect(operation('journalctl', ['--user', '-u', '*'], data).allowed).toBe(false);
  expect(operation('gh', gh, { ...data, scenario: 'unavailable' })).toMatchObject({ allowed: true, code: 1 });
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
// Actual PNG bytes, not a header-only mock: dimensions are independently decoded by validator.
function png(width: number, height: number) {
  const crc = (buffer: Buffer) => { let n = 0xffffffff; for (const byte of buffer) { n ^= byte; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (name: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(name), data]), result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE(crc(body), result.length - 4); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
async function complete(kind = 'browser') {
  const root = await mkdtemp(join(tmpdir(), 'orbi-evidence-unit-')); roots.push(root);
  const fixture = (await provenance())[0];
  const manifest: any = { evidenceKind: kind, status: 'pass', pluginSha: 'a'.repeat(40), dirty: false, runId: '84360d31', observedAt: '2026-11-15T00:00:00Z', approvalUrl: approved.PASEO_E2E_APPROVAL_URL,
    artifactUrl: 'https://github.com/TrebuchetDynamics/paseo-orbi/actions/runs/123/artifacts/456', expiresAt: '2026-12-15T00:00:00Z', cleanup: { status: 'pass' }, daemonVersion: '0.15.4', appVersion: '0.15.4', playwrightVersion: '1.65.1', nodeVersion: 'v22.19.0', executionStatus: 'passed',
    tests: requiredTests.map((t: any) => ({ ...t, id: `${t.browser}:${t.title}`, status: 'pass' })), screenshots: [] };
  let cases = matrix;
  if (kind === 'native') {
    manifest.targets = ['desktop', 'ios', 'android'].map((platform, i) => ({ id: platform, platform, targetClass: i === 0 ? 'physical' : i === 1 ? 'simulator' : 'emulator', osVersion: 'named-test-version', paseoVersion: '0.15.4', status: 'pass' }));
    cases = manifest.targets.flatMap((t: any) => ['fleet', 'issues', 'runs', 'blockers'].flatMap(view => ['light', 'dark'].map(theme => ({ id: `${t.id}-${view}-available-${theme}`, view, theme, scenario: 'available', targetId: t.id }))));
  }
  for (const c of cases) {
    const bytes = png(c.viewport?.width ?? 1, c.viewport?.height ?? 1), path = `${c.id}.png`;
    await writeFile(join(root, path), bytes);
    manifest.screenshots.push({ ...c, path, sha256: sha256(bytes), ...{ pixelWidth: pngSize(bytes).width, pixelHeight: pngSize(bytes).height }, pluginSha: manifest.pluginSha, dirty: false, observedAt: manifest.observedAt,
      daemonVersion: '0.15.4', appVersion: '0.15.4', playwrightVersion: '1.65.1', browser: 'chromium', browserVersion: 'pinned-revision-test', ...(kind === 'browser' ? { deviceScaleFactor: 1 } : { toolVersion: 'native-capture-test' }),
      hostAlias: 'host-a', fixture, expected: 'pass', observed: 'pass', inspection: { horizontalClipping: false, scrollReachable: true, contrast: 'pass', stateVisible: true, reviewedBy: 'unit-fixture-only', at: manifest.observedAt } });
  }
  return { root, manifest };
}
it('evidence manifest requires exactly the 42 browser matrix cases and all functional tests', async () => {
  const { root, manifest } = await complete();
  expect(matrix).toHaveLength(42); expect(new Set(matrix.map((c: any) => c.id)).size).toBe(42);
  expect(await validate(root, manifest)).toEqual({ status: 'pass', errors: [] });
  for (const mutate of [
    (m: any) => m.screenshots.pop(), (m: any) => m.screenshots.push(m.screenshots[0]), (m: any) => m.tests.pop(),
    (m: any) => { m.tests[0].status = 'skip'; }, (m: any) => { m.tests[0].status = 'fail'; },
    (m: any) => { m.screenshots[0].sha256 = '0'.repeat(64); }, (m: any) => { m.screenshots[0].pixelWidth++; },
    (m: any) => { m.screenshots[0].fixture.sha256 = '0'.repeat(64); }, (m: any) => { m.screenshots[0].pluginSha = 'b'.repeat(40); },
    (m: any) => { m.screenshots[0].inspection = null; }, (m: any) => { m.screenshots[0].path = '../outside.png'; },
    (m: any) => { m.executionStatus = 'failed'; }, (m: any) => { m.dirty = true; }, (m: any) => { m.cleanup.status = 'fail'; }, (m: any) => { m.appVersion = 'latest'; },
  ]) { const changed = structuredClone(manifest); mutate(changed); expect((await validate(root, changed)).status).toBe('partial'); }
});
it('rejects absent/corrupt PNG, symlink, secret canaries and incomplete success claims', async () => {
  const { root, manifest } = await complete(); const first = join(root, manifest.screenshots[0].path), bytes = await readFile(first);
  await rm(first); expect((await validate(root, manifest)).errors.join()).toMatch(/screenshot file/);
  await writeFile(first, 'not a PNG'); expect((await validate(root, manifest)).status).toBe('partial');
  await writeFile(first, bytes); await writeFile(join(root, 'failure.log'), 'TOKEN_SECRET_CANARY');
  expect((await validate(root, manifest)).errors.join()).toMatch(/canary/);
  await rm(join(root, 'failure.log')); await symlink(first, join(root, 'outside.png')); expect((await validate(root, manifest)).errors.join()).toMatch(/symlink/);
});
it('native evidence preserves all platform slots and never applies or waives the browser matrix', async () => {
  const { root, manifest } = await complete('native');
  expect(manifest.screenshots).toHaveLength(24); expect(await validate(root, manifest)).toEqual({ status: 'pass', errors: [] });
  for (const mutate of [
    (m: any) => { m.targets.pop(); }, (m: any) => { m.targets[1].status = 'not_run'; m.targets[1].osVersion = 'unknown'; m.targets[1].missingInput = 'No compatible iOS simulator access or owner approval'; m.status = 'partial'; },
    (m: any) => { m.targets[0].status = 'fail'; }, (m: any) => { m.screenshots.pop(); }, (m: any) => { m.screenshots[0].viewport = { width: 375, height: 667 }; },
    (m: any) => { m.targets[0].osVersion = 'unknown'; }, (m: any) => { m.screenshots[0].targetId = 'invented'; },
  ]) { const changed = structuredClone(manifest); mutate(changed); expect((await validate(root, changed)).status).toBe('partial'); }
});


it('listing reporter never overwrites existing evidence even when output is supplied', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbi-list-unit-')); roots.push(root);
  await writeFile(join(root, 'manifest.json'), 'existing evidence');
  await writeFile(join(root, 'cleanup.json'), '{"status":"pass"}');
  vi.stubEnv('PASEO_E2E_OUTPUT', root);
  try {
    const reporter = new EvidenceReporter(); reporter.onBegin();
    await reporter.onError({ message: 'Owner approval required' });
    await reporter.onEnd({ status: 'failed' });
    expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe('existing evidence');
    await expect(readFile(join(root, 'test-failure.log'))).rejects.toThrow();
  } finally { vi.unstubAllEnvs(); }
});

it('reporter retains its owned output after teardown deletes the lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbi-reporter-unit-')); roots.push(root);
  const lease = join(root, 'lease.json');
  await writeFile(lease, JSON.stringify({ root: '/owned-runtime', input: { output: root } }));
  await writeFile(join(root, 'cleanup.json'), '{"status":"pass"}');
  vi.stubEnv('PASEO_E2E_OUTPUT', root); vi.stubEnv('PASEO_E2E_LEASE', lease);
  try {
    const reporter = new EvidenceReporter(); reporter.onBegin();
    await rm(lease);
    await reporter.onError({ message: 'Owned process /owned-runtime failed' });
    await reporter.onEnd({ status: 'failed' });
    expect(await readFile(join(root, 'test-failure.log'), 'utf8')).toBe('Owned process [OWNED] failed');
    expect(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))).toMatchObject({ status: 'partial', executionStatus: 'failed', cleanup: { status: 'pass' } });
  } finally { vi.unstubAllEnvs(); }
});

it('generated browser telemetry reaches all real adapters with successful/empty/partial/unavailable data and real pagination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbi-adapters-unit-')); roots.push(root);
  for (const profile of ['release', 'installed'] as const) {
    const f = await prepareTelemetry(root, 'host-a', profile);
    const repository = await ConfigRepository.load(f.data.authorization);
    const ports = new ReadPorts(repository);
    const processPort = vi.spyOn(ports, 'process').mockImplementation(async (_id, op) => {
      let name: string, args: string[];
      if (op.kind === 'systemctl-show') {
        name = 'systemctl'; args = ['--user', 'show', `orbi-demo@${op.slot}.${op.unit}`, '--property=Id,LoadState,ActiveState,SubState,UnitFileState,Result,ExecMainCode,ExecMainStatus,NRestarts,LastTriggerUSec,NextElapseUSecRealtime,NextElapseUSecMonotonic', '--no-pager'];
      } else if (op.kind === 'journalctl') {
        name = 'journalctl'; args = ['--user', '-u', `orbi-demo@${op.slot}.service`, '--no-pager', '--since', '-1 hour', '-n', '200', '-o', 'json'];
      } else {
        const endpoint = op.resource === 'issues' ? `issues?state=${op.state}&sort=updated&direction=desc&per_page=100&page=${op.page}`
          : op.resource === 'comments' ? `issues/${op.issue}/comments?per_page=100&page=${op.page}`
          : op.resource === 'dependencies' ? `issues/${op.issue}/dependencies/blocked_by?per_page=100&page=${op.page}`
          : op.resource === 'issue' ? `issues/${op.issue}` : op.resource === 'pull' ? `pulls/${op.pr}` : op.resource === 'checks' ? `commits/${op.sha}/check-runs?per_page=100&page=${op.page}` : '';
        name = 'gh'; args = ['api', '--hostname', 'github.com', '--method', 'GET', '--include', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', `repos/Example/project/${endpoint}`];
      }
      const result = operation(name, args, JSON.parse(await readFile(f.state, 'utf8')));
      expect(result.allowed).toBe(true);
      if (result.code && !result.body.startsWith('HTTP/')) throw new Error('fixture unavailable');
      return result.body;
    });
    try {
      for (const scenario of ['available', 'empty', 'partial', 'unavailable']) {
        await f.setState(scenario);
        // Fresh adapters, like the scenario's plugin reload: no borrowed success cache.
        const github = new GitHubReader(repository, ports), runs = new RunsReader(repository, ports, github), blockers = new BlockersReader(repository, github, ports);
        const fleet = await readFleet(repository, ports, { deploymentId: 'demo' });
        const issues = scenario === 'partial' ? await github.getIssue('demo', 42) : await github.listIssues('demo', 1);
        const runList = await runs.list({ deploymentId: 'demo' }), blockerList = await blockers.list({ deploymentId: 'demo', page: 1 });
        const expected = scenario === 'empty' ? 'available' : scenario;
        for (const observation of [fleet, issues, runList, blockerList]) expect(observation.state, `${profile}/${scenario}`).toBe(expected);
        if (scenario === 'available') {
          expect(fleet.data?.health?.recentRuns).toHaveLength(1);
          expect((await github.listIssues('demo', 1)).data?.hasNextPage).toBe(true);
          expect((await github.listIssues('demo', 2)).data?.records[0].number).toBe(142);
          expect((await github.getIssue('demo', 142)).data?.issue.number).toBe(142);
          expect(runList.data?.map(r => [r.issue, r.runId])).toEqual([[42, '84360d31']]);
          const detail = await runs.read({ deploymentId: 'demo', issue: 42, runId: '84360d31' });
          expect(detail.problems).toEqual([{ source: 'journal', code: 'incomplete' }]);
          expect(detail.state).toBe('partial'); expect(detail.data?.events).toHaveLength(1);
          expect(blockerList.data?.records[0].issue.number).toBe(43);
          expect((await blockers.read({ deploymentId: 'demo', issue: 43 })).state).toBe('available');
        }
        if (scenario === 'empty') {
          expect(fleet.data?.health?.recentRuns).toEqual([]);
          expect(runList.data).toEqual([]); expect(blockerList.data?.records).toEqual([]);
        }
      }
    } finally { processPort.mockRestore(); ports.dispose(); }
  }
});

// Synthetic programs only: exercise the real pre-entry boundary, not a prefilled ledger.
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import fsPromises, { mkdir, chmod, readdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createRegistration, type ProcessSpec, identity, ownedProcesses, managementArgs, psArguments, registrationRuntime, release, lease, makeHost, type Host } from './e2e/harness';
const execFileAsync = promisify(execFileCallback);
const fixtures = fileURLToPath(new URL('./e2e/fixtures/', import.meta.url));
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function registrationFixture(esm = false, startupMs = 10000) {
  const root = await mkdtemp(join(tmpdir(), 'orbi-registration-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home);
  const worker = join(root, esm ? 'terminal-worker.mjs' : 'application.cjs');
  await writeFile(worker, esm ? `import ${JSON.stringify(join(fixtures, 'process-registration-worker.cjs'))};` : await readFile(join(fixtures, 'process-registration-worker.cjs')));
  const launcher = join(fixtures, 'process-registration-launcher.cjs');
  const env = { ...environment(root, root, home), ORBI_TEST_WORKER: worker, ORBI_TEST_MARKER: join(root, 'entered') };
  const specs: ProcessSpec[] = [
    { role: 'root', entry: worker, digest: digest(await readFile(worker)), args: [] },
  ];
  const registration = await createRegistration({ root, home, directory: join(root, 'registration'), env, specs, startupDeadline: performance.now() + startupMs, esbuild: join(root, 'generated-esbuild') });
  return { root, home, env, specs, registration, worker, launcher };
}
async function independentStop(children: { pid?: number; captured: Identity | null }[]) {
  // Captured directly from synthetic spawn / fixture PID pipe, independent of admission ledger.
  for (const child of children) if (child.pid) {
    const p = await identity(child.pid);
    if (p && child.captured && p.start === child.captured.start && p.pgid === child.captured.pgid && p.pgid === child.pid && p.pgid !== (await identity(process.pid))?.pgid) {
      try { process.kill(-p.pgid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  await boundedWait(async () => !(await Promise.all(children.map(c => c.pid ? identity(c.pid) : null))).some(Boolean), 2000);
}
it.each([{ esm: false, threadPreload: false }, { esm: false, threadPreload: true }, { esm: true, threadPreload: false }, { esm: true, threadPreload: true }])('preload gates CJS/ESM application and import hooks before ack; threads never register ($esm / $threadPreload)', async ({ esm, threadPreload }) => {
  const f = await registrationFixture(esm), children: { pid?: number; captured: Identity | null }[] = [];
  const hook = join(f.root, 'hook.mjs'); await writeFile(hook, `import {appendFileSync} from 'node:fs'; appendFileSync(process.env.ORBI_TEST_MARKER,'import\\n');`);
  // Exact execArgv is part of independent spawn provenance, including the ordering hook.
  f.specs[0].nodeArgs = ['--import', hook];
  Object.assign(f.registration.env, { ORBI_TEST_THREAD_PRELOAD: threadPreload ? '1' : '0', ORBI_TEST_PRELOAD: f.registration.preload, ORBI_TEST_THREAD_RESULT: join(f.root, 'thread-result') });
  await f.registration.configure(f.specs);
  const child = spawn(process.execPath, ['--import', hook, f.worker], { env: f.registration.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); children.push({ pid: child.pid, captured: child.pid ? await identity(child.pid) : null });
  try {
    await f.registration.captureRoot(child);
    await boundedWait(async () => (await readdir(f.registration.directory)).some(n => /^slot-/.test(n)), 1000);
    await expect(readFile(f.env.ORBI_TEST_MARKER!, 'utf8')).rejects.toThrow();
    await f.registration.collect();
    await boundedWait(async () => { try { return (await readFile(f.env.ORBI_TEST_MARKER!, 'utf8')).includes('thread') && !!(await readFile(join(f.root, 'thread-result'), 'utf8')); } catch { return false; } }, 2000);
    await f.registration.collect();
    expect(await readFile(f.env.ORBI_TEST_MARKER!, 'utf8')).toBe('import\napplication\nthread\n');
    expect(f.registration.ledger).toHaveLength(1);
    expect(await readFile(join(f.root, 'thread-result'), 'utf8')).toBe(join(f.root, 'generated-esbuild'));
  } finally { await independentStop(children); await f.registration.close(); }
});
it('native exec gates preserve PID/start/PGID and standard stdin/stdout without spawning', async () => {
  const f = await registrationFixture(), children: { pid?: number; captured: Identity | null }[] = [];
  const target = join(f.root, 'synthetic-native');
  await execFileAsync('/usr/bin/cc', [join(fixtures, 'process-registration-native.c'), '-o', target], { timeout: 10000 });
  const gate = join(f.root, 'esbuild');
  await writeFile(gate, `#!${process.execPath}\nrequire(${JSON.stringify(join(fixtures, 'native-exec-gate.cjs'))});\n`); await chmod(gate, 0o700);
  f.specs[0] = { role: 'root', entry: gate, digest: digest(await readFile(gate)), args: ['--service=0.25.12', '--ping'], native: { target, digest: digest(await readFile(target)) } };
  await f.registration.configure(f.specs);
  const child = spawn(process.execPath, [gate, '--service=0.25.12', '--ping'], { env: f.registration.env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }); children.push({ pid: child.pid, captured: child.pid ? await identity(child.pid) : null });
  let stdout = '', stderr = ''; child.stdout!.on('data', data => { stdout += String(data); }); child.stderr!.on('data', data => { stderr += String(data); });
  try {
    const initial = await f.registration.captureRoot(child);
    f.registration.service();
    await boundedWait(async () => { await f.registration.collect(); return (await readdir(f.registration.directory)).some(n => /^slot-/.test(n)); }, 2000);
    child.stdin!.write('identity-and-stdio\n');
    await boundedWait(async () => stdout.includes('identity-and-stdio'), 2000);
    expect(await identity(child.pid!)).toEqual(initial);
    expect(stdout).toBe('identity-and-stdio\n');
    expect(stderr).toContain('native-stderr');
    await f.registration.verify();
    await f.registration.close();
    // Model execve occurring between readlink(exe) and stat(exe): the first
    // observation names Node, the next metadata read already names the target.
    f.registration.ledger[0].nativeObserved = false;
    const originalReadlink = fsPromises.readlink;
    const observation = vi.spyOn(fsPromises, 'readlink').mockImplementationOnce((async () => process.execPath) as typeof originalReadlink);
    syncBuiltinESMExports();
    try {
      await expect(f.registration.verify()).resolves.toBeUndefined();
      expect(f.registration.ledger[0].nativeObserved).toBe(true);
    } finally { observation.mockRestore(); syncBuiltinESMExports(); }
  } finally { await independentStop(children); await f.registration.close(); }
});

it('captures detached worker before launcher exits, retains history across reparenting, and escalates cleanup from the captured ledger', async () => {
  const f = await registrationFixture(), children: { pid?: number; captured: Identity | null }[] = [];
  const childFile = join(f.root, 'child');
  Object.assign(f.registration.env, { ORBI_TEST_CHILD: childFile, ORBI_TEST_RESIST: '1', ORBI_TEST_THREAD_PRELOAD: '1', ORBI_TEST_PRELOAD: f.registration.preload });
  const launcherDigest = digest(await readFile(f.launcher));
  const specs: ProcessSpec[] = ['root', 'supervisor', 'daemon', 'terminal-launcher'].map(role => ({ role: role as ProcessSpec['role'], entry: f.launcher, digest: launcherDigest, args: [role] }));
  specs.push({ role: 'terminal-worker', entry: f.worker, digest: digest(await readFile(f.worker)), args: [] });
  await f.registration.configure(specs);
  const child = spawn(process.execPath, [f.launcher, 'root'], { env: f.registration.env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] }); children.push({ pid: child.pid, captured: child.pid ? await identity(child.pid) : null });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  try {
    await f.registration.captureRoot(child); f.registration.service();
    await boundedWait(async () => { try { const pid = Number(await readFile(childFile, 'utf8')); if (!children.some(c => c.pid === pid)) children.push({ pid, captured: await identity(pid) }); } catch { /* not spawned yet */ } await f.registration.collect(); return f.registration.ledger.length === 5; }, 4000);
    const worker = f.registration.ledger.find(c => c.spec.role === 'terminal-worker')!;
    expect(worker.identity.ppid).not.toBe(1); expect(worker.identity.pgid).toBe(worker.identity.pid);
    await boundedWait(async () => !(await identity(child.pid!)), 2000);
    expect((await identity(worker.identity.pid))?.ppid).not.toBe(worker.identity.ppid);
    expect(stderr).not.toContain('refused');
    await f.registration.running();
    const deadline = Number(process.hrtime.bigint()) / 1e6 + 4000;
    await f.registration.shutdown(deadline);
    const signals: string[] = [];
    await stopOwned([], {
      table: async () => (await Promise.all(f.registration.ledger.map(c => identity(c.identity.pid)))).filter((p): p is Identity => !!p),
      reconcile: async () => { await f.registration.collect(); return f.registration.ledger.map(c => c.identity); },
      validate: group => f.registration.verify(group), deadline,
      signal: (pgid, signal) => { signals.push(signal); process.kill(-pgid, signal); }, sleep: ms => new Promise(ok => setTimeout(ok, ms)),
    });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']); expect(await identity(worker.identity.pid)).toBeNull();
    expect(f.registration.ledger).toHaveLength(5); // no record recycling
  } finally {
    try { const pid = Number(await readFile(childFile, 'utf8')); if (!children.some(c => c.pid === pid)) children.push({ pid, captured: await identity(pid) }); } catch { /* no child */ }
    await independentStop(children); await f.registration.close();
  }
}, 10000);

it('closed ps parent/argv table, candidate-only management boundary and runtime prerequisite refuse every other role/form', () => {
  const one = ['-ww', '-p', '123', '-o', 'lstart=', '-o', 'command='];
  const table = ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'sid=', '-o', 'lstart='];
  for (const role of ['root', 'supervisor', 'daemon', 'plugin', 'terminal-launcher', 'terminal-worker', 'fixture', 'npm']) {
    expect(psArguments(role, one)).toBe(['daemon', 'terminal-worker'].includes(role));
    expect(psArguments(role, table)).toBe(role === 'terminal-worker');
    for (const args of [[], [...one, '--forest'], one.map(a => a === '123' ? '-1' : a), table.filter(a => a !== 'sid=')]) expect(psArguments(role, args)).toBe(false);
  }
  for (const args of [['ls', '--json'], ['ls', 'paseo-orbi', '--json'], ['install', '/owned/candidate', '--id', 'paseo-orbi'], ...['remove', 'reload', 'enable', 'disable'].map(op => [op, 'paseo-orbi'])]) expect(managementArgs(args, '/owned/candidate')).toEqual(args);
  for (const args of [['install', '@x/y', '--id', 'paseo-orbi'], ['install', '/owned/candidate/../candidate', '--id', 'paseo-orbi'], ['install', '/owned/candidate', '--id', 'paseo-orbi', '--path', '.'], ['install', '/owned/candidate', '--id', 'paseo-orbi', '--ref', 'main'], ['update', 'paseo-orbi'], ['remove', 'other'], ['ls'], ['ls', '--json', '--host', 'elsewhere']]) expect(() => managementArgs(args, '/owned/candidate')).toThrow(/refused/);
  expect(() => registrationRuntime('v24.0.0')).toThrow(/22.19.0/);
  expect(() => registrationRuntime('v22.19.0', 'linux', undefined)).not.toThrow(); // default uses actual supported API
  expect(() => registrationRuntime('v22.19.0', 'linux', null)).toThrow(/execve/);
});

it.each(['denial', 'timeout', 'nonce', 'digest', 'dead-collector', 'wrong-home', 'wrong-content', 'wrong-role', 'npm'])('pre-entry failure %s never runs application code', async mode => {
  const f = await registrationFixture(), children: { pid?: number; captured: Identity | null }[] = [];
  const env = { ...f.registration.env };
  if (mode === 'wrong-home') env.PASEO_HOME = '/wrong';
  if (mode === 'wrong-content') await writeFile(f.worker, '// changed\n' + await readFile(f.worker, 'utf8'));
  if (mode === 'wrong-role') { f.specs[0].role = 'plugin'; await f.registration.configure(f.specs); }
  if (mode === 'npm') { env.ORBI_TEST_WORKER = '/npm'; f.specs[0].entry += '-npm'; await f.registration.configure(f.specs); }
  if (mode === 'dead-collector') {
    const config = JSON.parse(await readFile(join(f.registration.directory, 'config.json'), 'utf8'));
    config.collector.start = 'reused'; await chmod(join(f.registration.directory, 'config.json'), 0o600); await writeFile(join(f.registration.directory, 'config.json'), JSON.stringify(config));
  }
  const child = spawn(process.execPath, [f.worker], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] }); children.push({ pid: child.pid, captured: child.pid ? await identity(child.pid) : null });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const exited = once(child, 'exit');
  try {
    if (!['wrong-home', 'wrong-content', 'wrong-role', 'npm', 'dead-collector'].includes(mode)) await f.registration.captureRoot(child);
    if (['denial', 'nonce', 'digest'].includes(mode)) {
      let slot = '';
      await boundedWait(async () => { slot = (await readdir(f.registration.directory)).find(n => /^slot-/.test(n)) ?? ''; return !!slot && await readFile(join(f.registration.directory, slot, 'request')).then(() => true, () => false); }, 2000);
      if (mode === 'denial') await writeFile(join(f.registration.directory, 'failure'), 'deliberate admission denial');
      else {
        const bytes = await readFile(join(f.registration.directory, slot, 'request'), 'utf8'), request = JSON.parse(bytes);
        await writeFile(join(f.registration.directory, slot, 'ack'), JSON.stringify({ session: request.session, identity: request.identity, nonce: mode === 'nonce' ? 'wrong' : request.nonce, digest: mode === 'digest' ? 'wrong' : digest(bytes) }));
      }
    } else if (mode === 'wrong-home') await expect(f.registration.captureRoot(child)).rejects.toThrow(/invariant/);
    // A failed capture never grants a lease; the synthetic finally cleanup is independent.
    if (['wrong-home', 'wrong-role'].includes(mode)) await f.registration.shutdown(Number(process.hrtime.bigint()) / 1e6 + 50);
    if (mode === 'timeout') await f.registration.shutdown(Number(process.hrtime.bigint()) / 1e6 + 100);
    await boundedWait(async () => child.exitCode !== null, mode === 'timeout' ? 1000 : 6000);
    await exited;
    expect(stderr).toMatch(/Process registration refused/);
    await expect(readFile(f.env.ORBI_TEST_MARKER!, 'utf8')).rejects.toThrow();
  } finally { await independentStop(children); await f.registration.close(); }
}, 9000);

it.each(['malformed', 'partial', 'oversized', 'marker-only', 'parent-reused', 'forged-root', 'wrong-edge', 'conflict', 'missing-history', 'overflow'])('collector rejects %s records as sticky failures without retrospective enrollment', async mode => {
  const f = await registrationFixture(), children: { pid?: number; captured: Identity | null }[] = [];
  const child = spawn(process.execPath, [f.worker], { env: f.registration.env, detached: true, stdio: 'ignore' });
  children.push({ pid: child.pid, captured: child.pid ? await identity(child.pid) : null });
  try {
    await f.registration.captureRoot(child);
    let slot = '';
    await boundedWait(async () => { slot = (await readdir(f.registration.directory)).find(n => /^slot-/.test(n)) ?? ''; return !!slot && await readFile(join(f.registration.directory, slot, 'request')).then(() => true, () => false); }, 2000);
    const requestPath = join(f.registration.directory, slot, 'request'), bytes = await readFile(requestPath, 'utf8'), request = JSON.parse(bytes);
    if (mode === 'malformed') await writeFile(requestPath, '{');
    if (mode === 'partial') { await rm(requestPath); await writeFile(requestPath + '.tmp', '{'); await f.registration.shutdown(Number(process.hrtime.bigint()) / 1e6 - 1); }
    if (mode === 'oversized') await writeFile(requestPath, 'x'.repeat(4097));
    if (mode === 'marker-only') await writeFile(requestPath, JSON.stringify(request.identity));
    if (mode === 'parent-reused') { request.parent.start = 'reused'; await writeFile(requestPath, JSON.stringify(request)); }
    if (mode === 'forged-root') { request.identity = await identity(process.pid); request.parent = await identity(process.ppid); await writeFile(requestPath, JSON.stringify(request)); }
    if (mode === 'wrong-edge') { request.role = 'terminal-worker'; await writeFile(requestPath, JSON.stringify(request)); }
    if (mode === 'conflict' || mode === 'missing-history') {
      await f.registration.collect();
      if (mode === 'conflict') { request.nonce = 'f'.repeat(32); await writeFile(requestPath, JSON.stringify(request)); }
      else await rm(join(f.registration.directory, slot), { recursive: true });
    }
    if (mode === 'overflow') await mkdir(join(f.registration.directory, 'slot-256'));
    await expect(f.registration.collect()).rejects.toThrow();
    await expect(f.registration.collect()).rejects.toThrow();
    expect(f.registration.errors).toHaveLength(1);
    expect(f.registration.ledger).toHaveLength(1); // only independently captured actual spawn
    if (!['conflict', 'missing-history'].includes(mode)) await expect(readFile(f.env.ORBI_TEST_MARKER!, 'utf8')).rejects.toThrow();
  } finally { await independentStop(children); await f.registration.close(); }
});

it('five-second missing collector-service deadline is fixed and prevents entry', async () => {
  const f = await registrationFixture(), children: { pid?: number; captured: Identity | null }[] = [];
  const child = spawn(process.execPath, [f.worker], { env: f.registration.env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push({ pid: child.pid, captured: child.pid ? await identity(child.pid) : null });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const start = performance.now();
  try {
    await f.registration.captureRoot(child);
    await boundedWait(async () => child.exitCode !== null, 6000);
    expect(performance.now() - start).toBeLessThan(6000);
    expect(stderr).toMatch(/five-second\/phase admission deadline/);
    await expect(readFile(f.env.ORBI_TEST_MARKER!, 'utf8')).rejects.toThrow();
  } finally { await independentStop(children); await f.registration.close(); }
}, 8000);

it('a dead launcher before admission cannot be recovered from worker JSON or markers', async () => {
  const f = await registrationFixture(), children: { pid?: number; captured: Identity | null }[] = [];
  const childFile = join(f.root, 'child');
  Object.assign(f.registration.env, { ORBI_TEST_CHILD: childFile, ORBI_TEST_PARENT_EARLY_EXIT: '1' });
  const d = digest(await readFile(f.launcher));
  const specs: ProcessSpec[] = ['root', 'supervisor', 'daemon', 'terminal-launcher'].map(role => ({ role: role as ProcessSpec['role'], entry: f.launcher, digest: d, args: [role] }));
  specs.push({ role: 'terminal-worker', entry: f.worker, digest: digest(await readFile(f.worker)), args: [] });
  await f.registration.configure(specs);
  const child = spawn(process.execPath, [f.launcher, 'root'], { env: f.registration.env, detached: true, stdio: 'ignore' });
  children.push({ pid: child.pid, captured: child.pid ? await identity(child.pid) : null });
  try {
    await f.registration.captureRoot(child);
    await boundedWait(async () => {
      try { const pid = Number(await readFile(childFile, 'utf8')); if (!children.some(c => c.pid === pid)) children.push({ pid, captured: await identity(pid) }); } catch { /* not launched */ }
      try { await f.registration.collect(); } catch { return true; }
      return false;
    }, 3000);
    expect(f.registration.errors.join()).toMatch(/ancestry|role edge/);
    expect(f.registration.ledger.some(c => c.spec.role === 'terminal-worker')).toBe(false);
    await expect(readFile(f.env.ORBI_TEST_MARKER!, 'utf8')).rejects.toThrow();
  } finally {
    try { const pid = Number(await readFile(childFile, 'utf8')); if (!children.some(c => c.pid === pid)) children.push({ pid, captured: await identity(pid) }); } catch { /* no child */ }
    await independentStop(children); await f.registration.close();
  }
});

it('actual harness PGID is refused and accounting errors do not authorize signaling an unsafe group or extend the fixed budget', async () => {
  const self = (await identity(process.pid))!, signal = vi.fn();
  await expect(stopOwned([self], { table: async () => [self], signal, sleep: async () => {} })).rejects.toThrow(/Unsafe process group/);
  expect(signal).not.toHaveBeenCalled();
  const p = { pid: 1001, ppid: 1, pgid: 1001, start: '10' };
  let clock = 0, calls = 0;
  await expect(stopOwned([], { table: async () => [p], reconcile: async () => { calls++; clock += 10; return [p]; }, signal, sleep: async ms => { clock += ms; }, deadline: 20, now: () => clock })).rejects.toThrow(/deadline|survived/);
  expect(signal).not.toHaveBeenCalled(); expect(calls).toBeLessThan(10);
});

it('producer capacity is bounded to 256 immutable slots and exhaustion prevents application entry', async () => {
  const f = await registrationFixture(), children: { pid?: number; captured: Identity | null }[] = [];
  for (let i = 0; i < 256; i++) await mkdir(join(f.registration.directory, `slot-${i}`));
  const child = spawn(process.execPath, [f.worker], { env: f.registration.env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push({ pid: child.pid, captured: child.pid ? await identity(child.pid) : null });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  try {
    await boundedWait(async () => child.exitCode !== null, 2000);
    expect(stderr).toMatch(/capacity exhausted/);
    expect((await readdir(f.registration.directory)).filter(n => /^slot-/.test(n))).toHaveLength(256);
    await expect(readFile(f.env.ORBI_TEST_MARKER!, 'utf8')).rejects.toThrow();
    await expect(f.registration.collect()).rejects.toThrow(/capacity/);
  } finally { await independentStop(children); await f.registration.close(); }
});

it.each([false, true])('shared release deletes evidence/runtime only after complete accounting (corrupt=%s)', async corrupt => {
  const f = await registrationFixture(), children: { pid?: number; captured: Identity | null }[] = [];
  const output = await mkdtemp(join(tmpdir(), 'orbi-cleanup-report-')); roots.push(output);
  const registry = join(f.root, 'reads'); await writeFile(registry, '');
  const child = spawn(process.execPath, [f.worker], { env: f.registration.env, detached: true, stdio: 'ignore' });
  children.push({ pid: child.pid, captured: child.pid ? await identity(child.pid) : null });
  const port = await (await import('./e2e/harness')).reservePort(); await port.release();
  const dataCleanup = vi.fn(async () => {});
  const host = { alias: 'host-a', host: `tcp://127.0.0.1:${port.port}`, home: f.home, port: port.port, initial: await f.registration.captureRoot(child),
    startup: { deadline: Infinity }, shutdown: { deadline: Infinity }, registration: f.registration, env: f.env, registry, installation: 'never-attempted', cliCall: vi.fn(),
    log: () => 'synthetic host log', data: { cleanup: dataCleanup }, child, daemonEnv: f.registration.env } as unknown as Host;
  try {
    f.registration.service();
    await boundedWait(async () => { await f.registration.collect(); try { return !!(await readFile(f.env.ORBI_TEST_MARKER!)); } catch { return false; } }, 2000);
    const serialized = lease({ root: f.root, input: { repo: '/candidate', sha: 'a'.repeat(40), output, approval: approved.PASEO_E2E_APPROVAL_URL }, hosts: [host] });
    expect(serialized.hosts[0].env.NODE_OPTIONS).toBeUndefined(); expect(serialized.hosts[0].env.ORBI_PROCESS_CONFIG).toBeUndefined();
    expect(JSON.stringify(serialized)).not.toContain('--require=');
    if (corrupt) {
      const slot = (await readdir(f.registration.directory)).find(n => /^slot-/.test(n))!;
      await writeFile(join(f.registration.directory, slot, 'request'), 'corrupt');
      await expect(release({ output, repo: '/candidate' }, f.root, [host])).rejects.toThrow(/runtime trees retained/);
      expect((await readFile(join(output, 'cleanup.json'), 'utf8'))).toMatch(/Conflicting|registration/);
      expect(await readdir(f.root)).toContain('registration');
      expect(dataCleanup).not.toHaveBeenCalled();
    } else {
      expect((await release({ output, repo: '/candidate' }, f.root, [host])).status).toBe('pass');
      await expect(readdir(f.root)).rejects.toThrow(); expect(dataCleanup).toHaveBeenCalledOnce();
    }
    expect(await identity(child.pid!)).toBeNull();
    expect(host.cliCall).not.toHaveBeenCalled();
  } finally { await independentStop(children); await f.registration.close(); }
}, 10000);

it('partial host is retained before initialization can fail, without any PID-only lease or daemon preload in management env', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orbi-partial-host-')); roots.push(root);
  const candidate = join(root, 'candidate'); await mkdir(candidate);
  const hosts: Host[] = [];
  await expect(makeHost(root, 'host-a', 'release', candidate, join(root, 'missing-cli'), 'available', hosts)).rejects.toThrow();
  expect(hosts).toHaveLength(1);
  expect(hosts[0].child).toBeNull(); expect(hosts[0].initial).toBeNull(); expect(hosts[0].installation).toBe('never-attempted');
  expect(hosts[0].env.NODE_OPTIONS).toBeUndefined();
  expect(await readdir(join(root, 'host-a-bin'))).not.toContain('npm');
  const output = await mkdtemp(join(tmpdir(), 'orbi-partial-report-')); roots.push(output);
  expect((await release({ output, repo: '/candidate' }, root, hosts)).status).toBe('pass');
  const f = await registrationFixture();
  await expect(f.registration.captureRoot({ pid: 2147483647 } as never)).rejects.toThrow(/no PID-only signaling/);
  expect(f.registration.ledger).toHaveLength(0); await f.registration.close();
});

it('worker JSON, nonempty terminal lists and legacy marker-only fixture records only discover/refuse; they never enroll', async () => {
  const f = await registrationFixture();
  const registry = join(f.root, 'reads'); await writeFile(registry, JSON.stringify(await identity(process.pid)));
  const host = { home: f.home, registry, registration: f.registration } as Host;
  await expect(ownedProcesses([host], f.root)).rejects.toThrow(/marker-only/);
  expect(f.registration.ledger).toHaveLength(0);
  await writeFile(registry, ''); await mkdir(join(f.home, 'terminal-worker'));
  const path = join(f.home, 'terminal-worker', 'test.json');
  await writeFile(path, JSON.stringify({ pid: process.pid, secret: 'worker-secret-must-not-be-logged', terminals: [] }));
  await expect(ownedProcesses([host], f.root)).rejects.toThrow(/no retrospective enrollment/);
  await writeFile(path, JSON.stringify({ terminals: [{ pid: process.pid }] }));
  await expect(ownedProcesses([host], f.root)).rejects.toThrow(/terminal programs/);
  await writeFile(path, 'worker-secret-must-not-be-logged');
  await expect(ownedProcesses([host], f.root)).rejects.toThrow('Malformed/oversized upstream worker discovery record (contents withheld)');
  await f.registration.close();
});

it('contending plugin publishers get distinct immutable slots and retain in-place Node IPC with execArgv empty', async () => {
  const f = await registrationFixture(), children: { pid?: number; captured: Identity | null }[] = [];
  const childFile = join(f.root, 'children');
  Object.assign(f.registration.env, { ORBI_TEST_CHILD: childFile, ORBI_TEST_FANOUT: '8' });
  const specs: ProcessSpec[] = ['root', 'supervisor', 'daemon'].map(role => ({ role: role as ProcessSpec['role'], entry: f.launcher, digest: '', args: [role] }));
  for (const spec of specs) spec.digest = digest(await readFile(f.launcher));
  specs.push({ role: 'plugin', entry: f.worker, digest: digest(await readFile(f.worker)), args: [] });
  await f.registration.configure(specs);
  const child = spawn(process.execPath, [f.launcher, 'root'], { env: f.registration.env, detached: true, stdio: 'ignore' });
  children.push({ pid: child.pid, captured: child.pid ? await identity(child.pid) : null });
  const discover = async () => { try { for (const pid of JSON.parse(await readFile(childFile, 'utf8'))) if (!children.some(c => c.pid === pid)) children.push({ pid, captured: await identity(pid) }); } catch { /* not yet written */ } };
  try {
    await f.registration.captureRoot(child); f.registration.service();
    await boundedWait(async () => { await discover(); await f.registration.collect(); return f.registration.ledger.length === 11; }, 4000);
    await boundedWait(async () => !(await identity(child.pid!)), 2000);
    expect((await readdir(f.registration.directory)).filter(n => /^slot-/.test(n))).toHaveLength(11);
    expect(f.registration.ledger.filter(c => c.spec.role === 'plugin')).toHaveLength(8);
    expect(f.registration.errors).toEqual([]);
  } finally { await discover(); await independentStop(children); await f.registration.close(); }
}, 8000);

it('actual collector death prevents application entry even with a fresh immutable request', async () => {
  const f = await registrationFixture(), children: { pid?: number; captured: Identity | null }[] = [];
  const childFile = join(f.root, 'dead-collector-child'), errorFile = join(f.root, 'dead-collector-error');
  const collector = spawn(process.execPath, [f.launcher, 'collector-exit'], { detached: true, stdio: 'ignore', env: { ...f.env, ORBI_TEST_PROCESS_CONFIG: f.registration.env.ORBI_PROCESS_CONFIG, ORBI_TEST_CHILD: childFile, ORBI_TEST_ERROR: errorFile } });
  children.push({ pid: collector.pid, captured: collector.pid ? await identity(collector.pid) : null });
  try {
    await boundedWait(async () => { try { const pid = Number(await readFile(childFile, 'utf8')); if (!children.some(c => c.pid === pid)) children.push({ pid, captured: await identity(pid) }); return true; } catch { return false; } }, 2000);
    await boundedWait(async () => { try { return (await readFile(errorFile, 'utf8')).includes('Process registration refused'); } catch { return false; } }, 2000);
    expect(await identity(collector.pid!)).toBeNull();
    await expect(readFile(f.env.ORBI_TEST_MARKER!, 'utf8')).rejects.toThrow();
  } finally { await independentStop(children); await f.registration.close(); }
});

it('running admissions do not inherit an expired startup deadline, and shutdown never renews its fixed deadline', async () => {
  const f = await registrationFixture(false, -1), children: { pid?: number; captured: Identity | null }[] = [];
  const controlPath = join(f.registration.directory, 'control');
  // Transition is collector-owned, and is not a reset of any child admission timer.
  await f.registration.running();
  const child = spawn(process.execPath, [f.worker], { env: f.registration.env, detached: true, stdio: 'ignore' });
  children.push({ pid: child.pid, captured: child.pid ? await identity(child.pid) : null });
  try {
    await f.registration.captureRoot(child); f.registration.service();
    await boundedWait(async () => { await f.registration.collect(); try { return !!(await readFile(f.env.ORBI_TEST_MARKER!)); } catch { return false; } }, 2000);
    const fixed = Number(process.hrtime.bigint()) / 1e6 + 100;
    await f.registration.shutdown(fixed); await f.registration.shutdown(fixed + 10000);
    expect(JSON.parse(await readFile(controlPath, 'utf8')).deadline).toBe(fixed);
  } finally { await independentStop(children); await f.registration.close(); }
});

it('an observed forbidden executable remains an accounting failure even if the process exits during validation', async () => {
  const f = await registrationFixture(), children: { pid?: number; captured: Identity | null }[] = [];
  const child = spawn(process.execPath, [f.worker], { env: f.registration.env, detached: true, stdio: 'ignore' });
  children.push({ pid: child.pid, captured: child.pid ? await identity(child.pid) : null });
  let observation: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await f.registration.captureRoot(child);
    await boundedWait(async () => { await f.registration.collect(); try { return !!(await readFile(f.env.ORBI_TEST_MARKER!)); } catch { return false; } }, 2000);
    const original = fsPromises.readlink;
    observation = vi.spyOn(fsPromises, 'readlink').mockImplementation((async (...args: Parameters<typeof original>) => {
      if (args[0] === `/proc/${child.pid}/exe`) {
        // Deterministically model the kernel observation followed by exit, without
        // racing a real unapproved executable or granting it cleanup authority.
        await independentStop(children);
        return '/unapproved-executable';
      }
      return original(...args);
    }) as typeof original);
    syncBuiltinESMExports();
    await expect(f.registration.collect()).rejects.toThrow('Unapproved executable transition');
    await expect(f.registration.collect()).rejects.toThrow('Unapproved executable transition');
    expect(f.registration.errors).toHaveLength(1);
  } finally {
    observation?.mockRestore(); syncBuiltinESMExports();
    await independentStop(children); await f.registration.close();
  }
});
