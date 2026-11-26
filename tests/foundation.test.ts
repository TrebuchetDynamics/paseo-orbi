import { afterEach, describe, it, expect, vi } from 'vitest';
import { writeFile, readFile, mkdir, symlink, chmod } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConfigRepository } from '../server/config';
import { ReadPorts, readBytes, boundedFile, FILE_LIMIT } from '../server/read-ports';
import { fingerprint, profiles } from '../server/compatibility';
import { deploymentsList, DeploymentCatalog, observationSchema } from '../shared/common';
import { servicesInventory } from '../shared/services';
import { z } from 'zod';
import contribute from '../index.server';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { fixture, type FixtureProfile } from './helpers/fixtures';
import { formatLocalTime } from '../client/time';

// Pass-through host filesystem spies record real opens/stats without replacing safety code.
vi.mock('node:fs/promises', { spy: true });
const cleanups: (() => unknown)[] = [];
async function setup(profile: FixtureProfile = 'release') { const f = await fixture(profile); cleanups.push(f.cleanup); return f; }
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function rpc(path?: string) {
  if (path === undefined) vi.stubEnv('PASEO_ORBI_CONFIG', undefined); else vi.stubEnv('PASEO_ORBI_CONFIG', path);
  let handler: (() => unknown) | undefined;
  const cleanup = contribute({ handle: (contract: unknown, callback: () => unknown) => { if (contract === deploymentsList) handler = callback; } } as unknown as PluginServerContext);
  cleanups.push(cleanup);
  const input = deploymentsList.input.parse({});
  expect(input).toEqual({});
  return DeploymentCatalog.parse(await handler!());
}

describe('config_and_compatibility', () => {
  it('rejects_unauthorized_deployment', async () => {
    const f = await setup();
    const repository = await ConfigRepository.load(f.authorization);
    const ports = new ReadPorts(repository); cleanups.push(() => ports.dispose());
    expect(() => repository.resolve('unauthorized')).toThrow('deployment_unavailable');
    await expect(ports.read('unauthorized', 'health')).rejects.toThrow('deployment_unavailable');
    await expect(ports.process('unauthorized', { kind: 'systemctl-show', slot: 1, unit: 'service' })).rejects.toThrow('deployment_unavailable');
  });
  it('unsupported_fingerprint_does_not_probe', async () => {
    const f = await setup();
    await writeFile(join(f.source, 'src/orbi/config.py'), 'changed SECRET_CANARY');
    await mkdir(join(f.repoDir, '.orbi')); // A telemetry symlink must never be followed, even at startup.
    await symlink('/does-not-exist/SECRET_CANARY', join(f.repoDir, '.orbi/health.json'));
    const opened = vi.spyOn(filesystem, 'open');
    const stats = vi.spyOn(filesystem, 'stat');
    opened.mockClear(); stats.mockClear();
    const repository = await ConfigRepository.load(f.authorization);
    expect(repository.catalog().entries[0].status).toBe('unsupported_source_profile');
    const allowed = new Set([f.authorization, f.configPath, ...profiles['orbi-0.7.41-release'].paths.map(path => join(f.source, path))]);
    for (const [path] of opened.mock.calls) expect(allowed.has(String(path))).toBe(true);
    expect(stats.mock.calls.map(([path]) => path)).toEqual([f.repoDir, f.deployHome, f.source]);
    const ports = new ReadPorts(repository); cleanups.push(() => ports.dispose());
    await expect(ports.read('demo', 'health')).rejects.toThrow('deployment_unavailable');
    expect(JSON.stringify(await rpc(f.authorization))).not.toMatch(/SECRET_CANARY|publisher-canary|configPath|engineSourcePath|repoDir|deployHome/);
  });
  it.each(['release', 'installed', 'v0748', 'v0765'] as const)('tracked %s pinned bytes reproduce approved fingerprint', async profile => {
    const f = await setup(profile);
    expect(await fingerprint(f.source, f.entry.adapter as keyof typeof profiles)).toBe(profiles[f.entry.adapter as keyof typeof profiles].fingerprint);
    expect((await rpc(f.authorization)).entries[0].status).toBe('available');
    const deployment = (await ConfigRepository.load(f.authorization)).resolve('demo');
    expect(deployment).toMatchObject({ capacity: 2, unitName: 'demo', sourceProfile: f.entry.adapter, repoDir: f.repoDir });
  });
  it('rejects any single changed v0.7.65 pinned file, including labels.toml', async () => {
    const f = await setup('v0765');
    for (const path of profiles['orbi-0.7.65-release'].paths) {
      const file = join(f.source, path), original = await readFile(file);
      await writeFile(file, '# changed pinned source\n');
      expect((await rpc(f.authorization)).entries[0], path).toMatchObject({ status: 'unsupported_source_profile', problems: [{ source: 'compatibility', code: 'unsupported_source_profile' }] });
      await writeFile(file, original);
    }
    expect((await rpc(f.authorization)).entries[0].status).toBe('available');
  }, 60000);
  it('deployments.list reports missing and global-invalid configuration without private fields', async () => {
    expect(await rpc()).toEqual({ state: 'unconfigured', entries: [], problems: [] });
    const f = await setup();
    for (const value of ['{SECRET_CANARY', 'null', '{"schema":2,"deployments":[]}']) {
      await writeFile(f.authorization, value);
      const catalog = await rpc(f.authorization);
      expect(catalog.state).toBe('invalid'); expect(catalog.entries).toEqual([]);
      expect(JSON.stringify(catalog)).not.toContain('SECRET_CANARY');
    }
    expect((await ConfigRepository.load('relative/path')).catalog().problems[0].code).toBe('unsafe_path');
  });
  it('duplicates, invalid identities and entry caps are global failures', async () => {
    const f = await setup();
    for (const entries of [
      [f.entry, { ...f.entry, repo: 'Other/repo' }],
      [f.entry, { ...f.entry, id: 'other', repo: 'example/PROJECT' }],
      [{ ...f.entry, id: '../secret' }], [{ ...f.entry, label: 'x'.repeat(81) }],
      [{ ...f.entry, label: 'line\nbreak' }], [{ ...f.entry, repo: 'https://github.com/owner/repo' }],
      Array.from({ length: 17 }, (_, i) => ({ ...f.entry, id: `d${i}`, repo: `Example/repo${i}` })),
    ]) {
      await f.save(entries); const catalog = await rpc(f.authorization);
      expect(catalog.state).toBe('invalid'); expect(catalog.entries).toEqual([]);
    }
  });
  it('mixed catalog retains safe identities; rejected entries cannot resolve', async () => {
    const f = await setup();
    await f.save([f.entry, { ...f.entry, id: 'other', repo: 'Other/repo', engineSourcePath: join(f.root, 'missing') }]);
    const catalog = await rpc(f.authorization);
    expect(catalog.entries.map(e => e.status)).toEqual(['available', 'invalid_config']);
    expect(Object.keys(catalog.entries[0]).sort()).toEqual(['adapter', 'controls', 'id', 'label', 'problems', 'repo', 'status']);
    expect(JSON.stringify(catalog)).not.toContain(f.root);
    const repository = await ConfigRepository.load(f.authorization);
    repository.catalog().entries[0].id = 'tampered';
    expect(repository.catalog().entries[0].id).toBe('demo');
    expect(repository.resolve('demo').id).toBe('demo');
    expect(() => repository.resolve('other')).toThrow('deployment_unavailable');
  });
  it.each([
    ['repo_dir', 'repo_dir = "/unauthorized"'], ['deploy_home', 'deploy_home = "/unauthorized"'],
    ['source_repos', 'source_repos = ["Other/repo"]'], ['max_concurrency', 'max_concurrency = 6'],
    ['unit_name', 'unit_name = "bad;command"'], ['repo_dir', 'repo_dir = "$HOME/secret"'],
  ])('rejects mismatched TOML %s', async (field, replacement) => {
    const f = await setup(); await writeFile(f.configPath, f.toml.replace(new RegExp(`^${field} = .*`, 'm'), replacement));
    expect((await rpc(f.authorization)).entries[0]).toMatchObject({ status: 'invalid_config', problems: [{ code: 'config_mismatch' }] });
  });
  it('rejects escaping roots, source symlinks, unknown profiles and missing source files', async () => {
    const f = await setup();
    const link = join(f.root, 'alias'); await symlink(f.source, link);
    await f.save([{ ...f.entry, engineSourcePath: link }]);
    expect((await rpc(f.authorization)).entries[0].problems[0].code).toBe('unsafe_path');
    await f.save([{ ...f.entry, adapter: 'unknown' }]);
    expect((await rpc(f.authorization)).entries[0].status).toBe('unsupported_source_profile');
    const sourceFile = join(f.source, 'src/orbi/config.py');
    const { unlink } = await import('node:fs/promises'); await unlink(sourceFile); await symlink(f.configPath, sourceFile);
    await f.save(); expect((await rpc(f.authorization)).entries[0].status).toBe('unsupported_source_profile');
    await unlink(sourceFile); expect((await rpc(f.authorization)).entries[0].status).toBe('unsupported_source_profile');
  });
  it('available startup reads only approved files; secrets and fixture bytes remain untouched', async () => {
    const f = await setup();
    await mkdir(join(f.repoDir, '.orbi')); await mkdir(join(f.repoDir, '.git'));
    const secretPaths = ['.orbi/env', '.orbi/providers.json', '.git/HEAD', '.orbi/runner.lock'].map(path => join(f.repoDir, path));
    for (const path of secretPaths) await writeFile(path, 'SECRET_CANARY');
    const observed = [f.authorization, f.configPath, ...secretPaths, ...profiles['orbi-0.7.41-release'].paths.map(path => join(f.source, path))];
    const before = await Promise.all(observed.map(path => filesystem.readFile(path)));
    const opened = vi.spyOn(filesystem, 'open'); opened.mockClear();
    vi.stubEnv('CANARY_TOKEN', 'ENV_SECRET_CANARY');
    const catalog = await rpc(f.authorization);
    expect(catalog.entries[0].status).toBe('available');
    const approved = new Set([f.authorization, f.configPath, ...profiles['orbi-0.7.41-release'].paths.map(path => join(f.source, path))]);
    expect(opened.mock.calls).toHaveLength(approved.size);
    for (const [path] of opened.mock.calls) expect(approved.has(String(path))).toBe(true);
    expect(JSON.stringify(catalog)).not.toMatch(/SECRET_CANARY|publisher-canary/);
    expect(await Promise.all(observed.map(path => filesystem.readFile(path)))).toEqual(before);
  });
  it('server snapshots startup environment; contracts are synchronous JSON-only and transform-free', async () => {
    const f = await setup(); vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
    let handler!: () => Promise<unknown>;
    cleanups.push(contribute({ handle: (contract: unknown, h: () => Promise<unknown>) => { if (contract === deploymentsList) handler = h; } } as unknown as PluginServerContext));
    vi.stubEnv('PASEO_ORBI_CONFIG', '/SECRET_CANARY');
    expect(DeploymentCatalog.parse(await handler()).state).toBe('configured');
    expect(() => deploymentsList.input.parse({ path: '/secret' })).toThrow();
    for (const schema of [deploymentsList.input, deploymentsList.output, observationSchema(z.object({ count: z.number() }))]) expect(z.toJSONSchema(schema)).toBeDefined();
  });
});

describe('bounded_reads_and_lifecycle', () => {
  it('rejects oversized, nonregular, escaping, and secret resource selectors', async () => {
    const f = await setup();
    const path = join(f.root, 'large.json'); await writeFile(path, Buffer.alloc(FILE_LIMIT + 1));
    await expect(readBytes(f.root, path)).rejects.toThrow('read_limit');
    await expect(readBytes(f.root, f.source)).rejects.toThrow('unsafe_path');
    const fifo = join(f.root, 'fifo');
    expect(spawnSync('mkfifo', [fifo], { timeout: 1000 }).status).toBe(0);
    await expect(readBytes(f.root, fifo)).rejects.toThrow('unsafe_path');
    await expect(readBytes(f.source, f.configPath)).rejects.toThrow('unsafe_path');
    await expect(readBytes(f.root, join(f.root, '.orbi/env'))).rejects.toThrow('unsafe_path');
    const alias = join(f.root, 'alias'); await symlink(f.configPath, alias);
    await expect(readBytes(f.root, alias)).rejects.toThrow('unsafe_path');
    expect(await boundedFile(f.root, path, true)).toMatchObject({ size: FILE_LIMIT + 1 });
    const ports = new ReadPorts(await ConfigRepository.load(f.authorization)); cleanups.push(() => ports.dispose());
    await expect(ports.read('demo', '../env' as 'health')).rejects.toThrow('unsafe_path');
    await expect(ports.process('demo', { kind: 'shell' } as any)).rejects.toThrow('unsafe_path');
    await mkdir(join(f.repoDir, '.orbi'));
    await writeFile(join(f.repoDir, '.orbi/health.json'), '{"status":"fixture"}');
    expect((await ports.read('demo', 'health')).toString()).toBe('{"status":"fixture"}');
    expect(await ports.stat('demo', 'health')).toMatchObject({ size: 20 });
    await ports.dispose(); await expect(ports.read('demo', 'health')).rejects.toThrow('disposed');
  });
  it('bounds a hanging host file read without returning late data', async () => {
    const f = await setup();
    const handle = await filesystem.open(f.configPath, 'r');
    let unblock!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<any>(resolve => { unblock = () => resolve({ bytesRead: 0, buffer: Buffer.alloc(0) }); });
    vi.spyOn(handle, 'read').mockImplementationOnce(() => { entered(); return pending; });
    vi.spyOn(filesystem, 'open').mockResolvedValueOnce(handle);
    vi.useFakeTimers();
    let outcome = 'pending';
    const reading = readBytes(f.root, f.configPath).then(() => { outcome = 'success'; }, error => { outcome = error.message; });
    await blocked;
    await vi.advanceTimersByTimeAsync(10000);
    const atDeadline = outcome;
    unblock(); await reading; await handle.close();
    expect(atDeadline).toBe('read_limit');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds startup directory checks and aborts initialization on cleanup', async () => {
    const f = await setup();
    const actual = await vi.importActual<typeof filesystem>('node:fs/promises');
    let release!: () => void, entered!: () => void;
    let blocked = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(filesystem, 'stat').mockImplementationOnce(async (...args) => {
      entered(); await new Promise<void>(resolve => { release = resolve; }); return actual.stat(...args);
    });
    vi.useFakeTimers();
    let result: DeploymentCatalog | undefined;
    const loading = ConfigRepository.load(f.authorization).then(repository => { result = repository.catalog(); });
    await blocked; await vi.advanceTimersByTimeAsync(10000);
    const atDeadline = result;
    release(); await loading;
    expect(atDeadline?.entries[0]).toMatchObject({ status: 'invalid_config', problems: [{ code: 'read_limit' }] });
    expect(vi.getTimerCount()).toBe(0);

    blocked = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(filesystem, 'stat').mockImplementationOnce(async (...args) => {
      entered(); await new Promise<void>(resolve => { release = resolve; }); return actual.stat(...args);
    });
    vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
    const cleanup = contribute({ handle: () => {} } as unknown as PluginServerContext);
    await blocked;
    const opened = vi.spyOn(filesystem, 'open'); opened.mockClear();
    let disposed = false;
    const disposing = cleanup().then(() => { disposed = true; });
    await vi.advanceTimersByTimeAsync(1);
    const disposedWhileBlocked = disposed;
    release(); await disposing;
    expect(opened).not.toHaveBeenCalled();
    expect(disposedWhileBlocked).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects inode replacement between check and open', async () => {
    const f = await setup();
    const actual = await vi.importActual<typeof filesystem>('node:fs/promises');
    vi.spyOn(filesystem, 'open').mockImplementationOnce(async (...args) => {
      const replacement = join(f.root, 'replacement');
      await writeFile(replacement, 'SECRET_CANARY');
      await filesystem.rename(replacement, f.configPath);
      return actual.open(...args);
    });
    await expect(readBytes(f.root, f.configPath)).rejects.toThrow(/^unsafe_path$/);
  });
  it('disposal aborts pending file reads, closes handles, and clears deadlines', async () => {
    const f = await setup();
    const ports = new ReadPorts(await ConfigRepository.load(f.authorization)); cleanups.push(() => ports.dispose());
    await mkdir(join(f.repoDir, '.orbi'));
    const path = join(f.repoDir, '.orbi/health.json'); await writeFile(path, '{}');
    const handle = await filesystem.open(path, 'r');
    let unblock!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<any>(resolve => { unblock = () => resolve({ bytesRead: 0, buffer: Buffer.alloc(0) }); });
    vi.spyOn(handle, 'read').mockImplementationOnce(() => { entered(); return pending; });
    vi.spyOn(filesystem, 'open').mockResolvedValueOnce(handle);
    vi.useFakeTimers();
    const reading = expect(ports.read('demo', 'health')).rejects.toThrow(/^disposed$/);
    await blocked; await ports.dispose(); unblock(); await reading;
    await handle.close(); expect(handle.fd).toBe(-1); expect(vi.getTimerCount()).toBe(0);
  });
  async function processFixture(script: string) {
    const f = await setup(); const bin = join(f.root, 'bin'); await mkdir(bin);
    for (const name of ['systemctl', 'journalctl', 'gh']) { const path = join(bin, name); await writeFile(path, `#!${process.execPath}\n${script}`); await chmod(path, 0o755); }
    vi.stubEnv('PATH', bin);
    const ports = new ReadPorts(await ConfigRepository.load(f.authorization)); cleanups.push(() => ports.dispose());
    return ports;
  }
  it('uses only documented fixed argv; no shell or client endpoint', async () => {
    const ports = await processFixture('console.log(JSON.stringify({args:process.argv.slice(2),stdin:require("node:fs").fstatSync(0).isCharacterDevice()}))');
    const result = JSON.parse(await ports.process('demo', { kind: 'systemctl-show', slot: 1, unit: 'service' }));
    expect(result.args).toEqual(['--user', 'show', 'orbi-demo@1.service', '--property=Id,LoadState,ActiveState,SubState,UnitFileState,Result,ExecMainCode,ExecMainStatus,NRestarts,LastTriggerUSec,NextElapseUSecRealtime,NextElapseUSecMonotonic', '--no-pager']);
    expect(JSON.parse(await ports.process('demo', { kind: 'journalctl', slot: 2 })).args).toEqual(['--user', '-u', 'orbi-demo@2.service', '--no-pager', '--since', '-1 hour', '-n', '200', '-o', 'json']);
    expect(JSON.parse(await ports.process('demo', { kind: 'gh-api-get', resource: 'comments', issue: 2, page: 1 })).args).toEqual(['api', '--hostname', 'github.com', '--method', 'GET', '--include', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', 'repos/Example/project/issues/2/comments?per_page=100&page=1']);
    await expect(ports.process('demo', { kind: 'systemctl-show', slot: 3, unit: 'service' })).rejects.toThrow('unsafe_path');
    await expect(ports.process('demo', { kind: 'gh-api-get', resource: 'issues', state: 'open', order: 'updated_desc', page: 11 })).rejects.toThrow('unsafe_path');
  });
  it('caps combined output and redacts process errors', async () => {
    const ports = await processFixture('process.stderr.write("SECRET_CANARY".repeat(100000));process.stdout.write("x".repeat(1048577))');
    await expect(ports.process('demo', { kind: 'journalctl', slot: 1 })).rejects.toThrow(/^read_limit$/);
    const errorPorts = await processFixture('console.error("SECRET_CANARY");process.exit(1)');
    await expect(errorPorts.process('demo', { kind: 'journalctl', slot: 1 })).rejects.toThrow(/^process_failed$/);
    vi.stubEnv('PATH', '/does-not-exist');
    await expect(errorPorts.process('demo', { kind: 'journalctl', slot: 1 })).rejects.toThrow(/^process_failed$/);
  });
  it('timeout and disposal kill helpers that inherit process output pipes', async () => {
    const f = await setup();
    const pidFile = join(f.root, 'helper.pid');
    const ports = await processFixture(`
      const {spawn} = require('node:child_process');
      const helper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:['ignore',1,2]});
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
      setInterval(()=>{},1000);
    `);
    // Emergency cleanup keeps the regression bounded even against the broken port.
    let helperPid: number | undefined;
    cleanups.push(() => { if (helperPid) { try { process.kill(helperPid, 'SIGKILL'); } catch {} } });
    vi.useFakeTimers();
    const op = { kind: 'journalctl', slot: 1 } as const;
    for (const reason of ['process_timeout', 'disposed']) {
      let errorCode: string | undefined;
      const pending = ports.process('demo', op).catch(error => { errorCode = error.message; });
      // Await a real child-side readiness marker, not fake timer progress.
      await vi.waitFor(async () => { helperPid = Number(await filesystem.readFile(pidFile, 'utf8')); }, { timeout: 1000 });
      if (reason === 'process_timeout') await vi.advanceTimersByTimeAsync(10000);
      else void ports.dispose();
      await vi.waitFor(() => { expect(errorCode).toBe(reason); }, { timeout: 1000 });
      await pending;
      await filesystem.unlink(pidFile);
    }
    expect(vi.getTimerCount()).toBe(0);
  });
  it('limits concurrency, kills timed-out children and reaps on disposal', async () => {
    const ports = await processFixture('setInterval(()=>{},1000)');
    vi.useFakeTimers();
    const op = { kind: 'systemctl-show', slot: 1, unit: 'service' } as const;
    const a = ports.process('demo', op); const b = ports.process('demo', op);
    const checks = Promise.all([expect(a).rejects.toThrow('process_timeout'), expect(b).rejects.toThrow('process_timeout')]);
    await expect(ports.process('demo', op)).rejects.toThrow('process_limit');
    await vi.advanceTimersByTimeAsync(10000); await checks;
    const pending = ports.process('demo', op); const disposed = expect(pending).rejects.toThrow('disposed');
    await ports.dispose(); await disposed;
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Host/RN modules are mocked; all safety code and QueryClient behavior remain real.
import './helpers/host';
import { host } from './helpers/host';
import React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PluginClientContext, PluginScreenContribution, PluginSidebarItemContribution, PluginScreenProps } from '@getpaseo/plugin/client';
import contributeClient from '../index.client';
import { ObservationView, useObservationQuery } from '../client/observation';
import type { Observation } from '../shared/common';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const props = {
  theme: { colors: { foreground: '#eee', foregroundMuted: '#aaa', surface0: '#111' } },
  host: { id: 'host-a', label: 'Host A' }, layout: { compact: true, platform: 'ios' }, params: {},
} as PluginScreenProps;
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1); }); };
function queryClient() { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); cleanups.push(() => client.clear()); return client; }
function tree(client: QueryClient, child: React.ReactNode) { return React.createElement(QueryClientProvider, { client }, child); }
async function render(client: QueryClient, child: React.ReactNode) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(tree(client, child)); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); });
  await settle(); return renderer;
}

describe('package_and_registration', () => {
  it('registers five routes; SidebarRow and injected screen navigation open screens; rejected entries are not selectable', async () => {
    vi.useFakeTimers();
    const f = await setup();
    await f.save([f.entry, { ...f.entry, id: 'rejected', repo: 'Other/repo' }]);
    const catalog = await rpc(f.authorization);
    host.readCatalog.mockResolvedValue(catalog);
    const screens: PluginScreenContribution[] = [], sidebar: PluginSidebarItemContribution[] = [];
    const remove = vi.fn(), openScreen = vi.fn();
    const cleanup = contributeClient({ addScreen: (s: PluginScreenContribution) => { screens.push(s); return remove; }, addSidebarHeaderItem: (s: PluginSidebarItemContribution) => { sidebar.push(s); return remove; }, openScreen } as unknown as PluginClientContext);
    // The stable ids plus the host-scoped Services screen.
    expect(screens.map(s => s.id)).toEqual(['fleet', 'services', 'issues', 'runs', 'blockers']);
    expect(screens.map(s => s.title)).toEqual(['Work', 'Services', 'Issues', 'Runs', 'Blockers']);
    const client = queryClient();
    for (const screen of screens) {
      const renderer = await render(client, React.createElement(screen.Component, { ...props, params: { deploymentId: 'demo' } }));
      // A selected available repository is named by the heading, not a prompt;
      // the other catalogs (rejected/empty/invalid) keep the selection prompt.
      expect(JSON.stringify(renderer.toJSON())).toContain(screen.id === 'fleet' ? 'Fleet — read-only' : screen.id === 'services' ? 'Service check off · activity unknown' : `${screen.title} · Demo (Example/project)`);
      expect(JSON.stringify(renderer.toJSON())).toContain('config_mismatch');
      const screenText = () => renderer.root.findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
      if (screen.id === 'fleet') {
        // Work first: persistent navigation, then real issue rows; no embedded
        // service inventory or technical-details disclosure.
        expect(screenText()).toMatch(/^Work\nServices\nRuns\n/);
        // The persistent navigation names the surface; no duplicate inner title.
        expect(screenText()).not.toContain('Work · Host A');
        expect(screenText()).toContain('Repository: Demo (Example/project)');
        expect(screenText()).not.toContain('Host A · Fleet');
        expect(renderer.root.findAllByProps({ accessibilityLabel: 'Services (technical details)' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'orbi-host-services' })).toHaveLength(0);
        // The health summary is text; only the separate View services action is a control.
        expect(renderer.root.findAllByProps({ accessibilityLabel: 'View services' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'orbi-work-health' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ accessibilityLabel: 'Refresh services' })).toHaveLength(0);
        expect(renderer.root.findAll(node => node.props.accessibilityLabel === 'Active work for Demo')).toHaveLength(1);
        await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Active work for Demo' }).props.onPress());
        expect(openScreen).toHaveBeenCalledWith({ screenId: 'issues', params: { deploymentId: 'demo' } });
        expect(renderer.root.findAll(node => node.props.accessibilityLabel?.startsWith('Select '))).toHaveLength(0);
      } else if (screen.id === 'services') {
        // Services is host-scoped: no repository selector and no repository read.
        expect(screenText()).toContain('Services · Host A');
        expect(renderer.root.findAll(node => node.props.accessibilityLabel?.startsWith('Select '))).toHaveLength(0);
      } else {
        // Demo is the one available repository and it is the selected one: the
        // heading names it and no switch list (nor the rejected entry) is offered.
        expect(screenText()).not.toContain('select a repository to browse');
        expect(renderer.root.findAll(node => node.props.accessibilityLabel?.startsWith('Select '))).toHaveLength(0);
      }
      const navigation = renderer.root.findByProps({ testID: 'orbi-navigation' });
      expect(navigation.props.style).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
      const tabs = navigation.findAllByType('Pressable' as any);
      // Persistent Work / Services / Runs navigation; Issues and Blockers keep
      // their ids and links without a tab of their own.
      expect(tabs.map(tab => tab.props.accessibilityLabel)).toEqual(['Open Work', 'Open Services', 'Open Runs']);
      const selected = screen.id === 'fleet' ? 'Open Work' : screen.id === 'services' ? 'Open Services' : screen.id === 'runs' ? 'Open Runs' : null;
      for (const tab of tabs) {
        expect(tab.props.accessibilityRole).toBe('button'); // RN web supplies Enter/Space activation for onPress.
        expect(tab.props.accessibilityState).toMatchObject({ selected: tab.props.accessibilityLabel === selected });
      }
      const targets = [
        { screenId: 'fleet', params: { deploymentId: 'demo', surface: 'work' } },
        { screenId: 'services', params: { deploymentId: 'demo' } },
        { screenId: 'runs', params: { deploymentId: 'demo' } },
      ];
      for (const [index, tab] of tabs.entries()) {
        await act(async () => tab.props.onPress());
        expect(openScreen).toHaveBeenLastCalledWith(targets[index]);
      }
      expect(renderer.root.findAll(node => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith('Open '))).toHaveLength(3);
      expect(JSON.stringify(renderer.toJSON())).not.toContain('Read-only. Open Fleet');
      expect(renderer.root.findByType('ScrollView' as any).props.contentContainerStyle.padding).toBe(16);
      const light = { ...props, params: { deploymentId: 'rejected' }, theme: { colors: { ...props.theme.colors, foreground: '#222', foregroundMuted: '#555', surface0: '#fff' } }, layout: { compact: false, platform: 'web' } } as PluginScreenProps;
      await act(async () => renderer.update(tree(client, React.createElement(screen.Component, light))));
      expect(renderer.root.findByType('ScrollView' as any).props.contentContainerStyle.padding).toBe(24);
      for (const text of renderer.root.findAllByType('Text' as any)) expect(text.props.style.color).toBe('#222');
      await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Open Work' }).props.onPress());
      expect(openScreen).toHaveBeenLastCalledWith({ screenId: 'fleet', params: { surface: 'work' } });
    }
    const renderer = await render(client, React.createElement(sidebar[0].Component, { ...props, currentScreen: null, openScreen, openPopover: vi.fn() }));
    const rows = renderer.root.findAll(node => node.type === ('SidebarRow' as any));
    expect(rows).toHaveLength(1); expect(rows[0].props.label).toBe('Orbi');
    rows[0].props.onPress(); expect(openScreen).toHaveBeenCalledWith({ screenId: 'fleet' });
    for (const screen of screens) {
      await act(async () => renderer.update(tree(client, React.createElement(sidebar[0].Component, { ...props, currentScreen: { screenId: screen.id, params: {} }, openScreen, openPopover: vi.fn() }))));
      expect(renderer.root.findByType('SidebarRow' as any).props.active).toBe(true);
    }
    cleanup(); expect(remove).toHaveBeenCalledTimes(6);
  });
  it('gates every deep link with the shared real-schema setup/catalog states and foreground/offline repair', async () => {
    vi.useFakeTimers();
    const screens: PluginScreenContribution[] = [];
    const stop = contributeClient({ addScreen: (s: PluginScreenContribution) => { screens.push(s); return vi.fn(); }, addSidebarHeaderItem: () => vi.fn(), openScreen: vi.fn() } as unknown as PluginClientContext);
    cleanups.push(stop);
    const features = [host.readFleet, host.readIssues, host.readIssue, host.readRuns, host.readRun, host.readBlockers, host.readBlocker];
    for (const read of features) read.mockClear();
    const f = await setup(); await writeFile(f.authorization, '{SECRET_CANARY');
    const invalid = await rpc(f.authorization), unconfigured = await rpc();
    await f.save([]); const empty = await rpc(f.authorization);
    await f.save([{ ...f.entry, repo: 'Other/repo' }]); const rejected = await rpc(f.authorization);
    const catalogs = [unconfigured, invalid, empty, rejected];
    const setupLabel = (catalog: DeploymentCatalog) => catalog.state === 'unconfigured' || catalog.state === 'invalid';
    for (const catalog of catalogs) for (const screen of screens) {
      host.readCatalog.mockReset().mockResolvedValue(catalog);
      const client = queryClient();
      const renderer = await render(client, React.createElement(screen.Component, { ...props, params: { deploymentId: 'demo' } }));
      const json = () => JSON.stringify(renderer.toJSON());
      expect(renderer.root.findAllByProps({ testID: 'orbi-catalog' })).toHaveLength(1);
      // The Work / Services / Runs navigation is persistent in every catalog state.
      expect(renderer.root.findAllByProps({ testID: 'orbi-navigation' })).toHaveLength(1);
      expect(renderer.root.findAllByProps({ accessibilityLabel: 'Orbi setup' })).toHaveLength(setupLabel(catalog) ? 1 : 0);
      if (setupLabel(catalog)) {
        const guide = renderer.root.findByProps({ accessibilityLabel: 'Setup guide' });
        expect(guide.props).toMatchObject({ accessibilityRole: 'button', accessibilityState: { expanded: false } });
        expect(guide.props.style({ pressed: false })).toMatchObject({ minHeight: 44 });
        if (catalog.state === 'unconfigured') expect(json()).not.toContain('PASEO_ORBI_CONFIG');
        await act(async () => guide.props.onPress());
        expect(json()).toContain('PASEO_ORBI_CONFIG'); expect(json()).toContain('explicitly reload');
        expect(json()).toContain('does not configure authorization');
        // The guide is instructions only: it never saves settings or discovers authority.
        const setupText = () => renderer.root.findByProps({ accessibilityLabel: 'Repository setup guide' })
          .findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
        expect(setupText()).toContain('Host service inventory is independent');
        expect(setupText()).not.toMatch(/\bSave\b|auto-?discover|Discover repositories/);
        if (catalog.state === 'unconfigured') {
          // Runs names its own capability in the one shared notice; every other
          // route keeps the issue copy and never shows both.
          expect(json()).toContain(screen.id === 'runs'
            ? 'Link a repository to see its runs.'
            : 'Repositories aren’t linked. Link repositories to see GitHub issues.');
          if (screen.id === 'runs') expect(json()).not.toContain('Repositories aren’t linked.');
          // A confirmed unconfigured catalog is not a read failure: rereading startup
          // configuration cannot repair it, so no catalog Refresh is offered.
          expect(renderer.root.findAllByProps({ accessibilityLabel: 'Refresh' })).toHaveLength(0);
        } else {
          expect(json()).toContain('Issue reads are unavailable');
          expect(json()).toContain('the configured repository catalog is invalid');
        }
      } else if (catalog.entries.length) expect(json()).toContain('config_mismatch');
      else expect(json()).toContain('No configured deployments.');
      expect(json()).not.toMatch(/Observation status:|Last success:|Observed:|SECRET_CANARY/);
      if (screen.id !== 'fleet') expect(renderer.root.findAll(node => node.props.accessibilityLabel?.startsWith('Select '))).toHaveLength(0);
      // None of these catalogs offers a selection, so no route renders the
      // impossible fallback prompt; loading/invalid/rejected stay labelled as such.
      expect(renderer.root.findAllByType('Text' as any).map(node => node.children.join('')).join('\n'))
        .not.toContain('select a repository to browse');
      expect(host.readCatalog).toHaveBeenCalledTimes(1);
      if (catalog.state === 'invalid') {
        const button = () => renderer.root.findByProps({ accessibilityLabel: 'Refresh' });
        expect(button().props).toMatchObject({ disabled: false, accessibilityState: { disabled: false, busy: false } });
        let finish!: (value: DeploymentCatalog) => void;
        host.readCatalog.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        let pending!: Promise<unknown>;
        await act(async () => { pending = button().props.onPress(); }); await settle();
        expect(button().props).toMatchObject({ disabled: true, accessibilityState: { disabled: true, busy: true } });
        await act(async () => { finish(catalog); await pending; }); await settle();
        await act(async () => { for (const listener of host.listeners) listener('background'); });
        await act(async () => { await vi.advanceTimersByTimeAsync(60001); }); await settle();
        expect(json()).toContain('Catalog transport: Stale');
        expect(button().props).toMatchObject({ disabled: true, accessibilityState: { disabled: true, busy: false } });
        expect(host.readCatalog).toHaveBeenCalledTimes(2);
      }
      await act(async () => renderer.unmount());
    }
    for (const read of features) expect(read).not.toHaveBeenCalled();
    // The unconfigured landing defaults to Services; the host inventory is read
    // there without adding repository navigation or authority.
    host.readInventory.mockResolvedValue(servicesInventory.output.parse({
      state: 'complete', observedAt: '2026-11-14T23:00:00.000Z',
      sources: [
        { source: 'runtime', state: 'complete', observedAt: '2026-11-14T23:00:00.000Z', problems: [] },
        { source: 'installed', state: 'complete', observedAt: '2026-11-14T23:00:00.000Z', problems: [] },
      ],
      problems: [], groups: [{ label: 'orbi-demo', kind: 'runner-family', association: 'matched', deploymentId: 'demo', units: [] }],
    }));
    host.readCatalog.mockReset().mockResolvedValue(unconfigured);
    const inventoryRenderer = await render(queryClient(), React.createElement(screens[1].Component, { ...props, params: { deploymentId: 'demo' } }));
    expect(inventoryRenderer.root.findAllByProps({ testID: 'orbi-host-services' })).toHaveLength(1);
    expect(inventoryRenderer.root.findAllByProps({ testID: 'orbi-navigation' })).toHaveLength(1);
    expect(inventoryRenderer.root.findAll(node => node.props.accessibilityLabel?.startsWith('View repository'))).toHaveLength(0);
    // One explanation above the rows replaces the repeated Unlinked badge.
    expect(JSON.stringify(inventoryRenderer.toJSON())).toContain('Repositories aren’t linked. Link repositories to see GitHub issues.');
    expect(JSON.stringify(inventoryRenderer.toJSON())).not.toContain('Unlinked');
    await act(async () => inventoryRenderer.root.findByProps({ accessibilityLabel: 'Details for orbi-demo' }).props.onPress());
    expect(JSON.stringify(inventoryRenderer.toJSON())).toContain('not in the current authorized catalog');
    for (const read of features) expect(read).not.toHaveBeenCalled();
    await act(async () => inventoryRenderer.unmount());
    host.readInventory.mockResolvedValue({ state: 'off', observedAt: null, sources: [], groups: [], problems: [] });
    // Missing selected-host source data is unavailable, never another host's cached catalog.
    let fail!: (error: Error) => void;
    host.readCatalog.mockReset().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const client = queryClient();
    const Screen = screens[1].Component;
    const renderer = await render(client, React.createElement(Screen, props));
    expect(JSON.stringify(renderer.toJSON())).toContain('Catalog transport: Loading');
    expect(JSON.stringify(renderer.toJSON())).toContain('Catalog: Loading');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Refresh' }).props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(renderer.root.findAllByProps({ testID: 'orbi-navigation' })).toHaveLength(1);
    for (const read of features) expect(read).not.toHaveBeenCalled();
    await act(async () => { fail(new Error('SECRET_CANARY')); }); await settle();
    expect(JSON.stringify(renderer.toJSON())).toContain('refresh_failed');
    expect(JSON.stringify(renderer.toJSON())).toContain('Catalog transport: Unavailable');
    expect(JSON.stringify(renderer.toJSON())).toContain('Catalog: Unavailable');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('SECRET_CANARY');
    host.readCatalog.mockResolvedValue(invalid);
    await act(async () => { await renderer.root.findByProps({ accessibilityLabel: 'Refresh' }).props.onPress(); }); await settle();
    host.readCatalog.mockRejectedValue(new Error('SECRET_CANARY'));
    await act(async () => { await renderer.root.findByProps({ accessibilityLabel: 'Refresh' }).props.onPress(); }); await settle();
    expect(JSON.stringify(renderer.toJSON())).toContain('Orbi setup');
    expect(JSON.stringify(renderer.toJSON())).toContain('Catalog transport: Stale');
    expect(JSON.stringify(renderer.toJSON())).toContain('Catalog: Stale');
    const calls = host.readCatalog.mock.calls.length;
    await act(async () => renderer.update(tree(client, React.createElement(Screen, { ...props, host: { id: 'host-b', label: 'Host B' } })))); await settle();
    expect(JSON.stringify(renderer.toJSON())).toContain('Selected host is offline');
    expect(JSON.stringify(renderer.toJSON())).toContain('Orbi setup');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Refresh' }).props.disabled).toBe(true);
    expect(host.readCatalog).toHaveBeenCalledTimes(calls);
    await act(async () => renderer.unmount()); expect(host.listeners.size).toBe(0);
  });
});

describe('bounded_reads_and_lifecycle client', () => {
  type Value = { value: string };
  type Options = Parameters<typeof useObservationQuery<Value>>[0];
  let current!: ReturnType<typeof useObservationQuery<Value>>;
  function Harness(options: Options) {
    current = useObservationQuery(options);
    return React.createElement(ObservationView<Value>, { ...current, theme: props.theme, children: data => data.value });
  }
  function success(value: string): Observation<Value> {
    const now = new Date().toISOString();
    return { state: 'available', observedAt: now, lastSuccessfulAt: now, data: { value }, problems: [] };
  }
  const options = (read: Options['read']): Options => ({ hostId: 'host-a', deploymentId: 'demo', selector: 'test', connected: true, foreground: true, read });
  it('observation_accessibility_and_refresh_gate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
    let complete!: (value: Observation<Value>) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise<Observation<Value>>(resolve => { complete = resolve; }));
    const client = queryClient();
    const renderer = await render(client, React.createElement(Harness, options(read)));
    const button = () => renderer.root.findByType('Pressable' as any);
    const alert = () => renderer.root.findByProps({ accessibilityRole: 'alert' });
    const status = (value: string) => renderer.root.findByProps({ accessibilityLabel: `Observation status: ${value}` });
    const gate = (disabled: boolean, busy: boolean) => {
      expect(current).toMatchObject({ canRefresh: !disabled, refreshing: busy });
      expect(button().props).toMatchObject({ disabled, accessibilityLabel: 'Refresh', accessibilityRole: 'button', accessibilityState: { disabled, busy } });
      expect(button().findByType('Text' as any).children).toEqual([busy ? 'Refreshing' : 'Refresh']);
      const opacity = button().props.style({ pressed: false }).opacity;
      if (disabled || busy) expect(opacity).toBeLessThan(1); else expect(opacity).toBe(1);
      expect(button().findByType('Text' as any).props.style.color).toBe(props.theme.colors.foreground);
    };
    const activate = async () => { await act(async () => { if (!button().props.disabled) await button().props.onPress(); }); await settle(); };
    const update = async (connected: boolean, foreground: boolean) => {
      await act(async () => renderer.update(tree(client, React.createElement(Harness, { ...options(read), connected, foreground }))));
      await settle();
    };
    gate(true, true);
    expect(status('Loading').children).toEqual(['Loading']);
    expect(read).toHaveBeenCalledTimes(1);
    await activate(); expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { complete(success('retained data')); }); await settle();
    gate(false, false);
    expect(status('Current').children).toEqual(['Current']);
    expect(renderer.root.findAllByType('View' as any).every(node => !node.props.accessible)).toBe(true);

    // A selected-host disconnect and backgrounding disable the real control;
    // direct callers also retain the hook's defensive no-read guard.
    await update(false, true); gate(true, false);
    expect(status('Stale').children).toEqual(['Stale']);
    expect(alert().children).toEqual([]); // Offline is not a backend failure.
    await activate(); await act(async () => { await current.refresh(); });
    await update(true, false); gate(true, false);
    await activate(); await act(async () => { await current.refresh(); });
    expect(read).toHaveBeenCalledTimes(1);
    await update(true, true); gate(false, false);
    expect(read).toHaveBeenCalledTimes(1);

    // Activation when available starts one read; a same-key direct activation
    // while busy coalesces rather than starting an overlapping RPC.
    let reject!: (error: Error) => void;
    read.mockImplementationOnce(() => new Promise<Observation<Value>>((_resolve, fail) => { reject = fail; }));
    let first!: Promise<unknown>, second!: Promise<unknown>;
    await act(async () => { first = button().props.onPress(); }); await settle();
    gate(true, true);
    expect(read).toHaveBeenCalledTimes(2);
    await activate();
    await act(async () => { second = current.refresh(); });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { reject(new Error('SECRET_CANARY raw exception')); await Promise.all([first, second]); }); await settle();
    gate(false, false);
    expect(status('Stale').children).toEqual(['Stale']);
    const problemRegion = alert();
    expect(problemRegion.children).toEqual(['filesystem: refresh_failed']);
    expect(JSON.stringify(renderer.toJSON())).toContain('retained data');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('SECRET_CANARY');
    expect(problemRegion.findAllByType('Pressable' as any)).toHaveLength(0);

    // Repeated unchanged failures update observation time, not alert identity or
    // content. Timestamps remain visible in a separate Text node.
    const previousTime = current.observation!.observedAt;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    read.mockRejectedValue(new Error('SECRET_CANARY repeated exception'));
    await activate();
    expect(read).toHaveBeenCalledTimes(3);
    expect(current.observation!.observedAt).not.toBe(previousTime);
    expect(alert()).toBe(problemRegion);
    expect(alert().children).toEqual(['filesystem: refresh_failed']);
    // #134: the visible timestamp is the local rendering of the observed instant.
    expect(renderer.root.findAllByType('Text' as any).some(node => node !== alert() && JSON.stringify(node.children).includes(formatLocalTime(current.observation!.observedAt)))).toBe(true);

    // Repair and Refresh removes the problem, but keeps children and status
    // independently accessible. Age-only staleness must not invent an error.
    read.mockImplementation(async () => success('repaired data'));
    await activate(); gate(false, false);
    expect(read).toHaveBeenCalledTimes(4);
    expect(status('Current').children).toEqual(['Current']);
    expect(alert()).toBe(problemRegion); expect(alert().children).toEqual([]);
    expect(JSON.stringify(renderer.toJSON())).toContain('repaired data');
    await update(true, false); gate(true, false);
    await act(async () => { await vi.advanceTimersByTimeAsync(60001); });
    await activate();
    expect(read).toHaveBeenCalledTimes(4);
    expect(status('Stale').children).toEqual(['Stale']);
    expect(alert().children).toEqual([]);
  });
  it('polls every 30 seconds, coalesces manual refresh and retains failed data as visibly stale', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(success('last good'));
    const renderer = await render(queryClient(), React.createElement(Harness, options(read)));
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); await settle();
    expect(read).toHaveBeenCalledTimes(2);
    read.mockRejectedValue(new Error('SECRET_CANARY raw error'));
    await act(async () => { await current.refresh(); }); await settle();
    expect(current.observation).toMatchObject({ state: 'stale', data: { value: 'last good' } });
    expect(JSON.stringify(renderer.toJSON())).toContain('Stale'); expect(JSON.stringify(renderer.toJSON())).not.toContain('SECRET_CANARY');
    let complete!: (value: Observation<Value>) => void;
    read.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    let first!: Promise<unknown>, second!: Promise<unknown>;
    await act(async () => { first = current.refresh(); second = current.refresh(); });
    expect(read).toHaveBeenCalledTimes(4);
    await act(async () => { complete(success('new')); await Promise.all([first, second]); }); await settle();
    expect(current.observation?.data?.value).toBe('new');
  });
  it('foreground/connectivity gate manual and automatic reads, mark old data stale at 60 seconds and dispose timers', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(success('old'));
    const client = queryClient(); const renderer = await render(client, React.createElement(Harness, options(read)));
    await act(async () => renderer.update(tree(client, React.createElement(Harness, { ...options(read), foreground: false }))));
    await act(async () => { await current.refresh(); await vi.advanceTimersByTimeAsync(60001); });
    expect(read).toHaveBeenCalledTimes(1); expect(current.observation?.state).toBe('stale');
    await act(async () => renderer.update(tree(client, React.createElement(Harness, { ...options(read), connected: false }))));
    await act(async () => { await current.refresh(); await vi.advanceTimersByTimeAsync(30000); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount()); client.clear(); expect(vi.getTimerCount()).toBe(0);
  });
  it('serializes same-key replacement generations without reusing cancelled results', async () => {
    vi.useFakeTimers();
    let complete!: (value: Observation<Value>) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise<Observation<Value>>(resolve => { complete = resolve; })).mockImplementation(async () => success('new generation'));
    const client = queryClient();
    const first = await render(client, React.createElement(Harness, options(read)));
    await act(async () => first.unmount());
    const second = await render(client, React.createElement(Harness, options(read)));
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { complete(success('cancelled SECRET_CANARY')); }); await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(current.observation?.data?.value).toBe('new generation');
    expect(JSON.stringify(second.toJSON())).not.toContain('SECRET_CANARY');
  });
  it('late callbacks cannot populate a replacement host/deployment or resurrect disposed generations', async () => {
    vi.useFakeTimers();
    let complete!: (value: Observation<Value>) => void;
    const pending = vi.fn(() => new Promise<Observation<Value>>(resolve => { complete = resolve; }));
    const client = queryClient(); const renderer = await render(client, React.createElement(Harness, options(pending)));
    const replacement = { ...options(async () => success('host-b value')), hostId: 'host-b', deploymentId: 'other' };
    await act(async () => renderer.update(tree(client, React.createElement(Harness, replacement)))); await settle();
    await act(async () => { complete(success('host-a SECRET_CANARY')); }); await settle();
    expect(current.observation?.data?.value).toBe('host-b value');
    expect(client.getQueryData(['paseo-orbi', 'host-a', 'demo', 'test'])).toBeUndefined();
    expect(JSON.stringify(renderer.toJSON())).not.toContain('SECRET_CANARY');
    await act(async () => renderer.unmount()); client.clear(); expect(vi.getTimerCount()).toBe(0);
  });
});
