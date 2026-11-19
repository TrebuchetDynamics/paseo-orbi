import { ReadError } from './read-ports';
import type { UnitFamilyClaim } from './config';
import {
  activeStates, loadStates, subStates, unitFileStates,
  type InventoryGroup, type InventoryProblem, type InventoryUnit, type ServiceInventory,
} from '../shared/services';

// Host-scoped service inventory. It observes only Orbi-prefixed user units with
// two fixed systemctl list commands and never resolves a deployment: a matching
// unit name is displayed as an association, never a read capability.

export type HostInventoryOperation = 'runtime' | 'installed';
export type InventoryPort = {
  clock(): Date;
  hostInventory(operation: HostInventoryOperation, timeoutMs?: number): Promise<string>;
};
export type ServiceInventoryReader = (input: Record<string, never>) => Promise<ServiceInventory>;

const idPattern = /^orbi[A-Za-z0-9_.:@-]*\.(?:service|timer)$/;
const tokenPattern = /^[a-z][a-z0-9-]{0,31}$/;
export const ROW_LIMIT = 256;
export const SNAPSHOT_TTL_MS = 30000;
export const OVERALL_DEADLINE_MS = 10000;

type RuntimeFacts = NonNullable<InventoryUnit['runtime']>;
type Row = { id: string; runtime: RuntimeFacts | null; unitFileState: InventoryUnit['unitFileState'] };
type Parsed = { rows: Map<string, Row>; malformed: number };

const off = (): ServiceInventory => ({ state: 'off', observedAt: null, sources: [], groups: [], problems: [] });
const byText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function known<T extends string>(values: readonly T[], value: string): T | 'unknown' {
  return (values as readonly string[]).includes(value) ? value as T : 'unknown';
}
function unitKind(id: string): 'service' | 'timer' { return id.endsWith('.timer') ? 'timer' : 'service'; }
// Sanitized family prefix: only validated unit-name characters can survive, so
// descriptions, paths and control characters never become a group label.
function family(id: string): { base: string; kind: InventoryGroup['kind'] } {
  const base = id.replace(/\.(?:service|timer)$/, '').replace(/@[^@]*$/, '');
  if (base === 'orbi-exporter') return { base, kind: 'auxiliary' };
  if (base === 'orbi' || /^orbi-[A-Za-z0-9_-]{1,80}$/.test(base)) return { base, kind: 'runner-family' };
  return { base, kind: 'other' };
}
// Deliberately minimal columns: ID LOAD ACTIVE SUB. The remaining description
// text is never read, stored or transported.
function parseRuntime(output: string): Parsed {
  const rows = new Map<string, Row>();
  let malformed = 0;
  for (const line of output.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const parts = text.split(/\s+/);
    if (parts.length < 4) { malformed++; continue; }
    const [id, load, active, sub] = parts;
    if (!idPattern.test(id) || !tokenPattern.test(load) || !tokenPattern.test(active) || !tokenPattern.test(sub)) { malformed++; continue; }
    rows.set(id, { id, unitFileState: null, runtime: {
      loadState: known(loadStates, load), activeState: known(activeStates, active), subState: known(subStates, sub),
    } });
  }
  return { rows, malformed };
}
// ID + unit-file state; the vendor preset column is ignored.
function parseInstalled(output: string): Parsed {
  const rows = new Map<string, Row>();
  let malformed = 0;
  for (const line of output.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const parts = text.split(/\s+/);
    if (parts.length < 2) { malformed++; continue; }
    const [id, state] = parts;
    if (!idPattern.test(id) || !tokenPattern.test(state)) { malformed++; continue; }
    rows.set(id, { id, runtime: null, unitFileState: known(unitFileStates, state) });
  }
  return { rows, malformed };
}
function merge(runtime: Parsed | null, installed: Parsed | null): Row[] {
  const ids = new Set([...(runtime?.rows.keys() ?? []), ...(installed?.rows.keys() ?? [])]);
  return [...ids].sort(byText).map(id => ({
    id, runtime: runtime?.rows.get(id)?.runtime ?? null, unitFileState: installed?.rows.get(id)?.unitFileState ?? null,
  }));
}
// A unique exact prefix of one validated declaration is the only association
// that carries authority. Duplicate claims (including supported/unsupported
// collisions) are ambiguous; unsupported profiles stay display-only.
function associate(base: string, kind: InventoryGroup['kind'], claims: readonly UnitFamilyClaim[]): Pick<InventoryGroup, 'association' | 'deploymentId'> {
  if (kind !== 'runner-family') return { association: 'unmatched', deploymentId: null };
  const matches = claims.filter(claim => (claim.unitName === null ? 'orbi' : `orbi-${claim.unitName}`) === base);
  if (matches.length === 0) return { association: 'unmatched', deploymentId: null };
  if (matches.length > 1) return { association: 'ambiguous', deploymentId: null };
  return matches[0].status === 'available'
    ? { association: 'matched', deploymentId: matches[0].id }
    : { association: 'incompatible', deploymentId: null };
}
function toGroups(rows: readonly Row[], claims: readonly UnitFamilyClaim[]): InventoryGroup[] {
  const families = new Map<string, { kind: InventoryGroup['kind']; units: InventoryUnit[] }>();
  for (const row of rows) {
    const { base, kind } = family(row.id);
    const group = families.get(base) ?? { kind, units: [] };
    group.units.push({ id: row.id, kind: unitKind(row.id), runtime: row.runtime, unitFileState: row.unitFileState });
    families.set(base, group);
  }
  return [...families.entries()].sort(([a], [b]) => byText(a, b)).map(([label, group]) => ({
    label, kind: group.kind, units: [...group.units].sort((a, b) => byText(a.id, b.id)),
    ...associate(label, group.kind, claims),
  }));
}
function failureCode(error: unknown): InventoryProblem['code'] {
  if (error instanceof ReadError) {
    if (['process_failed', 'process_timeout', 'process_limit', 'read_limit', 'disposed'].includes(error.code)) {
      return error.code as InventoryProblem['code'];
    }
  }
  return 'process_failed';
}
const uniq = (problems: readonly InventoryProblem[]) =>
  problems.filter((p, i) => problems.findIndex(other => other.source === p.source && other.code === p.code) === i);

export function createServiceInventory(options: {
  enabled: boolean;
  claims: () => readonly UnitFamilyClaim[];
  port: InventoryPort;
}): ServiceInventoryReader {
  let cached: ServiceInventory | null = null;
  let cachedAt = 0;
  let inFlight: Promise<ServiceInventory> | null = null;

  const refresh = async (): Promise<ServiceInventory> => {
    const deadline = options.port.clock().getTime() + OVERALL_DEADLINE_MS;
    const sources: ServiceInventory['sources'] = [];
    const parsed: Partial<Record<HostInventoryOperation, Parsed>> = {};
    const problems: InventoryProblem[] = [];
    // Sequential bounded reads share one overall deadline; the second read is
    // never launched once the first has consumed it.
    for (const source of ['runtime', 'installed'] as const) {
      const started = options.port.clock().getTime();
      if (started >= deadline) {
        sources.push({ source, state: 'unavailable', observedAt: new Date(started).toISOString(), problems: [{ source, code: 'deadline' }] });
        problems.push({ source, code: 'deadline' });
        continue;
      }
      try {
        const output = await options.port.hostInventory(source, Math.min(OVERALL_DEADLINE_MS, Math.max(1, deadline - started)));
        const result = source === 'runtime' ? parseRuntime(output) : parseInstalled(output);
        parsed[source] = result;
        const sourceProblems: InventoryProblem[] = result.malformed ? [{ source, code: 'malformed_record' }] : [];
        sources.push({ source, state: sourceProblems.length ? 'partial' : 'complete', observedAt: options.port.clock().toISOString(), problems: sourceProblems });
        problems.push(...sourceProblems);
      } catch (error) {
        const code = failureCode(error);
        sources.push({ source, state: 'unavailable', observedAt: options.port.clock().toISOString(), problems: [{ source, code }] });
        problems.push({ source, code });
      }
    }
    let rows = merge(parsed.runtime ?? null, parsed.installed ?? null);
    let truncated = false;
    if (rows.length > ROW_LIMIT) { rows = rows.slice(0, ROW_LIMIT); truncated = true; problems.push({ source: 'host', code: 'row_limit' }); }
    const complete = !truncated && sources.length === 2 && sources.every(source => source.state === 'complete');
    const anySource = sources.some(source => source.state !== 'unavailable');
    return {
      state: complete ? 'complete' : anySource ? 'partial' : 'unavailable',
      observedAt: options.port.clock().toISOString(), sources,
      groups: toGroups(rows, options.claims()), problems: uniq(problems),
    };
  };

  return async () => {
    if (!options.enabled) return off();
    const now = options.port.clock().getTime();
    if (cached && now - cachedAt < SNAPSHOT_TTL_MS) return cached;
    if (!inFlight) {
      inFlight = refresh().then(value => { cached = value; cachedAt = options.port.clock().getTime(); return value; })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}
