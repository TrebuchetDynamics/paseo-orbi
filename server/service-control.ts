import { spawn, type ChildProcess } from 'node:child_process';
import type { ConfigRepository } from './config';
import { activeStates, loadStates, subStates } from '../shared/services';
import type { ControlAction } from '../shared/common';
import type { ControlObservation, ControlReason, ServiceControlResult } from '../shared/service-control';

// Separate, narrow mutation adapter. It is deliberately not part of the read
// port: nothing here can read a deployment file, list worktrees or run a
// GitHub request, and no caller input reaches the child other than an approved
// action on an approved slot. Orbi lifecycle semantics (scheduler ownership,
// draining, pauses) stay in the operator-bound lifecycle command; this adapter
// never invents systemctl mutation argv, never uses a shell and never retries.

export const CONTROL_TIMEOUT_MS = 10000;
export const MAX_CONTROL_CHILDREN = 2;

// What the bounded child actually proved. 'timeout' is not proof the submitted
// job was cancelled, so the caller may never report it as success.
export type ControlRun =
  | Readonly<{ state: 'exited'; code: number }>
  | Readonly<{ state: 'timeout' }>
  | Readonly<{ state: 'unavailable' }>
  | Readonly<{ state: 'limited' }>;

let children = 0;

function killGroup(child: ChildProcess) {
  // Linux: the child leads its own process group, so helpers it spawned cannot
  // keep running after the approved command is abandoned.
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* group already gone */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already exited */ }
}

// Fixed-argv bounded execution: no shell, stdin ignored, output never retained
// or transported, at most MAX_CONTROL_CHILDREN at a time, and the whole process
// group is killed at the ceiling.
export function executeControl(argv: readonly string[], timeoutMs = CONTROL_TIMEOUT_MS): Promise<ControlRun> {
  if (argv.length === 0 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CONTROL_TIMEOUT_MS || children >= MAX_CONTROL_CHILDREN) {
    return Promise.resolve({ state: 'limited' });
  }
  children++;
  return new Promise<ControlRun>(resolve => {
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (run: ControlRun) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      children--;
      resolve(run);
    };
    try {
      child = spawn(argv[0], argv.slice(1), { shell: false, detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
    } catch { finish({ state: 'unavailable' }); return; }
    timer = setTimeout(() => { killGroup(child!); finish({ state: 'timeout' }); }, timeoutMs);
    child.once('error', () => finish({ state: 'unavailable' }));
    child.once('close', code => finish(code === null ? { state: 'unavailable' } : { state: 'exited', code }));
  });
}

export type ControlPort = Readonly<{
  now(): Date;
  run(argv: readonly string[], timeoutMs: number): Promise<ControlRun>;
  // Bounded read of the exact deployment unit through the existing read port.
  // The adapter passes only the validated deployment id and slot.
  show(deploymentId: string, slot: number): Promise<string>;
}>;

export type ServiceControlInput = Readonly<{ deploymentId: string; slot: number; action: ControlAction }>;
export type ServiceControl = (input: ServiceControlInput) => Promise<ServiceControlResult>;

function known<T extends string>(values: readonly T[], value: string | undefined): T | 'unknown' {
  return value !== undefined && (values as readonly string[]).includes(value) ? value as T : 'unknown';
}
// Only the three closed vocabularies are read; the rest of systemctl's output is
// never stored, parsed further or transported.
function observationOf(output: string): ControlObservation {
  const fields = new Map<string, string>();
  for (const line of output.split('\n')) {
    const equal = line.indexOf('=');
    if (equal > 0) fields.set(line.slice(0, equal), line.slice(equal + 1));
  }
  return {
    loadState: known(loadStates, fields.get('LoadState')),
    activeState: known(activeStates, fields.get('ActiveState')),
    subState: known(subStates, fields.get('SubState')),
  };
}
// A restart may only run from a slot that cannot be delivering work. Anything
// else (active, activating, stopping, maintenance, unknown) is refused before
// execution, so a restart never becomes an undocumented kill.
function restartable(observed: ControlObservation): boolean {
  return observed.activeState === 'failed'
    || (observed.activeState === 'inactive' && observed.subState === 'dead' && observed.loadState !== 'not-found');
}

export function createServiceControl(options: {
  repository: ConfigRepository;
  port: ControlPort;
  // The startup grant lifetime. When the operator disables, removes or reloads
  // the plugin, or stops the daemon, no new mutation starts and a pending
  // authorization is rechecked before execution.
  signal?: AbortSignal;
  actor?: string | null;
}): ServiceControl {
  let sequence = 0;
  // One in-flight operation per deployment: a second click can never duplicate
  // the action, and different deployments do not block each other.
  const inFlight = new Set<string>();

  const observe = async (deploymentId: string, slot: number): Promise<ControlObservation | null> => {
    try { return observationOf(await options.port.show(deploymentId, slot)); }
    catch { return null; }
  };

  return async input => {
    const submittedAt = options.port.now().toISOString();
    const operationId = `ctl-${++sequence}`;
    const result = (outcome: ServiceControlResult['outcome'], reason: ControlReason | null,
      observed: ControlObservation | null = null, finishedAt: string | null = null): ServiceControlResult => ({
      operationId, deploymentId: input.deploymentId, slot: input.slot, action: input.action,
      outcome, reason, actor: options.actor ?? null, submittedAt, finishedAt, observed,
    });
    if (options.signal?.aborted) return result('denied', 'disposed');
    const granted = options.repository.controlGrant(input.deploymentId, input.action, input.slot);
    if (!granted.ok) return result('denied', granted.reason);
    if (inFlight.has(input.deploymentId)) return result('pending', 'busy');
    inFlight.add(input.deploymentId);
    try {
      if (input.action === 'restart') {
        const before = await observe(input.deploymentId, input.slot);
        if (!before) return result('denied', 'observe_failed');
        if (!restartable(before)) return result('denied', 'active_delivery', before);
      }
      // Recheck authorization immediately before execution: the grant lifetime
      // can end while an earlier observation was awaited.
      if (options.signal?.aborted) return result('denied', 'disposed');
      const recheck = options.repository.controlGrant(input.deploymentId, input.action, input.slot);
      if (!recheck.ok) return result('denied', recheck.reason);
      const run = await options.port.run(recheck.argv, CONTROL_TIMEOUT_MS);
      const observed = await observe(input.deploymentId, input.slot);
      const finishedAt = options.port.now().toISOString();
      if (run.state === 'timeout') return result('unknown', 'process_timeout', observed, finishedAt);
      if (run.state === 'limited') return result('failed', 'process_limit', observed, finishedAt);
      if (run.state === 'unavailable') return result('failed', 'process_failed', observed, finishedAt);
      if (run.code !== 0) return result('failed', 'process_failed', observed, finishedAt);
      // A submitted command whose state cannot be re-read is not reported as an
      // observed success.
      if (!observed) return result('unknown', 'observe_failed', null, finishedAt);
      return result('succeeded', null, observed, finishedAt);
    } finally { inFlight.delete(input.deploymentId); }
  };
}
