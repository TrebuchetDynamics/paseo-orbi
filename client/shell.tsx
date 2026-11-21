import { useEffect, useState } from 'react';
import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from '@getpaseo/plugin/client';
import { useHosts, useRpc } from '@getpaseo/plugin/client';
import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { deploymentsList, type DeploymentCatalog, type Observation } from '../shared/common';
import { useForeground, useObservationQuery } from './observation';
import { ActionButton } from './action-button';
import { Fleet } from './fleet';
import { observedDeploymentIds, useHostServicesQuery } from './host-overview';
import { Issues } from './issues';
import { Runs } from './runs';
import { Blockers } from './blockers';
import { Work } from './work';

export const routes = ['fleet', 'issues', 'runs', 'blockers'] as const;
// The fleet route is the Work surface: issue work first, host services behind
// one technical-details disclosure. Screen ids and deployment parameters stay.
export const routeTitle = (route: string) => route === 'fleet' ? 'Work' : route[0].toUpperCase() + route.slice(1);
const title = routeTitle;
export function Sidebar({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="LayoutDashboard" label="Orbi" active={routes.some(route => currentScreen?.screenId === route)} onPress={() => openScreen({ screenId: 'fleet' })} />;
}
function ConfiguredRepositories(props: React.ComponentProps<typeof Fleet>) {
  const [expanded, setExpanded] = useState(Boolean(props.params.deploymentId));
  return <View style={{ gap: 8 }}>
    <ActionButton label="Configured repositories" accessibilityName="Configured repositories" expanded={expanded}
      theme={props.theme} onPress={() => setExpanded(value => !value)} />
    {expanded && <Fleet {...props} />}
  </View>;
}
export function Shell({ route, openScreen, ...props }: PluginScreenProps & {
  route: string; openScreen: PluginClientContext['openScreen'];
}) {
  const [setupHost, setSetupHost] = useState<string | null>(null);
  useEffect(() => setSetupHost(null), [props.host.id]);
  const setupExpanded = route !== 'fleet' || setupHost === props.host.id;
  const list = useRpc(deploymentsList);
  const hosts = useHosts();
  const foreground = useForeground();
  const connected = hosts.some(host => host.serverId === props.host.id && host.status === 'online');
  const query = useObservationQuery<DeploymentCatalog>({
    hostId: props.host.id, deploymentId: 'catalog', selector: 'deployments.list', foreground, connected,
    read: async (): Promise<Observation<DeploymentCatalog>> => {
      const catalog = await list({});
      const now = new Date().toISOString();
      // This envelope records transport freshness only, not deployment health or setup success.
      return { state: 'available', observedAt: now, lastSuccessfulAt: now, data: catalog, problems: catalog.problems };
    },
  });
  // The host-scoped service check is Overview evidence only: no other route polls it
  // and no repository or GitHub read depends on it.
  const inventory = useHostServicesQuery({ hostId: props.host.id, connected: connected && route === 'fleet', foreground });
  // null means this host check produced no host evidence (not enabled, denied,
  // failed or not yet readable), so the deployment rows make no
  // observed/not-observed claim at all.
  const observedIds = observedDeploymentIds(inventory.observation?.data);
  const text = { color: props.theme.colors.foreground };
  const catalog = query.observation?.data;
  // One projection of the confirmed unconfigured state: no repeated Unlinked badge
  // on the Overview rows, one explanation above them, and no catalog Refresh
  // because rereading startup configuration cannot configure authorization. A real
  // read failure (including one that retained previous data) keeps the retry.
  const catalogReadFailed = query.observation?.problems.some(problem => problem.code === 'refresh_failed') ?? false;
  const unconfiguredCatalog = catalog?.state === 'unconfigured' && !catalogReadFailed;
  const selected = catalog?.entries.find(entry => entry.id === props.params.deploymentId && entry.status === 'available');
  const featureKey = `${props.host.id}:${selected?.id}:${selected?.repo}`;
  // Work remounts on a host or catalog-identity change, so a repository choice
  // never survives into another host or a reassigned catalog entry.
  const workKey = `${props.host.id}:${catalog?.entries.map(entry => `${entry.id}:${entry.repo}:${entry.status}`).join(',') ?? ''}`;
  const requestedIssue = props.params.issue !== undefined && /^[1-9][0-9]*$/.test(props.params.issue) ? Number(props.params.issue) : null;
  const transport = query.observation?.state === 'available' ? 'current' : query.observation?.state ?? (connected && foreground ? 'loading' : 'unavailable');
  return <ScrollView style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }} contentContainerStyle={{ padding: props.layout.compact ? 16 : 24, gap: 12 }}>
    {route === 'fleet' && <Work
      key={workKey}
      {...props} openScreen={openScreen} catalog={catalog ?? null} catalogUnconfigured={unconfiguredCatalog}
      connected={connected} foreground={foreground} query={inventory}
    />}
    <View testID="orbi-catalog" style={{ gap: 8 }}>
      {route === 'fleet' && <ActionButton label="Set up repositories" accessibilityName="Set up repositories" expanded={setupExpanded}
        theme={props.theme} onPress={() => setSetupHost(setupExpanded ? null : props.host.id)} />}
      {route !== 'fleet' && <Text style={text}>Selected host: {props.host.label}</Text>}
      {!connected && route !== 'fleet' && <Text style={text}>Selected host is offline. No other host will be used.</Text>}
      {!foreground && <Text style={text}>App is in the background. Catalog reads are paused.</Text>}
      {(route !== 'fleet' || transport !== 'current' || !connected) && <Text accessibilityLabel={`Catalog transport: ${transport}`} style={text}>{route === 'fleet' ? `Catalog: ${!connected ? 'offline' : transport}` : `Catalog transport: ${transport}`}</Text>}
      {!!query.observation?.problems.length && <Text accessibilityRole="alert" style={text}>{query.observation.problems.map(p => `${p.source}: ${p.code}`).join('; ')}</Text>}
      {catalog && (route !== 'fleet' || catalog.state !== 'configured' || setupExpanded) && <Text style={text}>Catalog: {catalog.state}</Text>}
      {setupExpanded && catalog && catalog.state !== 'configured' && <View accessibilityLabel="Orbi setup" style={{ gap: 8 }}>
        <Text style={text}>{catalog.state === 'unconfigured'
          ? 'Issue reads are unavailable: no validated repository catalog is configured for this host. Unconfigured: ask the operator to provide an authorized JSON file through PASEO_ORBI_CONFIG and explicitly reload this plugin.'
          : 'Issue reads are unavailable: the configured repository catalog is invalid. Invalid configuration: ask the operator to repair the authorized JSON file provided through PASEO_ORBI_CONFIG and explicitly reload this plugin.'}</Text>
        <Text style={text}>Host service inventory is independent: Work still shows discovered Orbi units under Services (technical details) without a repository catalog.</Text>
        <Text style={text}>Refresh only reads the current startup catalog. It does not configure authorization or reload the plugin.</Text>
      </View>}
      {!catalog && setupExpanded && <Text style={text}>{transport === 'loading' ? 'Loading the selected host catalog.' : 'Catalog unavailable. Reconnect the selected host or ask the operator to check the plugin, then Refresh.'}</Text>}
      {setupExpanded && !unconfiguredCatalog && <ActionButton label={query.refreshing ? 'Refreshing' : 'Refresh'} accessibilityName="Refresh"
        disabled={!query.canRefresh} busy={query.refreshing} theme={props.theme} onPress={() => { void query.refresh(); }} />}
    </View>
    {catalog?.state === 'configured' && <>
      <View testID="orbi-navigation" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {routes.map(next => <ActionButton key={next} label={title(next)} accessibilityName={`Open ${title(next)}`} selected={route === next}
          theme={props.theme} onPress={() => openScreen({ screenId: next, params: selected ? { deploymentId: selected.id } : {} })} />)}
      </View>
      {catalog.entries.length === 0 && <Text style={text}>No configured deployments.</Text>}
      {catalog.entries.filter(entry => entry.status !== 'available').map(entry => <View key={entry.id}>
        <Text style={text}>{entry.label} ({entry.repo}): {entry.status}</Text>
        {entry.problems.map((p, i) => <Text key={i} style={text}>{p.source}: {p.code}</Text>)}
        <Text style={text}>Ask the operator to repair the authorized configuration/source profile and reload this plugin.</Text>
      </View>)}
      <View testID={`orbi-${route}`} style={{ gap: 12 }}>
        {route === 'fleet' ? <ConfiguredRepositories key={`${props.host.id}:${props.params.deploymentId ?? ''}`} {...props} entries={catalog.entries} observedIds={observedIds} openScreen={openScreen} connected={connected} foreground={foreground} /> : <>
          <Text style={text}>{title(route)} — select a repository to browse</Text>
          {catalog.entries.filter(entry => entry.status === 'available').map(entry => <Pressable key={entry.id} accessibilityRole="button" accessibilityLabel={`Select ${entry.label}`} onPress={() => openScreen({ screenId: route, params: { deploymentId: entry.id } })}><Text style={text}>{entry.label} ({entry.repo})</Text></Pressable>)}
          {selected && (route === 'issues'
            ? <Issues key={`${featureKey}:${requestedIssue ?? ''}`} deploymentId={selected.id} repo={selected.repo} hostId={props.host.id} connected={connected} foreground={foreground} theme={props.theme} openScreen={openScreen} initialIssue={requestedIssue} />
            : route === 'runs' ? <Runs key={`${featureKey}:${props.params.issue ?? ''}:${props.params.runId ?? ''}`} repo={selected.repo} deploymentId={selected.id} hostId={props.host.id} connected={connected} foreground={foreground} theme={props.theme} params={props.params} />
            : route === 'blockers' ? <Blockers key={featureKey} repo={selected.repo} deploymentId={selected.id} hostId={props.host.id} connected={connected} foreground={foreground} theme={props.theme} openScreen={openScreen} />
            : null)}
        </>}
      </View>
    </>}
  </ScrollView>;
}
