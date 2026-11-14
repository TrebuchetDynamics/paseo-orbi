import type { PluginClientContext, PluginScreenProps } from '@getpaseo/plugin/client';
import { useHosts, useRpc } from '@getpaseo/plugin/client';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { deploymentsList, type DeploymentCatalog, type Observation } from '../shared/common';
import { fleetRead, type FleetSnapshot } from '../shared/fleet';
import { ObservationView, useForeground, useObservationQuery } from './observation';

type Props = PluginScreenProps & { openScreen: PluginClientContext['openScreen'] };
function DeploymentCard({ entry, connected, foreground, ...props }: Props & {
  entry: DeploymentCatalog['entries'][number]; connected: boolean; foreground: boolean;
}) {
  const read = useRpc(fleetRead);
  const query = useObservationQuery<FleetSnapshot>({
    hostId: props.host.id, deploymentId: entry.id, selector: 'fleet.read', connected, foreground,
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
export function Fleet(props: Props) {
  const list = useRpc(deploymentsList);
  const hosts = useHosts();
  const foreground = useForeground();
  const connected = hosts.some(host => host.serverId === props.host.id && host.status === 'online');
  const query = useObservationQuery<DeploymentCatalog>({
    hostId: props.host.id, deploymentId: 'catalog', selector: 'deployments.list', foreground, connected,
    read: async (): Promise<Observation<DeploymentCatalog>> => {
      const catalog = await list({});
      const now = new Date().toISOString();
      return { state: 'available', observedAt: now, lastSuccessfulAt: now, data: catalog, problems: catalog.problems };
    },
  });
  const text = { color: props.theme.colors.foreground };
  return <ScrollView style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }} contentContainerStyle={{ padding: props.layout.compact ? 16 : 24, gap: 12 }}>
    <Text style={text}>Fleet — read-only</Text>
    <Text style={text}>Configured capacity is not live occupancy or a machine-wide capacity promise.</Text>
    {!connected && <Text style={text}>Selected host is offline. No other host will be used.</Text>}
    <ObservationView {...query} theme={props.theme}>{catalog => <View style={{ gap: 12 }}>
      {catalog.state === 'unconfigured' && <Text style={text}>Unconfigured: ask the operator to set PASEO_ORBI_CONFIG to an authorized JSON file and reload this plugin.</Text>}
      {catalog.state === 'invalid' && <Text style={text}>Invalid configuration: ask the operator to repair the authorization file and reload this plugin.</Text>}
      {catalog.state === 'configured' && catalog.entries.length === 0 && <Text style={text}>No configured deployments.</Text>}
      {catalog.entries.map(entry => entry.status === 'available'
        ? <DeploymentCard key={`${props.host.id}:${entry.id}`} {...props} entry={entry} connected={connected} foreground={foreground} />
        : <View key={entry.id} style={{ padding: props.layout.compact ? 12 : 16 }}>
          <Text style={text}>{entry.label} ({entry.repo}): {entry.status}</Text>
          {entry.problems.map((p, i) => <Text key={i} style={text}>{p.source}: {p.code}</Text>)}
          <Text style={text}>Ask the operator to repair the authorized configuration/source profile and reload this plugin.</Text>
        </View>)}
    </View>}</ObservationView>
  </ScrollView>;
}
