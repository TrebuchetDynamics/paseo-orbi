import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { ConfigRepository } from '../server/config';
import { ReadError, ReadPorts } from '../server/read-ports';
import { createServiceInventory, OVERALL_DEADLINE_MS, ROW_LIMIT, SNAPSHOT_TTL_MS } from '../server/service-inventory';
import { servicesInventory } from '../shared/services';
import contribute from '../index.server';
import { fixture } from './helpers/fixtures';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});

// Controlled systemctl plain output. Descriptions and unrelated names are
// canaries: only ID/LOAD/ACTIVE/SUB and ID/state may reach the response.
const runtime = [
  'orbi@1.service loaded active running Orbi Runner DESCRIPTION_CANARY /srv/SECRET_CANARY',
  'orbi@1.timer loaded active waiting Orbi Timer',
  'orbi@2.service loaded activating start Orbi Runner',
  'orbi@2.timer loaded active elapsed Orbi Timer',
  'orbi@3.service loaded failed failed Orbi Runner',
  'orbi@3.timer loaded active waiting Orbi Timer',
  'orbi@4.timer loaded inactive dead Orbi Timer unpaired',
  'orbi@6.service loaded active mystery Orbi Runner unknown sub-state',
  'orbi-demo@1.service loaded inactive dead Orbi Runner',
  'orbi-demo@1.timer loaded active waiting Orbi Timer',
  'orbi-exporter.service loaded active running Orbi exporter',
  'orbital.service loaded active running Lookalike unrelated unit',
].join('\n') + '\n';
const installed = [
  'orbi@.service enabled',
  'orbi@.timer enabled',
  'orbi@5.service static',
  'orbi-demo@.service disabled',
  'orbi-demo@.timer disabled',
  'orbi-exporter.service enabled',
].join('\n') + '\n';

function stubPort(lists: { runtime?: string | Error; installed?: string | Error } = { runtime, installed }) {
  const calls: string[] = [];
  return {
    calls,
    port: {
      clock: () => new Date('2026-11-14T23:00:00Z'),
      hostInventory: vi.fn(async (operation: 'runtime' | 'installed') => {
        calls.push(operation);
        const value = lists[operation];
        if (value instanceof Error) throw value;
        if (value === undefined) throw new ReadError('process_failed');
        return value;
      }),
    },
  };
}
const reader = (lists: { runtime?: string | Error; installed?: string | Error } = { runtime, installed }, claims: () => readonly { id: string; unitName: string | null; status: 'available' | 'unsupported_source_profile' }[] = () => []) => {
  const stub = stubPort(lists);
  return { ...stub, read: createServiceInventory({ enabled: true, claims, port: stub.port }) };
};
const parse = (value: unknown) => servicesInventory.output.parse(value);
// The only answer allowed once the operator grant is withdrawn.
const OFF = { state: 'off', observedAt: null, sources: [], groups: [], problems: [] } as const;

describe('host_service_inventory', () => {
  it('defaults to off and spawns nothing', async () => {
    const hostInventory = vi.fn(async () => runtime);
    const read = createServiceInventory({ enabled: false, claims: () => [], port: { clock: () => new Date(), hostInventory } });
    const result = parse(await read({}));
    expect(result).toEqual({ state: 'off', observedAt: null, sources: [], groups: [], problems: [] });
    expect(hostInventory).not.toHaveBeenCalled();
    expect(() => servicesInventory.input.parse({ deploymentId: 'demo' })).toThrow();
    expect(servicesInventory.input.parse({})).toEqual({});
  });

  it('distinguishes loaded runtime facts, installed names, templates, unpaired units and non-family names', async () => {
    const { read } = reader();
    const result = parse(await read({}));
    expect(result.state).toBe('complete');
    expect(result.sources).toEqual([
      { source: 'runtime', state: 'complete', observedAt: '2026-11-14T23:00:00.000Z', problems: [] },
      { source: 'installed', state: 'complete', observedAt: '2026-11-14T23:00:00.000Z', problems: [] },
    ]);
    expect(result.problems).toEqual([]);
    expect(result.groups.map(group => group.label)).toEqual(['orbi', 'orbi-demo', 'orbi-exporter', 'orbital']);
    const [base, demo, exporter, lookalike] = result.groups;
    expect(base.kind).toBe('runner-family');
    expect(demo.kind).toBe('runner-family');
    expect(exporter.kind).toBe('auxiliary');
    expect(lookalike).toMatchObject({ kind: 'other', association: 'unmatched', deploymentId: null });
    expect(result.groups.every(group => group.association === 'unmatched' && group.deploymentId === null)).toBe(true);
    const unit = (id: string) => result.groups.flatMap(group => group.units).find(entry => entry.id === id);
    expect(unit('orbi@1.service')).toMatchObject({ kind: 'service', runtime: { loadState: 'loaded', activeState: 'active', subState: 'running' }, unitFileState: null });
    expect(unit('orbi@1.timer')).toMatchObject({ kind: 'timer', runtime: { activeState: 'active', subState: 'waiting' } });
    expect(unit('orbi@2.service')).toMatchObject({ runtime: { activeState: 'activating', subState: 'start' } });
    expect(unit('orbi@3.service')).toMatchObject({ runtime: { activeState: 'failed', subState: 'failed' } });
    expect(unit('orbi@3.timer')).toMatchObject({ runtime: { activeState: 'active', subState: 'waiting' } });
    // An unpaired timer stays observed; no service is invented for it.
    expect(unit('orbi@4.timer')).toMatchObject({ kind: 'timer', unitFileState: null });
    expect(unit('orbi@4.service')).toBeUndefined();
    // Template declarations and an installed-only slot keep installed facts separate.
    expect(unit('orbi@.service')).toMatchObject({ runtime: null, unitFileState: 'enabled' });
    expect(unit('orbi@5.service')).toMatchObject({ runtime: null, unitFileState: 'static' });
    expect(unit('orbi@6.service')).toMatchObject({ runtime: { activeState: 'active', subState: 'unknown' } });
    // A unit seen by both sources keeps each fact without letting one overwrite the other.
    expect(unit('orbi-exporter.service')).toMatchObject({ runtime: { activeState: 'active' }, unitFileState: 'enabled' });
    expect(result.groups.every(group => group.label !== 'orbi-exporter@1')).toBe(true);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/DESCRIPTION_CANARY|SECRET_CANARY|\/srv\/|Lookalike/);
    expect(text).not.toMatch(/total|capacity|occupancy/i);
  });

  it('treats a complete snapshot with no matching units as the only confirmed empty inventory', async () => {
    const empty = parse(await reader({ runtime: '', installed: '' }).read({}));
    expect(empty).toMatchObject({ state: 'complete', groups: [], problems: [] });
    expect(empty.sources.map(source => source.state)).toEqual(['complete', 'complete']);
  });

  it('reports malformed rows, limits and per-source availability without a false empty result', async () => {
    const malformed = reader({
      runtime: ['garbage', 'orbi@1.service loaded', 'nginx.service loaded active running unrelated', 'orbi@2.service loaded active exited Orbi Runner'].join('\n'),
      installed: '',
    });
    const partial = parse(await malformed.read({}));
    expect(partial.state).toBe('partial');
    expect(partial.sources[0]).toMatchObject({ source: 'runtime', state: 'partial', problems: [{ source: 'runtime', code: 'malformed_record' }] });
    expect(partial.problems).toEqual([{ source: 'runtime', code: 'malformed_record' }]);
    expect(partial.groups.flatMap(group => group.units).map(unit => unit.id)).toEqual(['orbi@2.service']);
    expect(JSON.stringify(partial)).not.toContain('nginx.service');

    const busFailure = parse(await reader({ runtime: new ReadError('process_failed'), installed }).read({}));
    expect(busFailure.state).toBe('partial');
    expect(busFailure.sources[0]).toMatchObject({ source: 'runtime', state: 'unavailable', problems: [{ source: 'runtime', code: 'process_failed' }] });
    expect(busFailure.sources[1]).toMatchObject({ source: 'installed', state: 'complete' });
    expect(busFailure.groups.find(group => group.label === 'orbi-demo')?.units.find(unit => unit.id === 'orbi-demo@.timer')?.runtime).toBeNull();

    // One readable-but-empty source and one failed source is not a confirmed zero.
    const missing = parse(await reader({ runtime: '', installed: new ReadError('process_timeout') }).read({}));
    expect(missing).toMatchObject({ state: 'partial', groups: [], problems: [{ source: 'installed', code: 'process_timeout' }] });
    expect(missing.sources[1]).toMatchObject({ source: 'installed', state: 'unavailable' });

    const capped = parse(await reader({ runtime: new ReadError('read_limit'), installed: new ReadError('process_limit') }).read({}));
    expect(capped).toMatchObject({ state: 'unavailable', groups: [], problems: [{ source: 'runtime', code: 'read_limit' }, { source: 'installed', code: 'process_limit' }] });

    const denied = parse(await reader({ runtime: new ReadError('process_failed'), installed: new ReadError('process_failed') }).read({}));
    expect(denied).toMatchObject({ state: 'unavailable', groups: [] });
  });

  it('caps accepted rows at 256 with deterministic retained order and no invented total', async () => {
    const ids = Array.from({ length: ROW_LIMIT + 44 }, (_, index) => 'orbi@' + (index + 1) + '.service' + ' loaded active running Orbi Runner');
    const result = parse(await reader({ runtime: ids.join('\n'), installed: '' }).read({}));
    expect(result.state).toBe('partial');
    expect(result.problems).toContainEqual({ source: 'host', code: 'row_limit' });
    const units = result.groups.flatMap(group => group.units);
    expect(units).toHaveLength(ROW_LIMIT);
    const sorted = [...units].map(unit => unit.id).sort();
    expect(units.map(unit => unit.id)).toEqual(sorted);
    expect(JSON.stringify(result)).not.toMatch(/total|expected/i);
  });

  it('shares one overall deadline and never launches the second read after it', async () => {
    let now = new Date('2026-11-14T23:00:00Z').getTime();
    const calls: string[] = [];
    const read = createServiceInventory({ enabled: true, claims: () => [], port: {
      clock: () => new Date(now),
      hostInventory: vi.fn(async (operation: 'runtime' | 'installed', timeoutMs?: number) => {
        calls.push(operation + ':' + timeoutMs);
        now += OVERALL_DEADLINE_MS;
        return 'orbi@1.service loaded active running Orbi Runner\n';
      }),
    } });
    const result = parse(await read({}));
    expect(calls).toEqual(['runtime:10000']);
    expect(result).toMatchObject({ state: 'partial', sources: [
      { source: 'runtime', state: 'complete' },
      { source: 'installed', state: 'unavailable', problems: [{ source: 'installed', code: 'deadline' }] },
    ] });
    expect(result.groups[0].units.map(unit => unit.id)).toEqual(['orbi@1.service']);
  });

  it('coalesces concurrent callers into one bounded snapshot cached for 30 seconds', async () => {
    let now = new Date('2026-11-14T23:00:00Z').getTime();
    const hostInventory = vi.fn(async (operation: 'runtime' | 'installed') => operation === 'runtime' ? runtime : installed);
    const read = createServiceInventory({ enabled: true, claims: () => [], port: { clock: () => new Date(now), hostInventory } });
    const [first, second] = await Promise.all([read({}), read({})]);
    expect(first).toBe(second);
    expect(hostInventory).toHaveBeenCalledTimes(2);
    expect((await read({})).state).toBe('complete');
    expect(hostInventory).toHaveBeenCalledTimes(2);
    now += SNAPSHOT_TTL_MS;
    expect((await read({})).state).toBe('complete');
    expect(hostInventory).toHaveBeenCalledTimes(4);
  });

  it('drops a paused read and never launches the second source once monitoring is revoked', async () => {
    const calls: string[] = [];
    const grant = new AbortController();
    let releaseRuntime!: (value: string) => void;
    const read = createServiceInventory({ enabled: true, claims: () => [], signal: grant.signal, port: {
      clock: () => new Date('2026-11-14T23:00:00Z'),
      hostInventory: vi.fn((operation: 'runtime' | 'installed') => {
        calls.push(operation);
        return operation === 'runtime'
          ? new Promise<string>(resolve => { releaseRuntime = resolve; })
          : Promise.resolve(installed);
      }),
    } });
    const pending = read({});
    expect(calls).toEqual(['runtime']);
    // The operator revokes monitoring while the runtime read is still paused.
    grant.abort();
    releaseRuntime(runtime); // late data arrives after revocation
    const result = parse(await pending);
    expect(result).toEqual(OFF);
    // Late data is neither returned nor cached and the installed read never starts.
    expect(JSON.stringify(result)).not.toMatch(/orbi@|orbi-demo|orbi-exporter/);
    expect(calls).toEqual(['runtime']);
    // Every later request while off answers without touching the host again.
    expect(parse(await read({}))).toEqual(OFF);
    expect(calls).toEqual(['runtime']);
  });

  it('discards a cached snapshot when monitoring is revoked', async () => {
    const stub = stubPort();
    const grant = new AbortController();
    const read = createServiceInventory({ enabled: true, claims: () => [], signal: grant.signal, port: stub.port });
    expect(parse(await read({})).state).toBe('complete');
    expect(stub.calls).toEqual(['runtime', 'installed']);
    grant.abort();
    const after = parse(await read({}));
    expect(after).toEqual(OFF);
    expect(JSON.stringify(after)).not.toMatch(/orbi-demo|orbi@1\.service/);
    expect(stub.calls).toEqual(['runtime', 'installed']);
  });

  it('associates only a unique exact validated prefix; unsupported profiles stay display-only', async () => {
    const demo = await fixture(); cleanups.push(demo.cleanup);
    const core = await fixture(); cleanups.push(core.cleanup);
    await writeFile(core.configPath, core.toml.replace('Example/project', 'Other/repo').replace('unit_name = "demo"', 'unit_name = "core"'));
    await writeFile(join(core.source, 'src/orbi/config.py'), '# changed unsupported source\n');
    await demo.save([demo.entry, { ...core.entry, id: 'core', label: 'Core', repo: 'Other/repo' }]);
    const repository = await ConfigRepository.load(demo.authorization);
    expect(repository.catalog().entries.map(entry => entry.status)).toEqual(['available', 'unsupported_source_profile']);
    expect(() => repository.resolve('core')).toThrow('deployment_unavailable');
    const result = parse(await reader({ runtime, installed }, () => repository.unitClaims()).read({}));
    const group = (label: string) => result.groups.find(entry => entry.label === label)!;
    expect(group('orbi-demo')).toMatchObject({ association: 'matched', deploymentId: 'demo' });
    expect(group('orbi-demo').units.map(unit => unit.id)).toContain('orbi-demo@1.service');
    const unsupported = parse(await reader({ runtime: 'orbi-core@1.service loaded active running Orbi\n', installed: 'orbi-core@.service enabled\n' }, () => repository.unitClaims()).read({}));
    expect(unsupported.groups.find(entry => entry.label === 'orbi-core')).toMatchObject({ association: 'incompatible', deploymentId: null });
    expect(unsupported.groups.find(entry => entry.label === 'orbi-core')?.units).toHaveLength(2);
    expect(group('orbi')).toMatchObject({ association: 'unmatched', deploymentId: null });
  });

  it('suppresses linking on duplicate prefixes and rejected, unvalidated configuration', async () => {
    const demo = await fixture(); cleanups.push(demo.cleanup);
    const collision = await fixture(); cleanups.push(collision.cleanup);
    await writeFile(collision.configPath, collision.toml.replace('Example/project', 'Other/repo'));
    await writeFile(join(collision.source, 'src/orbi/config.py'), '# changed unsupported source\n');
    await demo.save([demo.entry, { ...collision.entry, id: 'collision', label: 'Collision', repo: 'Other/repo' }]);
    const repository = await ConfigRepository.load(demo.authorization);
    expect(repository.catalog().entries.map(entry => entry.status)).toEqual(['available', 'unsupported_source_profile']);
    const result = parse(await reader({ runtime, installed }, () => repository.unitClaims()).read({}));
    expect(result.groups.find(entry => entry.label === 'orbi-demo')).toMatchObject({ association: 'ambiguous', deploymentId: null });

    // A rejected TOML entry never becomes a claim and never borrows a runner.
    const rejected = await fixture(); cleanups.push(rejected.cleanup);
    await writeFile(rejected.configPath, rejected.toml.replace('max_concurrency = 2', 'max_concurrency = 9'));
    await rejected.save([rejected.entry]);
    const rejectedRepository = await ConfigRepository.load(rejected.authorization);
    expect(rejectedRepository.catalog().entries[0]).toMatchObject({ status: 'invalid_config' });
    expect(rejectedRepository.unitClaims()).toEqual([]);
    const unmatched = parse(await reader({ runtime, installed }, () => rejectedRepository.unitClaims()).read({}));
    expect(unmatched.groups.every(group => group.association === 'unmatched' && group.deploymentId === null)).toBe(true);
  });
});

describe('host_inventory_port', () => {
  async function portFixture(script: string) {
    const f = await fixture(); cleanups.push(f.cleanup);
    const bin = join(f.root, 'bin'); await mkdir(bin);
    const path = join(bin, 'systemctl');
    await writeFile(path, `#!${process.execPath}\n${script}`);
    await chmod(path, 0o755);
    vi.stubEnv('PATH', bin);
    const ports = new ReadPorts(await ConfigRepository.load(f.authorization));
    cleanups.push(() => ports.dispose());
    return ports;
  }

  it('executes the two exact fixed argv forms without a shell and with a fixed C locale', async () => {
    const ports = await portFixture('console.log(JSON.stringify({args:process.argv.slice(2),stdin:require("node:fs").fstatSync(0).isCharacterDevice(),env:[process.env.LC_ALL,process.env.LANG,process.env.SYSTEMD_COLORS]}))');
    const loaded = JSON.parse(await ports.hostInventory('runtime'));
    expect(loaded.args).toEqual(['--user', 'list-units', '--all', '--type=service,timer', '--plain', '--no-legend', '--no-pager', '--full', 'orbi*.service', 'orbi*.timer']);
    expect(loaded.env).toEqual(['C', 'C', '0']);
    expect(loaded.stdin).toBe(true);
    const files = JSON.parse(await ports.hostInventory('installed'));
    expect(files.args).toEqual(['--user', 'list-unit-files', '--type=service,timer', '--no-legend', '--no-pager', '--full', 'orbi*.service', 'orbi*.timer']);
    // Literal globs stay single argv elements: a shell would have expanded them.
    expect(loaded.args.filter((arg: string) => arg.includes('*'))).toEqual(['orbi*.service', 'orbi*.timer']);
    await expect(ports.hostInventory('shell' as never)).rejects.toThrow('unsafe_path');
  });

  it('bounds two children, times out and reaps on disposal', async () => {
    const ports = await portFixture('setInterval(()=>{},1000)');
    vi.useFakeTimers();
    const first = ports.hostInventory('runtime');
    const second = ports.hostInventory('installed');
    const timedOut = Promise.all([expect(first).rejects.toThrow('process_timeout'), expect(second).rejects.toThrow('process_timeout')]);
    await expect(ports.hostInventory('runtime')).rejects.toThrow('process_limit');
    await vi.advanceTimersByTimeAsync(10000);
    await timedOut;
    const pending = ports.hostInventory('runtime');
    const disposed = expect(pending).rejects.toThrow('disposed');
    await ports.dispose();
    await disposed;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('host_inventory_registration', () => {
  it('answers off with zero host reads after the plugin grant is revoked by disposal', async () => {
    const f = await fixture(); cleanups.push(f.cleanup);
    vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
    vi.stubEnv('PASEO_ORBI_HOST_INVENTORY', '1');
    const hostInventory = vi.spyOn(ReadPorts.prototype, 'hostInventory').mockResolvedValue(runtime);
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    const dispose = contribute({ handle: (contract: { name: string }, handler: (input: unknown) => Promise<unknown>) => { handlers.set(contract.name, handler); } } as unknown as PluginServerContext);
    const read = handlers.get('services.inventory')!;
    expect(parse(await read({})).state).toBe('complete');
    expect(hostInventory).toHaveBeenCalledTimes(2);
    // Disabling/removing/reloading the plugin (or stopping the daemon) revokes the grant.
    await dispose();
    const after = parse(await read({}));
    expect(after).toEqual(OFF);
    expect(hostInventory).toHaveBeenCalledTimes(2);
  });

  it('registers services.inventory and snapshots the startup opt-in', async () => {
    const f = await fixture(); cleanups.push(f.cleanup); vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
    const hostInventory = vi.spyOn(ReadPorts.prototype, 'hostInventory');
    const processSpy = vi.spyOn(ReadPorts.prototype, 'process');
    const readSpy = vi.spyOn(ReadPorts.prototype, 'read');
    const register = () => {
      const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
      cleanups.push(contribute({ handle: (contract: { name: string }, handler: (input: unknown) => Promise<unknown>) => { handlers.set(contract.name, handler); } } as unknown as PluginServerContext));
      return handlers.get('services.inventory')!;
    };
    const off = register();
    const offResult = parse(await off({}));
    expect(offResult).toEqual({ state: 'off', observedAt: null, sources: [], groups: [], problems: [] });
    expect(hostInventory).not.toHaveBeenCalled();
    expect(() => servicesInventory.input.parse({ deploymentId: 'demo' })).toThrow();

    vi.stubEnv('PASEO_ORBI_HOST_INVENTORY', '1');
    hostInventory.mockImplementation(async operation => operation === 'runtime' ? runtime : installed);
    const enabled = register();
    vi.stubEnv('PASEO_ORBI_HOST_INVENTORY', '0');
    const result = parse(await enabled({}));
    expect(result.state).toBe('complete');
    expect(result.groups.find(group => group.label === 'orbi-demo')).toMatchObject({ association: 'matched', deploymentId: 'demo' });
    expect(hostInventory).toHaveBeenCalledTimes(2);
    expect(processSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });
});
