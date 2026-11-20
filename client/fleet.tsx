import { useState } from 'react';
import type { PluginClientContext, PluginScreenProps } from '@getpaseo/plugin/client';
import { useRpc } from '@getpaseo/plugin/client';
import { Pressable, Text, View } from 'react-native';
import { type DeploymentCatalog } from '../shared/common';
import { fleetRead, type FleetSnapshot } from '../shared/fleet';
import { ObservationView, useObservationQuery } from './observation';

type Props = PluginScreenProps & { openScreen: PluginClientContext['openScreen'] };
type Entry = DeploymentCatalog['entries'][number];
type Unit = FleetSnapshot['units'][number];

// A slot's timer and its one-shot worker are separate units. They are paired by
// the numeric instance in each observed unit ID, never by response order, and a
// unit that does not match exactly one known instance stays visible unpaired.
const instanceId = /^(.*)@([1-9]\d*)\.(service|timer)$/;
function slots(units: readonly Unit[]) {
  const groups = new Map<string, { key: string; prefix: string; slot: number; service: Unit | null; timer: Unit | null }>();
  const unpaired: Unit[] = [];
  for (const unit of units) {
    const match = instanceId.exec(unit.id);
    if (!match) { unpaired.push(unit); continue; }
    const key = `${match[1]}@${match[2]}`;
    const group = groups.get(key) ?? { key, prefix: match[1], slot: Number(match[2]), service: null, timer: null };
    if (match[3] === 'service' && group.service === null) group.service = unit;
    else if (match[3] === 'timer' && group.timer === null) group.timer = unit;
    else { unpaired.push(unit); continue; }
    groups.set(key, group);
  }
  // Numeric instance order; a mixed snapshot only ever arrives from one prefix.
  const ordered = [...groups.values()].sort((left, right) => left.slot - right.slot || (left.prefix < right.prefix ? -1 : left.prefix > right.prefix ? 1 : 0));
  return { ordered, unpaired };
}
// Missing or unreadable facts stay unknown/not found. Only both readable runtime
// fields may read as a state, and unfamiliar or transitional pairs stay verbatim.
function observed(unit: Unit | null) {
  if (unit === null) return null;
  if (unit.loadState === 'not-found') return 'not found' as const;
  if (unit.activeState === null || unit.subState === null) return null;
  return { active: unit.activeState, sub: unit.subState };
}
function workerState(unit: Unit | null) {
  const state = observed(unit);
  if (state === null) return 'unknown';
  if (state === 'not found') return state;
  if (state.active === 'failed' || state.sub === 'failed') return 'failed';
  if (state.active === 'active' && state.sub === 'running') return 'running';
  if (state.active === 'inactive' && state.sub === 'dead') return 'idle';
  return `${state.active}/${state.sub}`;
}
function timerState(unit: Unit | null) {
  const state = observed(unit);
  if (state === null) return 'unknown';
  if (state === 'not found') return state;
  if (state.active === 'failed' || state.sub === 'failed') return 'failed';
  if (state.active === 'active' && state.sub === 'waiting') return 'waiting';
  if (state.active === 'inactive') return 'inactive';
  return `${state.active}/${state.sub}`;
}
// The timer's reported real-time elapse, never a computed cadence. A value that
// systemd still reports for a timer that is not waiting keeps that context.
function nextTrigger(unit: Unit | null, waiting: boolean) {
  if (unit?.nextTrigger == null) return 'unknown';
  return waiting ? unit.nextTrigger : `${unit.nextTrigger} (timer not waiting)`;
}
function UnitDetail({ unit, style }: { unit: Unit; style: { color: string } }) {
  return <View style={{ gap: 4 }}>
    <Text style={style}>{unit.id}</Text>
    <Text style={style}>Load: {unit.loadState ?? 'unavailable'}; Active: {unit.activeState ?? 'unavailable'}; Substate: {unit.subState ?? 'unavailable'}</Text>
    <Text style={style}>Unit file: {unit.unitFileState ?? 'unavailable'}; Service/timer result: {unit.result ?? 'unavailable'}</Text>
    <Text style={style}>Last trigger: {unit.lastTrigger ?? 'unavailable'}; Next trigger (realtime): {unit.nextTrigger ?? 'unavailable'}</Text>
    {unit.problems.map((problem, i) => <Text key={i} style={style}>{problem.source}: {problem.code}</Text>)}
  </View>;
}

// Rich deployment detail is selection/expansion evidence only. The Overview
// landing loads it for one deployment, never for every configured repository.
function DeploymentDetail({ entry, connected, foreground, ...props }: Props & {
  entry: Entry; connected: boolean; foreground: boolean;
}) {
  const read = useRpc(fleetRead);
  const query = useObservationQuery<FleetSnapshot>({
    hostId: props.host.id, deploymentId: entry.id, selector: `fleet.read:${entry.repo}`, connected, foreground,
    read: () => read({ deploymentId: entry.id }),
  });
  const text = { color: props.theme.colors.foreground };
  return <View testID={`orbi-deployment-${entry.id}`} style={{ gap: 8 }}>
    <ObservationView {...query} theme={props.theme}>{data => {
      const grouped = slots(data.units);
      return <View style={{ gap: 8 }}>
        <Text style={text}>Profile: {data.profile}</Text>
        <Text style={text}>Configured capacity: {data.configuredCapacity}; Occupancy: unknown</Text>
        <Text style={text}>Active deliveries: unknown</Text>
        {data.units.length > 0 && <Text style={text}>Worker and timer are separate units: a waiting timer does not guarantee that a worker starts or picks up an issue.</Text>}
        {grouped.ordered.map(({ key, slot, service, timer }) => {
          const timerFact = timerState(timer);
          return <View key={key} style={{ gap: 4 }}>
            <Text accessibilityRole="summary" style={text}>{`Slot ${slot} · Worker ${workerState(service)} · Timer ${timerFact} · Next trigger ${nextTrigger(timer, timerFact === 'waiting')}`}</Text>
            {service !== null && <UnitDetail unit={service} style={text} />}
            {timer !== null && <UnitDetail unit={timer} style={text} />}
          </View>;
        })}
        {grouped.unpaired.map(unit => <UnitDetail key={unit.id} unit={unit} style={text} />)}
        <Text style={text}>Recorded health (not current service health)</Text>
        {data.health === null ? <Text style={text}>Health unavailable. Ask the operator to check the health writer/file, then Refresh.</Text> : <View>
          <Text style={text}>Last pickup: {data.health.lastPickupAt ?? 'unavailable'}</Text>
          {data.health.recentRuns.length === 0 && <Text style={text}>No recorded runs in the validated health history.</Text>}
          {data.health.recentRuns.map((run, i) => <Text key={i} style={text}>{run.repo} #{run.issue} · {run.runId} · Reported outcome: {run.outcome} · {run.at}</Text>)}
        </View>}
      </View>;
    }}</ObservationView>
    <Text style={text}>Unit reads unavailable? Ask the operator to check user-unit access, then Refresh. No controls change services.</Text>
  </View>;
}

function DeploymentRow({ entry, openId, setOpenId, observedIds, connected, foreground, ...props }: Props & {
  entry: Entry; openId: string | null; setOpenId: (id: string | null) => void;
  observedIds: string[] | null; connected: boolean; foreground: boolean;
}) {
  const open = openId === entry.id;
  const text = { color: props.theme.colors.foreground };
  const observed = observedIds === null ? null : observedIds.includes(entry.id);
  return <View testID={`orbi-deployment-row-${entry.id}`} style={{ gap: 8, padding: props.layout.compact ? 12 : 16, borderWidth: 1, borderColor: props.theme.colors.foreground }}>
    <View style={{ flexDirection: props.layout.compact ? 'column' : 'row', flexWrap: 'wrap', gap: 8, alignItems: props.layout.compact ? 'flex-start' : 'center' }}>
      <Text style={text}>{entry.label} ({entry.repo})</Text>
      {observed !== null && <Text style={text}>{observed ? 'Observed in this host service check' : 'Not observed in this host service check'}</Text>}
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${open ? 'Hide' : 'Show'} details for ${entry.label}`}
        accessibilityState={{ expanded: open, selected: open }}
        style={{ padding: 4, borderWidth: 1, borderColor: props.theme.colors.foreground }}
        onPress={() => setOpenId(open ? null : entry.id)}><Text style={text}>{open ? 'Hide details' : 'Show details'}</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`Active work for ${entry.label}`}
        style={{ padding: 4, borderWidth: 1, borderColor: props.theme.colors.foreground }}
        onPress={() => props.openScreen({ screenId: 'issues', params: { deploymentId: entry.id } })}><Text style={text}>View active work in Issues</Text></Pressable>
    </View>
    {open && <DeploymentDetail {...props} entry={entry} connected={connected} foreground={foreground} />}
  </View>;
}

// The Shell is the sole catalog/foreground/connectivity owner for every route.
export function Fleet({ entries, observedIds, connected, foreground, ...props }: Props & {
  entries: DeploymentCatalog['entries']; observedIds: string[] | null; connected: boolean; foreground: boolean;
}) {
  const text = { color: props.theme.colors.foreground };
  const available = entries.filter(entry => entry.status === 'available');
  const preferred = available.find(entry => entry.id === props.params.deploymentId)?.id ?? available[0]?.id ?? null;
  const [openId, setOpenId] = useState<string | null>(preferred);
  return <View testID="orbi-fleet" style={{ gap: 12 }}>
    <Text style={text}>Fleet — read-only</Text>
    <Text style={text}>Configured capacity is not live occupancy or a machine-wide capacity promise.</Text>
    <Text style={text}>One deployment detail loads for the selected or expanded row; other repositories are listed without a read.</Text>
    {available.map(entry => <DeploymentRow key={`${props.host.id}:${entry.id}:${entry.repo}`} {...props} entry={entry} connected={connected} foreground={foreground} openId={openId} setOpenId={setOpenId} observedIds={observedIds} />)}
  </View>;
}
