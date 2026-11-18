import { afterEach, expect, it, vi } from 'vitest';
import { ConfigRepository } from '../server/config';
import { ReadError, ReadPorts } from '../server/read-ports';
import { mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
vi.mock('node:fs/promises', { spy: true });
import { readFleet } from '../server/fleet';
import { fleetRead } from '../shared/fleet';
import { fixture } from './helpers/fixtures';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
// Pinned runner_health.py fresh_state + record_run_attempt wire format.
const health = { runs: [{ repo: 'Example/project', issue: 3, run_id: 'c7aa0bbb', outcome: 'failed', fingerprint: 'not-for-ui', ts: 1794697200 }], last_pickup_ts: 1794697100, alerted: [] };
const timer = 'LoadState=loaded\nActiveState=active\nSubState=waiting\nUnitFileState=enabled\nLastTriggerUSec=Sat 2026-11-14 22:00:00 UTC\nNextElapseUSecRealtime=Sat 2026-11-14 22:30:00 UTC\n';
const idle = 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=static\nResult=success\nExecMainCode=1\nExecMainStatus=0\n';
it('independent_sources_and_oneshot_state', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const second = await fixture(); cleanups.push(second.cleanup);
  await writeFile(second.configPath, second.toml.replace('Example/project', 'Other/repo'));
  await f.save([f.entry, { ...second.entry, id: 'inaccessible', label: 'Inaccessible', repo: 'Other/repo' }]);
  const repository = await ConfigRepository.load(f.authorization);
  expect(repository.catalog().entries.map(e => e.status)).toEqual(['available', 'available']);
  const ports = {
    clock: () => new Date('2026-11-14T23:00:00Z'),
    read: vi.fn(async id => Buffer.from(id === 'inaccessible' ? '{malformed' : JSON.stringify(health))),
    process: vi.fn(async (id, op) => {
      if (id === 'inaccessible') throw new ReadError('process_failed');
      if (op.slot === 2 && op.unit === 'timer') throw new ReadError('process_failed');
      return op.unit === 'timer' ? timer : idle;
    }),
  };
  const result = fleetRead.output.parse(await readFleet(repository, ports, { deploymentId: 'demo' }));
  expect(result.state).toBe('partial');
  expect(result.data?.units[0]).toMatchObject({ id: 'orbi-demo@1.timer', activeState: 'active', subState: 'waiting' });
  expect(result.data?.units[1]).toMatchObject({ id: 'orbi-demo@1.service', activeState: 'inactive', result: 'success' });
  expect(result.data?.units[2]).toMatchObject({ id: 'orbi-demo@2.timer', activeState: null });
  expect(result.problems).toEqual([{ source: 'systemd', code: 'process_failed' }]);
  expect(result.data?.health?.recentRuns[0]).toMatchObject({ outcome: 'failed', runId: 'c7aa0bbb' });
  expect(result.data?.occupancy).toBeNull();
  expect(JSON.stringify(result)).not.toMatch(/fingerprint|not-for-ui|alerted/);
  const inaccessible = fleetRead.output.parse(await readFleet(repository, ports, { deploymentId: 'inaccessible' }));
  expect(inaccessible).toMatchObject({ state: 'unavailable', data: { configuredCapacity: 2, occupancy: null, health: null } });
  expect(inaccessible.problems).toEqual([{ source: 'systemd', code: 'process_failed' }, { source: 'filesystem', code: 'read_failed' }]);
  expect(result.data?.units[1].result).toBe('success');
});

it.each(['release', 'installed'] as const)('validates pinned %s health and keeps failures separate from unit state', async profile => {
  const f = await fixture(profile); cleanups.push(f.cleanup);
  const repository = await ConfigRepository.load(f.authorization);
  for (const content of [undefined, '{bad', '{}', JSON.stringify({ ...health, last_pickup_ts: true }), JSON.stringify({ ...health, runs: [{}] }), JSON.stringify({ ...health, runs: Array(51).fill(health.runs[0]) })]) {
    const ports = {
      clock: () => new Date('2026-11-14T23:00:00Z'),
      read: vi.fn(async () => { if (content === undefined) throw new ReadError('read_failed'); return Buffer.from(content); }),
      process: vi.fn(async (_id, op) => op.slot === 1 ? (op.unit === 'timer' ? timer : 'LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\n') : 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nEnvironment=SECRET\n'),
    };
    const result = await readFleet(repository, ports, { deploymentId: 'demo' });
    expect(result).toMatchObject({ state: 'partial', data: { health: null } });
    expect(result.data?.units[1]).toMatchObject({ activeState: 'failed', result: 'exit-code' });
    expect(result.data?.units[2]).toMatchObject({ loadState: 'not-found', problems: [{ source: 'systemd', code: 'read_failed' }] });
    expect(result.problems).toContainEqual({ source: 'filesystem', code: 'read_failed' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  }
  const ports = { clock: () => new Date(), process: vi.fn(async () => 'Id=unrelated.service\nActiveState=SECRET\n'), read: vi.fn(async () => Buffer.from('null')) };
  const unavailable = await readFleet(repository, ports, { deploymentId: 'demo' });
  expect(unavailable).toMatchObject({ state: 'unavailable', lastSuccessfulAt: null, data: { health: null } });
  expect(unavailable.data?.units.every(u => u.activeState === null)).toBe(true);
  await expect(readFleet(repository, ports, { deploymentId: 'unauthorized' })).rejects.toThrow('deployment_unavailable');
  expect(ports.process).toHaveBeenCalledTimes(4);
  expect(() => fleetRead.input.parse({ deploymentId: 'demo', command: 'start' })).toThrow();
});

it.each([null, 'demo'])('capacity_is_not_occupancy (%s unit name)', async unitName => {
  const f = await fixture(); cleanups.push(f.cleanup);
  await writeFile(f.configPath, f.toml.replace('max_concurrency = 2', 'max_concurrency = 5').replace('unit_name = "demo"\n', unitName ? 'unit_name = "demo"\n' : ''));
  await mkdir(join(f.repoDir, '.orbi'));
  for (const name of ['runner.lock', 'runner.pid', 'active-labels.json']) await writeFile(join(f.repoDir, '.orbi', name), 'misleading active occupancy 5');
  await writeFile(join(f.repoDir, '.orbi/health.json'), JSON.stringify(health));
  const repository = await ConfigRepository.load(f.authorization);
  const bin = join(f.root, 'bin'), log = join(f.root, 'argv.jsonl'); await mkdir(bin);
  // The real bounded process port executes this inert stand-in, not live systemd.
  await writeFile(join(bin, 'systemctl'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n'); console.log(${JSON.stringify(idle)});`);
  await chmod(join(bin, 'systemctl'), 0o755); vi.stubEnv('PATH', bin);
  const ports = new ReadPorts(repository); cleanups.push(() => ports.dispose());
  const opened = vi.spyOn(filesystem, 'open'); opened.mockClear();
  const result = fleetRead.output.parse(await readFleet(repository, ports, { deploymentId: 'demo' }));
  expect(opened.mock.calls.map(([path]) => path)).toEqual([join(f.repoDir, '.orbi/health.json')]);
  expect(result).toMatchObject({ state: 'available', data: { configuredCapacity: 5, occupancy: null } });
  const prefix = unitName === null ? 'orbi' : 'orbi-demo';
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(calls).toEqual(Array.from({ length: 5 }, (_, i) => ['timer', 'service'].map(unit => [
    '--user', 'show', `${prefix}@${i + 1}.${unit}`,
    '--property=Id,LoadState,ActiveState,SubState,UnitFileState,Result,ExecMainCode,ExecMainStatus,NRestarts,LastTriggerUSec,NextElapseUSecRealtime,NextElapseUSecMonotonic', '--no-pager',
  ])).flat());
  expect(JSON.stringify(calls)).not.toMatch(/Environment|ExecStart|flock|start"|stop"|restart"/);
});

import './helpers/host';
import { host } from './helpers/host';
import React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { Shell } from '../client/shell';
import contribute from '../index.server';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { deploymentsList } from '../shared/common';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const props = { theme: { colors: { foreground: '#eee', foregroundMuted: '#aaa', surface0: '#111' } }, host: { id: 'host-a', label: 'Host A' }, layout: { compact: true, platform: 'ios' }, params: {} } as PluginScreenProps;
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2); }); };

it('stale_compact_and_theme', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  const second = await fixture(); cleanups.push(second.cleanup);
  await writeFile(second.configPath, second.toml.replace('Example/project', 'Other/repo'));
  await f.save([f.entry, { ...second.entry, id: 'inaccessible', label: 'Inaccessible', repo: 'Other/repo' }, { ...f.entry, id: 'rejected', label: 'Rejected', repo: 'Rejected/repo' }]);
  const repository = await ConfigRepository.load(f.authorization);
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T23:00:00Z'));
  const ports = { clock: () => new Date(),
    process: vi.fn(async (id, op) => { if (id === 'inaccessible') throw new ReadError('process_failed'); return op.unit === 'timer' ? timer : idle; }),
    read: vi.fn(async id => { if (id === 'inaccessible') throw new ReadError('read_failed'); return Buffer.from(JSON.stringify(health)); }),
  };
  host.readCatalog.mockReset().mockResolvedValue(repository.catalog());
  host.readFleet.mockReset().mockImplementation(input => readFleet(repository, ports, input));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); cleanups.push(() => client.clear());
  const openScreen = vi.fn();
  const tree = (p = props) => <QueryClientProvider client={client}><Shell {...p} route="fleet" openScreen={openScreen} /></QueryClientProvider>;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(tree()); }); cleanups.push(async () => { await act(async () => renderer.unmount()); });
  await settle(); await settle();
  const text = () => renderer.root.findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
  expect(text()).toContain('Demo (Example/project)'); expect(text()).toContain('Inaccessible (Other/repo)'); expect(text()).toContain('Rejected (Rejected/repo)');
  expect(text()).toContain('process_failed'); expect(text()).toContain('Health unavailable');
  expect(text()).toContain('Configured capacity: 2; Occupancy: unknown');
  expect(text()).toContain('Reported outcome: failed'); expect(text()).toContain('Active: inactive');
  expect(host.readFleet.mock.calls.map(([input]) => input.deploymentId).sort()).toEqual(['demo', 'inaccessible']);
  expect(host.readCatalog).toHaveBeenCalledTimes(1);
  expect(renderer.root.findAllByType('ScrollView' as any)).toHaveLength(1);
  expect(host.listeners.size).toBe(1);
  expect(renderer.root.findByType('ScrollView' as any).props.contentContainerStyle.padding).toBe(16);
  expect(renderer.root.findAllByType('Text' as any).every(node => node.props.style.color === '#eee')).toBe(true);
  await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Active work for Demo' }).props.onPress());
  expect(openScreen).toHaveBeenCalledWith({ screenId: 'issues', params: { deploymentId: 'demo' } });
  // A collector reports failed reads as an unavailable observation, not an RPC
  // rejection. This real failure path must retain the last successful snapshot too.
  ports.process.mockRejectedValue(new ReadError('process_failed'));
  ports.read.mockRejectedValue(new ReadError('read_failed'));
  await act(async () => { await renderer.root.findByProps({ testID: 'orbi-fleet' }).findAllByProps({ accessibilityLabel: 'Refresh' })[0].props.onPress(); }); await settle();
  expect(text()).toContain('stale');
  expect(text()).toContain('Reported outcome: failed');
  expect(text()).toContain('Active: inactive');
  expect(text()).toContain('systemd: process_failed');
  expect(text()).toContain('filesystem: read_failed');
  expect(text()).toContain('Last success: 2026-11-14T23:00:00.000Z');
  host.readFleet.mockRejectedValue(new Error('SECRET raw error'));
  const refreshes = renderer.root.findByProps({ testID: 'orbi-fleet' }).findAllByProps({ accessibilityLabel: 'Refresh' });
  await act(async () => { await refreshes[0].props.onPress(); }); await settle();
  expect(text()).toContain('stale'); expect(text()).toContain('refresh_failed');
  expect(text()).toContain('Last success: 2026-11-14T23:00:00.000Z');
  expect(text()).not.toContain('SECRET');
  await act(async () => { for (const listener of host.listeners) listener('background'); await vi.advanceTimersByTimeAsync(60001); }); await settle();
  expect(text()).toContain('stale'); expect(text()).toContain('Observed: 2026-11-14');
  const light = { ...props, layout: { compact: false, platform: 'web' }, theme: { colors: { foreground: '#222', foregroundMuted: '#555', surface0: '#fff' } } } as PluginScreenProps;
  await act(async () => renderer.update(tree(light)));
  expect(renderer.root.findByType('ScrollView' as any).props.contentContainerStyle.padding).toBe(24);
  for (const node of renderer.root.findAllByType('Text' as any)) expect(node.props.style.color).toBe('#222');
});

it('registers fleet.read at the actual server entry with startup authorization', async () => {
  const f = await fixture(); cleanups.push(f.cleanup); vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
  const handlers = new Map<unknown, (input: unknown) => Promise<unknown>>();
  cleanups.push(contribute({ handle: (contract: unknown, handler: (input: unknown) => Promise<unknown>) => { handlers.set(contract, handler); } } as unknown as PluginServerContext));
  expect(handlers.has(deploymentsList)).toBe(true); expect(handlers.has(fleetRead)).toBe(true);
  await expect(handlers.get(fleetRead)!({ deploymentId: 'unauthorized' })).rejects.toThrow('deployment_unavailable');
});

it('repository_change_scopes_fresh_capacity_health_and_failed_refresh', async () => {
  vi.useFakeTimers(); vi.setSystemTime('2026-11-14T23:00:00Z');
  const catalog = (repo: string) => ({ state: 'configured', problems: [], entries: [
    { id: 'demo', label: 'Demo', repo, status: 'available', problems: [] },
  ] });
  const observation = (repo: string, capacity: number, outcome: string) => fleetRead.output.parse({
    state: 'available', observedAt: new Date().toISOString(), lastSuccessfulAt: new Date().toISOString(), problems: [],
    data: { deploymentId: 'demo', repo, profile: 'orbi-0.7.41-release', configuredCapacity: capacity, occupancy: null, units: [],
      health: { lastPickupAt: null, recentRuns: [{ repo, issue: 3, runId: '12345678', outcome, at: new Date().toISOString() }] } },
  });
  const a = observation('Example/project', 2, 'A_HEALTH'), b = observation('Reassigned/project', 5, 'B_HEALTH');
  host.readCatalog.mockReset().mockResolvedValue(catalog('Example/project'));
  host.readFleet.mockReset().mockResolvedValue(a);
  const client = new QueryClient();
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<QueryClientProvider client={client}><Shell {...props} route="fleet" openScreen={vi.fn()} /></QueryClientProvider>); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); client.clear(); });
  await settle(); await settle();
  const text = () => renderer.root.findAllByType('Text' as any).map(n => n.children.join('')).join('\n');
  const setCatalog = async (repo: string) => {
    await act(async () => { client.setQueryData(['paseo-orbi', 'host-a', 'catalog', 'deployments.list'], {
      state: 'available', observedAt: new Date().toISOString(), lastSuccessfulAt: new Date().toISOString(), problems: [], data: catalog(repo),
    }); }); await settle(); await settle();
  };
  expect(text()).toContain('Configured capacity: 2'); expect(text()).toContain('A_HEALTH');
  let reject!: (error: Error) => void;
  host.readFleet.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await setCatalog('Reassigned/project');
  expect(host.readFleet).toHaveBeenCalledTimes(2);
  expect(host.readFleet).toHaveBeenLastCalledWith(fleetRead.input.parse({ deploymentId: 'demo' }));
  expect(text()).toContain('Loading'); expect(text()).not.toContain('Configured capacity: 2'); expect(text()).not.toContain('A_HEALTH');
  await act(async () => reject(new Error('transport unavailable'))); await settle();
  expect(text()).toContain('unavailable'); expect(text()).toContain('filesystem: refresh_failed'); expect(text()).not.toContain('A_HEALTH');
  const refresh = async () => { await act(async () => { await renderer.root.findByProps({ testID: 'orbi-fleet' }).findByProps({ accessibilityLabel: 'Refresh' }).props.onPress(); }); await settle(); };
  host.readFleet.mockResolvedValue(b); await refresh();
  expect(text()).toContain('Configured capacity: 5'); expect(text()).toContain('B_HEALTH');
  host.readFleet.mockRejectedValue(new Error('transport unavailable')); await refresh();
  expect(text()).toContain('stale'); expect(text()).toContain('B_HEALTH'); expect(text()).not.toContain('A_HEALTH');
  // Returning to the same fresh identity must still reuse its cache, not clear it.
  const calls = host.readFleet.mock.calls.length;
  await setCatalog('Example/project');
  expect(text()).toContain('A_HEALTH'); expect(text()).not.toContain('B_HEALTH');
  expect(host.readFleet).toHaveBeenCalledTimes(calls);
});
