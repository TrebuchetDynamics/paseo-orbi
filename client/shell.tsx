import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from '@getpaseo/plugin/client';
import { useHosts, useRpc } from '@getpaseo/plugin/client';
import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { deploymentsList, type DeploymentCatalog, type Observation } from '../shared/common';
import { ObservationView, useForeground, useObservationQuery } from './observation';
import { Issues } from './issues';
import { Runs } from './runs';

export const routes = ['fleet', 'issues', 'runs', 'blockers'] as const;
const title = (route: string) => route[0].toUpperCase() + route.slice(1);
export function Sidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <View>{routes.map(route => <SidebarRow key={route} icon="LayoutDashboard" label={title(route)} active={currentScreen?.screenId === route} onPress={() => openScreen({ screenId: route })} />)}</View>;
}
export function Shell({ route, openScreen, ...props }: PluginScreenProps & {
  route: string; openScreen: PluginClientContext['openScreen'];
}) {
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
  const selected = query.observation?.data?.entries.find(entry => entry.id === props.params.deploymentId && entry.status === 'available');
  return <ScrollView style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }} contentContainerStyle={{ padding: props.layout.compact ? 16 : 24, gap: 12 }}>
    <Text style={text}>{title(route)}{route === 'issues' || route === 'runs' ? ' — select a repository to browse' : ' — feature not implemented'}</Text>
    <Text style={text}>Read-only. Blockers is not implemented. Open Fleet for deployment telemetry.</Text>
    {!connected && <Text style={text}>Selected host is offline. No other host will be used.</Text>}
    <ObservationView {...query} theme={props.theme}>{catalog => <View>
      {catalog.state === 'unconfigured' && <Text style={text}>Unconfigured: ask the operator to set PASEO_ORBI_CONFIG to an authorized JSON file and reload this plugin.</Text>}
      {catalog.state === 'invalid' && <Text style={text}>Invalid configuration: ask the operator to repair the authorization file and reload this plugin.</Text>}
      {catalog.entries.map(entry => entry.status === 'available'
        ? <Pressable key={entry.id} accessibilityRole="button" accessibilityLabel={`Select ${entry.label}`} onPress={() => openScreen({ screenId: route, params: { deploymentId: entry.id } })}><Text style={text}>{entry.label} ({entry.repo})</Text></Pressable>
        : <View key={entry.id}><Text style={text}>{entry.label} ({entry.repo}): {entry.status}</Text>{entry.problems.map((p, i) => <Text key={i} style={text}>{p.code}</Text>)}</View>)}
      {selected && (route === 'issues'
        ? <Issues key={selected.id} deploymentId={selected.id} hostId={props.host.id} connected={connected} foreground={foreground} theme={props.theme} />
        : route === 'runs' ? <Runs key={`${props.host.id}:${selected.id}:${selected.repo}`} repo={selected.repo} deploymentId={selected.id} hostId={props.host.id} connected={connected} foreground={foreground} theme={props.theme} />
        : <Text style={text}>Selected: {selected.label}. Feature not implemented.</Text>)}
      {routes.map(next => <Pressable key={next} accessibilityRole="button" accessibilityLabel={`Open ${title(next)}`} onPress={() => openScreen({ screenId: next, params: selected ? { deploymentId: selected.id } : {} })}><Text style={text}>{title(next)}</Text></Pressable>)}
    </View>}</ObservationView>
  </ScrollView>;
}
