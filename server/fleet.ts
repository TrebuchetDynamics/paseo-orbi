import { z } from 'zod';
import type { ConfigRepository } from './config';
import { ReadError, type ReadPorts } from './read-ports';
import type { Observation, Problem } from '../shared/common';
import type { FleetSnapshot, UnitSnapshot } from '../shared/fleet';

// Both pinned runner_health.py writers: fresh_state(), record_run_attempt().
// Unknown or malformed records invalidate the source, never become an empty success.
const timestamp = z.number().min(0).max(253402300799);
const healthState = z.object({
  last_pickup_ts: timestamp.nullable(), alerted: z.array(z.string()),
  runs: z.array(z.object({
    repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/),
    issue: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    run_id: z.string().regex(/^[0-9a-f]{8}$/),
    outcome: z.enum(['failed', 'pr_opened', 'issue_closed']),
    fingerprint: z.string(), ts: timestamp,
  }).strict()).max(50),
}).strict();
const at = (ts: number) => new Date(ts * 1000).toISOString();
const problem = (source: Problem['source'], error?: unknown): Problem => ({
  source, code: error instanceof ReadError ? error.code : 'read_failed',
});
const known = (value: string | undefined, values: string[]) => value && values.includes(value) ? value : null;
const trigger = (value: string | undefined) => value && /^[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})? [A-Za-z0-9_+:/-]{1,32}$/.test(value) ? value : null;
function emptyUnit(id: string): UnitSnapshot {
  return { id, loadState: null, activeState: null, subState: null, unitFileState: null, result: null, lastTrigger: null, nextTrigger: null, problems: [] };
}
function parseUnit(id: string, output: string): UnitSnapshot {
  const fields = new Map<string, string>();
  for (const line of output.split('\n')) {
    const equal = line.indexOf('=');
    if (equal > 0) fields.set(line.slice(0, equal), line.slice(equal + 1));
  }
  const unit = emptyUnit(id);
  // Id is checked against the server-authorized name, never trusted as a new identity.
  if (fields.has('Id') && fields.get('Id') !== id) {
    unit.problems.push(problem('systemd')); return unit;
  }
  unit.loadState = known(fields.get('LoadState'), ['loaded', 'not-found', 'bad-setting', 'error', 'masked', 'merged', 'stub']);
  unit.activeState = known(fields.get('ActiveState'), ['active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating', 'maintenance', 'refreshing']);
  unit.subState = known(fields.get('SubState'), ['waiting', 'running', 'elapsed', 'dead', 'exited', 'failed', 'start-pre', 'start', 'start-post', 'auto-restart', 'auto-restart-queued', 'stop', 'stop-sigterm', 'stop-sigkill', 'stop-post', 'final-sigterm', 'final-sigkill', 'reload', 'reload-signal', 'reload-notify', 'cleaning', 'condition']);
  unit.unitFileState = known(fields.get('UnitFileState'), ['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias', 'masked', 'masked-runtime', 'static', 'disabled', 'indirect', 'generated', 'transient', 'bad']);
  unit.result = known(fields.get('Result'), ['success', 'resources', 'timeout', 'exit-code', 'signal', 'core-dump', 'watchdog', 'start-limit-hit', 'protocol', 'oom-kill', 'exec-condition', 'assert', 'condition', 'trigger-limit-hit']);
  unit.lastTrigger = trigger(fields.get('LastTriggerUSec'));
  unit.nextTrigger = trigger(fields.get('NextElapseUSecRealtime'));
  if (!unit.loadState || unit.loadState === 'not-found' || !unit.activeState || !unit.subState) unit.problems.push(problem('systemd'));
  return unit;
}

export async function readFleet(repository: ConfigRepository, ports: Pick<ReadPorts, 'clock' | 'read' | 'process'>, input: { deploymentId: string }): Promise<Observation<FleetSnapshot>> {
  const deployment = repository.resolve(input.deploymentId);
  const data: FleetSnapshot = {
    deploymentId: deployment.id, repo: deployment.repo, profile: deployment.sourceProfile,
    configuredCapacity: deployment.capacity, occupancy: null, units: [], health: null,
  };
  const problems: Problem[] = [];
  let successfulSources = 0;
  const prefix = deployment.unitName === null ? 'orbi' : `orbi-${deployment.unitName}`;
  for (let slot = 1; slot <= deployment.capacity; slot++) {
    for (const unit of ['timer', 'service'] as const) {
      const id = `${prefix}@${slot}.${unit}`;
      let snapshot = emptyUnit(id);
      try {
        snapshot = parseUnit(id, await ports.process(deployment.id, { kind: 'systemctl-show', slot, unit }));
        if (!snapshot.problems.length) successfulSources++;
      } catch (error) { snapshot.problems.push(problem('systemd', error)); }
      data.units.push(snapshot); problems.push(...snapshot.problems);
    }
  }
  try {
    const raw = healthState.parse(JSON.parse((await ports.read(deployment.id, 'health')).toString('utf8')));
    data.health = {
      lastPickupAt: raw.last_pickup_ts === null ? null : at(raw.last_pickup_ts),
      recentRuns: raw.runs.map(run => ({ repo: run.repo, issue: run.issue, runId: run.run_id, outcome: run.outcome, at: at(run.ts) })),
    };
    successfulSources++;
  } catch (error) { problems.push(problem('filesystem', error)); }
  const now = ports.clock().toISOString();
  return {
    state: !problems.length ? 'available' : successfulSources ? 'partial' : 'unavailable',
    observedAt: now, lastSuccessfulAt: successfulSources ? now : null, data,
    problems: problems.filter((p, i) => problems.findIndex(other => other.source === p.source && other.code === p.code) === i),
  };
}
