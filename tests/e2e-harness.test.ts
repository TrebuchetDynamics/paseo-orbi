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
import { approveLaunch, isolation, environment, stopOwned, boundedWait, sanitize, checkFreshPath, requireListenerOwnership, start, prepareTelemetry, type Identity } from './e2e/harness';
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
