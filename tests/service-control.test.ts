import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import contribute from '../index.server';
import { ConfigRepository } from '../server/config';
import { ReadPorts } from '../server/read-ports';
import { createServiceControl, executeControl, type ControlPort, type ControlRun } from '../server/service-control';
import { servicesControl } from '../shared/service-control';
import type { ControlAction } from '../shared/common';
import { fixture } from './helpers/fixtures';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const setup = async () => { const f = await fixture(); cleanups.push(f.cleanup); return f; };

const idle = 'LoadState=loaded\nActiveState=inactive\nSubState=dead\n';
const running = 'LoadState=loaded\nActiveState=active\nSubState=running\n';
const failed = 'LoadState=loaded\nActiveState=failed\nSubState=failed\n';
// A real absolute argv, used only to prove the adapter passes the operator's
// exact tokens; the adapter never builds one itself.
const argv = [process.execPath, '-e', 'process.exit(0)', '{unit}'];
const grant = (actions: ControlAction[] = ['start', 'stop', 'restart'], command: string[] = argv) => ({
  admittedClientsOperate: true as const, actions,
  commands: Object.fromEntries(actions.map(action => [action, command])),
});
async function loaded(options: { controls?: unknown } = {}) {
  const f = await setup();
  await f.save([{ ...f.entry, ...(options.controls === undefined ? {} : { controls: options.controls }) }]);
  return { f, repository: await ConfigRepository.load(f.authorization) };
}
function port(options: { run?: () => ControlRun; show?: () => string } = {}) {
  const runs: string[][] = [];
  const shows: Array<[string, number]> = [];
  const control: ControlPort = {
    now: () => new Date('2026-11-21T00:00:00.000Z'),
    run: vi.fn(async (tokens: readonly string[]): Promise<ControlRun> => { runs.push([...tokens]); return options.run?.() ?? { state: 'exited', code: 0 }; }),
    show: vi.fn(async (deploymentId: string, slot: number) => { shows.push([deploymentId, slot]); return options.show?.() ?? idle; }),
  };
  return { port: control, runs, shows };
}

describe('operator-granted service controls', () => {
  it('reaches only the exact approved target of the approved deployment', async () => {
    const { repository } = await loaded({ controls: grant() });
    const first = port();
    const control = createServiceControl({ repository, port: first.port });
    const started = await control({ deploymentId: 'demo', slot: 2, action: 'start' });
    expect(started).toMatchObject({ outcome: 'succeeded', reason: null, deploymentId: 'demo', slot: 2, action: 'start', actor: null });
    expect(first.runs).toEqual([[process.execPath, '-e', 'process.exit(0)', 'orbi-demo@2.service']]);
    expect(first.shows).toEqual([['demo', 2]]);
    const second = port();
    await createServiceControl({ repository, port: second.port })({ deploymentId: 'demo', slot: 1, action: 'stop' });
    expect(second.runs).toEqual([[process.execPath, '-e', 'process.exit(0)', 'orbi-demo@1.service']]);
  });

  it('denies viewer, forged, unknown, stale, revoked and unapproved requests before mutation', async () => {
    // No operator grant at all: monitoring still works, controls do not exist.
    const unapproved = await loaded();
    const none = port();
    expect(await createServiceControl({ repository: unapproved.repository, port: none.port })({ deploymentId: 'demo', slot: 1, action: 'start' }))
      .toMatchObject({ outcome: 'denied', reason: 'action_not_approved', observed: null, finishedAt: null });
    expect(unapproved.repository.catalog().entries[0].controls).toBeNull();
    expect(none.runs).toHaveLength(0);

    // Only start is granted: stop on the same exact target is still denied.
    const { repository } = await loaded({ controls: grant(['start']) });
    const partial = port();
    const control = createServiceControl({ repository, port: partial.port });
    expect(await control({ deploymentId: 'demo', slot: 1, action: 'stop' })).toMatchObject({ outcome: 'denied', reason: 'action_not_approved' });
    // Unknown/foreign deployment id, out-of-range and non-integer slots.
    for (const request of [
      { deploymentId: 'other', slot: 1, action: 'start' as const },
      { deploymentId: 'Demo', slot: 1, action: 'start' as const },
      { deploymentId: 'demo', slot: 3, action: 'start' as const },
      { deploymentId: 'demo', slot: 0, action: 'start' as const },
      { deploymentId: 'demo', slot: 1.5, action: 'start' as const },
    ]) {
      expect(await control(request)).toMatchObject({ outcome: 'denied' });
    }
    expect(partial.runs).toHaveLength(0);
    // A withdrawn grant refuses before any execution.
    const aborted = new AbortController(); aborted.abort();
    const revoked = port();
    expect(await createServiceControl({ repository, port: revoked.port, signal: aborted.signal })({ deploymentId: 'demo', slot: 1, action: 'start' }))
      .toMatchObject({ outcome: 'denied', reason: 'disposed' });
    expect(revoked.runs).toHaveLength(0);
    // Every denial names a bounded reason vocabulary and never leaks the argv.
    expect(JSON.stringify(await control({ deploymentId: 'demo', slot: 1, action: 'stop' }))).not.toContain(process.execPath);
  });

  it('rechecks the operator grant immediately before execution', async () => {
    const { repository } = await loaded({ controls: grant(['restart']) });
    const lifetime = new AbortController();
    const subject = port({ show: () => { lifetime.abort(); return failed; } });
    const control = createServiceControl({ repository, port: subject.port, signal: lifetime.signal });
    expect(await control({ deploymentId: 'demo', slot: 1, action: 'restart' })).toMatchObject({ outcome: 'denied', reason: 'disposed' });
    expect(subject.runs).toHaveLength(0);
  });

  it('never restarts a slot that may have an active delivery', async () => {
    const { repository } = await loaded({ controls: grant(['restart']) });
    for (const state of [running, 'LoadState=loaded\nActiveState=activating\nSubState=start\n', 'LoadState=loaded\nActiveState=deactivating\nSubState=stop\n', 'LoadState=not-found\nActiveState=inactive\nSubState=dead\n']) {
      const subject = port({ show: () => state });
      expect(await createServiceControl({ repository, port: subject.port })({ deploymentId: 'demo', slot: 1, action: 'restart' }))
        .toMatchObject({ outcome: 'denied', reason: 'active_delivery' });
      expect(subject.runs).toHaveLength(0);
    }
    // Unreadable state is refused rather than assumed safe.
    const unknown = port({ show: () => { throw new Error('process_failed'); } });
    expect(await createServiceControl({ repository, port: unknown.port })({ deploymentId: 'demo', slot: 1, action: 'restart' }))
      .toMatchObject({ outcome: 'denied', reason: 'observe_failed' });
    expect(unknown.runs).toHaveLength(0);
    // An idle or failed slot may restart through the operator's own lifecycle command.
    for (const state of [idle, failed]) {
      const subject = port({ show: () => state });
      expect(await createServiceControl({ repository, port: subject.port })({ deploymentId: 'demo', slot: 1, action: 'restart' }))
        .toMatchObject({ outcome: 'succeeded' });
      expect(subject.runs).toHaveLength(1);
    }
  });

  it('serializes conflicting operations per deployment without duplicating them', async () => {
    const { repository } = await loaded({ controls: grant(['start', 'stop']) });
    let release!: (run: ControlRun) => void;
    const runs: string[][] = [];
    const subject: ControlPort = {
      now: () => new Date('2026-11-21T00:00:00.000Z'),
      run: vi.fn((tokens: readonly string[]) => { runs.push([...tokens]); return new Promise<ControlRun>(resolve => { release = resolve; }); }),
      show: vi.fn(async () => idle),
    };
    const control = createServiceControl({ repository, port: subject });
    const first = control({ deploymentId: 'demo', slot: 1, action: 'start' });
    const second = await control({ deploymentId: 'demo', slot: 1, action: 'stop' });
    expect(second).toMatchObject({ outcome: 'pending', reason: 'busy', observed: null, finishedAt: null });
    expect(runs).toHaveLength(1);
    release({ state: 'exited', code: 0 });
    expect(await first).toMatchObject({ outcome: 'succeeded' });
    // The deployment is free again, so a later explicit action is not blocked.
    const third = control({ deploymentId: 'demo', slot: 1, action: 'stop' });
    await Promise.resolve(); await Promise.resolve();
    expect(runs).toHaveLength(2);
    release({ state: 'exited', code: 0 });
    expect(await third).toMatchObject({ outcome: 'succeeded' });
  });

  it('never reports unobserved success and never retries an uncertain mutation', async () => {
    const { repository } = await loaded({ controls: grant(['start']) });
    const cases: Array<[() => ControlRun, () => string, string, string]> = [
      [() => ({ state: 'exited', code: 0 }), () => idle, 'succeeded', ''],
      [() => ({ state: 'exited', code: 0 }), () => { throw new Error('read_failed'); }, 'unknown', 'observe_failed'],
      [() => ({ state: 'timeout' }), () => idle, 'unknown', 'process_timeout'],
      [() => ({ state: 'exited', code: 3 }), () => idle, 'failed', 'process_failed'],
      [() => ({ state: 'unavailable' }), () => idle, 'failed', 'process_failed'],
      [() => ({ state: 'limited' }), () => idle, 'failed', 'process_limit'],
    ];
    for (const [run, show, outcome, reason] of cases) {
      const subject = port({ run, show });
      const result = await createServiceControl({ repository, port: subject.port })({ deploymentId: 'demo', slot: 1, action: 'start' });
      expect(result.outcome, outcome + '/' + reason).toBe(outcome);
      expect(result.reason).toBe(reason === '' ? null : reason);
      // Exactly one submission: a timeout or a failed read is never retried here.
      expect(subject.runs).toHaveLength(1);
    }
  });

  it('exposes only the approved capability, never the lifecycle command', async () => {
    const { repository } = await loaded({ controls: grant(['start', 'stop']) });
    expect(repository.catalog().entries[0].controls).toEqual({ actions: ['start', 'stop'], slots: 2 });
    expect(JSON.stringify(repository.catalog())).not.toContain(process.execPath);
    expect(JSON.stringify(repository.catalog())).not.toContain('{unit}');
  });

  it('rejects a control grant it cannot bind exactly', async () => {
    for (const controls of [
      { actions: ['start'], commands: { start: argv } },
      { admittedClientsOperate: false, actions: ['start'], commands: { start: argv } },
      { admittedClientsOperate: true, actions: ['start'], commands: {} },
      { admittedClientsOperate: true, actions: ['start'], commands: { start: [process.execPath, '-e', 'process.exit(0)'] } },
      { admittedClientsOperate: true, actions: ['start'], commands: { start: [process.execPath, '-e', 'process.exit(0)', '{unit}', '{unit}'] } },
      { admittedClientsOperate: true, actions: ['start'], commands: { start: [process.execPath, '-e', 'process.exit(0)', '{other}'] } },
      { admittedClientsOperate: true, actions: ['start'], commands: { start: ['node', '-e', 'process.exit(0)', '{unit}'] } },
      { admittedClientsOperate: true, actions: ['start'], commands: { start: argv, stop: argv } },
      { admittedClientsOperate: true, actions: ['start', 'start'], commands: { start: argv } },
      { admittedClientsOperate: true, actions: ['start'], commands: { start: argv }, extra: true },
    ]) {
      const f = await setup();
      await f.save([{ ...f.entry, ...(controls === undefined ? {} : { controls }) }]);
      const catalog = (await ConfigRepository.load(f.authorization)).catalog();
      expect(catalog.entries[0], JSON.stringify(controls)).toMatchObject({ status: 'invalid_config', controls: null });
    }
    // A malformed grant is an entry-local error, not a silent read-only downgrade.
    const f = await setup();
    await writeFile(f.authorization, JSON.stringify({ schema: 1, deployments: [{ ...f.entry, controls: { admittedClientsOperate: true, actions: ['start'], commands: { start: ['relative', '{unit}'] } } }] }));
    const repository = await ConfigRepository.load(f.authorization);
    expect(repository.controlGrant('demo', 'start', 1)).toEqual({ ok: false, reason: 'deployment_unavailable' });
  });

  it('serves the registered RPC through the real configuration, adapter and bounded read port', async () => {
    const f = await setup();
    await f.save([{ ...f.entry, controls: { admittedClientsOperate: true, actions: ['start'], commands: { start: [process.execPath, '-e', 'process.exit(0)', '{unit}'] } } }]);
    vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
    let handler: ((input: unknown) => Promise<unknown>) | undefined;
    cleanups.push(contribute({ handle: (contract: unknown, fn: (input: unknown) => Promise<unknown>) => { if (contract === servicesControl) handler = fn; } } as unknown as PluginServerContext));
    const read = vi.spyOn(ReadPorts.prototype, 'process').mockImplementation(async (id, operation) => {
      expect(id).toBe('demo');
      expect(operation).toMatchObject({ kind: 'systemctl-show', slot: 2, unit: 'service' });
      return idle;
    });
    cleanups.push(() => read.mockRestore());
    const result = servicesControl.output.parse(await handler!(servicesControl.input.parse({ deploymentId: 'demo', slot: 2, action: 'start' })));
    expect(result).toMatchObject({
      outcome: 'succeeded', reason: null, deploymentId: 'demo', slot: 2, action: 'start', actor: null,
      observed: { loadState: 'loaded', activeState: 'inactive', subState: 'dead' },
    });
    expect(JSON.stringify(result)).not.toContain(process.execPath);
  });

  it('accepts only a deployment, an approved slot and an approved action from a caller', () => {
    expect(servicesControl.input.parse({ deploymentId: 'demo', slot: 1, action: 'restart' })).toEqual({ deploymentId: 'demo', slot: 1, action: 'restart' });
    for (const input of [
      { deploymentId: 'demo', slot: 1, action: 'reload' },
      { deploymentId: 'demo', slot: 6, action: 'start' },
      { deploymentId: 'demo', slot: 0, action: 'start' },
      { deploymentId: 'demo', slot: 1, action: 'start', unit: 'orbi-demo@9.service' },
      { deploymentId: 'demo', slot: 1, action: 'start', command: ['systemctl', 'restart'] },
      { deploymentId: 'Demo', slot: 1, action: 'start' },
      { deploymentId: 'demo', action: 'start' },
    ]) expect(() => servicesControl.input.parse(input), JSON.stringify(input)).toThrow();
  });
});

describe('bounded mutation execution', () => {
  it('runs the exact operator argv without a shell and returns only the exit fact', async () => {
    const ok = await executeControl([process.execPath, '-e', 'process.exit(0)', 'orbi-demo@1.service']);
    expect(ok).toEqual({ state: 'exited', code: 0 });
    const failedRun = await executeControl([process.execPath, '-e', 'process.exit(7)', 'orbi-demo@1.service']);
    expect(failedRun).toEqual({ state: 'exited', code: 7 });
    // Shell metacharacters are inert: they are separate argv tokens, not a command line.
    const literal = await executeControl([process.execPath, '-e', 'process.exit(0)', '; rm -rf /tmp/orbi-should-never-run $HOME `id`']);
    expect(literal).toEqual({ state: 'exited', code: 0 });
    expect(Object.keys(ok).sort()).toEqual(['code', 'state']);
  });

  it('bounds an unresponsive lifecycle command and reports it without proof of cancellation', async () => {
    const started = Date.now();
    const run = await executeControl([process.execPath, '-e', 'setTimeout(()=>{}, 30000)'], 200);
    expect(run).toEqual({ state: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reports a start failure as unavailable and refuses an unbounded ceiling', async () => {
    expect(await executeControl(['/nonexistent/orbi-lifecycle', 'start'])).toEqual({ state: 'unavailable' });
    expect(await executeControl([process.execPath, '-e', 'process.exit(0)'], 0)).toEqual({ state: 'limited' });
    expect(await executeControl([process.execPath, '-e', 'process.exit(0)'], 20000)).toEqual({ state: 'limited' });
    expect(await executeControl([])).toEqual({ state: 'limited' });
  });
});
