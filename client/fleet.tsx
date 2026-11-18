import type { PluginClientContext, PluginScreenProps } from '@getpaseo/plugin/client';
import { useRpc } from '@getpaseo/plugin/client';
import { Pressable, Text, View } from 'react-native';
import { type DeploymentCatalog } from '../shared/common';
import { fleetRead, type FleetSnapshot } from '../shared/fleet';
import { ObservationView, useObservationQuery } from './observation';

type Props = PluginScreenProps & { openScreen: PluginClientContext['openScreen'] };
function DeploymentCard({ entry, connected, foreground, ...props }: Props & {
  entry: DeploymentCatalog['entries'][number]; connected: boolean; foreground: boolean;
}) {
  const read = useRpc(fleetRead);
  const query = useObservationQuery<FleetSnapshot>({
    hostId: props.host.id, deploymentId: entry.id, selector: `fleet.read:${entry.repo}`, connected, foreground,
    read: () => read({ deploymentId: entry.id }),
  });
  const text = { color: props.theme.colors.foreground };
  return <View style={{ gap: 8, padding: props.layout.compact ? 12 : 16 }}>
    <Text style={text}>{entry.label} ({entry.repo})</Text>
    <ObservationView {...query} theme={props.theme}>{data => <View style={{ gap: 8 }}>
      <Text style={text}>Profile: {data.profile}</Text>
      <Text style={text}>Configured capacity: {data.configuredCapacity}; Occupancy: unknown</Text>
      <Text style={text}>Active deliveries: unknown</Text>
      {data.units.map(unit => <View key={unit.id} style={{ gap: 4 }}>
        <Text style={text}>{unit.id}</Text>
        <Text style={text}>Load: {unit.loadState ?? 'unavailable'}; Active: {unit.activeState ?? 'unavailable'}; Substate: {unit.subState ?? 'unavailable'}</Text>
        <Text style={text}>Unit file: {unit.unitFileState ?? 'unavailable'}; Service/timer result: {unit.result ?? 'unavailable'}</Text>
        <Text style={text}>Last trigger: {unit.lastTrigger ?? 'unavailable'}; Next trigger (realtime): {unit.nextTrigger ?? 'unavailable'}</Text>
        {unit.problems.map((p, i) => <Text key={i} style={text}>{p.source}: {p.code}</Text>)}
      </View>)}
      <Text style={text}>Recorded health (not current service health)</Text>
      {data.health === null ? <Text style={text}>Health unavailable. Ask the operator to check the health writer/file, then Refresh.</Text> : <View>
        <Text style={text}>Last pickup: {data.health.lastPickupAt ?? 'unavailable'}</Text>
        {data.health.recentRuns.length === 0 && <Text style={text}>No recorded runs in the validated health history.</Text>}
        {data.health.recentRuns.map((run, i) => <Text key={i} style={text}>{run.repo} #{run.issue} · {run.runId} · Reported outcome: {run.outcome} · {run.at}</Text>)}
      </View>}
    </View>}</ObservationView>
    <Text style={text}>Unit reads unavailable? Ask the operator to check user-unit access, then Refresh. No controls change services.</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`Active work for ${entry.label}`} onPress={() => props.openScreen({ screenId: 'issues', params: { deploymentId: entry.id } })}><Text style={text}>View active work in Issues</Text></Pressable>
  </View>;
}
// The Shell is the sole catalog/foreground/connectivity owner for every route.
export function Fleet({ entries, connected, foreground, ...props }: Props & {
  entries: DeploymentCatalog['entries']; connected: boolean; foreground: boolean;
}) {
  const text = { color: props.theme.colors.foreground };
  return <View style={{ gap: 12 }}>
    <Text style={text}>Fleet — read-only</Text>
    <Text style={text}>Configured capacity is not live occupancy or a machine-wide capacity promise.</Text>
    {entries.filter(entry => entry.status === 'available').map(entry =>
      <DeploymentCard key={`${props.host.id}:${entry.id}:${entry.repo}`} {...props} entry={entry} connected={connected} foreground={foreground} />)}
  </View>;
}
