import { useEffect, useRef, useState } from 'react';
import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from '@getpaseo/plugin/client';
import { useHosts, useRpc } from '@getpaseo/plugin/client';
import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { ScrollView, Text, View } from 'react-native';
import { deploymentsList, type DeploymentCatalog, type Observation } from '../shared/common';
import { useForeground, useObservationQuery } from './observation';
import { ActionButton } from './action-button';
import { Fleet } from './fleet';
import { HostServices, observedDeploymentIds, useHostServicesQuery } from './host-overview';
import { Issues } from './issues';
import { Runs } from './runs';
import { Blockers } from './blockers';
import { Work } from './work';

// Screen ids stay stable: fleet/issues/runs/blockers keep every existing link
// working, and services is the host-scoped service screen. The persistent
// navigation offers Work, Services and Runs; Issues stays reachable from issue
// rows and run links, and both Issues and Blockers keep their route ids for
// deep links.
export const routes = ['fleet', 'services', 'issues', 'runs', 'blockers'] as const;
export const navigation = ['fleet', 'services', 'runs'] as const;
export const routeTitle = (route: string) => route === 'fleet' ? 'Work' : route[0].toUpperCase() + route.slice(1);
const title = routeTitle;
// An explicit Work navigation carries this param so the unconfigured landing
// default can never override a deliberate Work choice.
export const workSurface = 'work';

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
  const [guideOpen, setGuideOpen] = useState(false);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  // The list keeps its own scroll offset: Back from a diagnostic view returns to
  // the same place instead of jumping to the top of the Services screen.
  const listOffset = useRef(0);
  const restoreList = useRef(false);
  const scroller = useRef<ScrollView>(null);
  useEffect(() => { setSelectedService(null); setGuideOpen(false); }, [props.host.id]);
  useEffect(() => {
    if (!restoreList.current || selectedService !== null) return;
    restoreList.current = false;
    // Restore the list offset; a host component without scrollTo is left alone.
    scroller.current?.scrollTo?.({ y: listOffset.current, animated: false });
  }, [selectedService]);
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
  // The host-scoped service check is Services/Work evidence only: no other route
  // polls it and no repository or GitHub read depends on it.
  const inventory = useHostServicesQuery({ hostId: props.host.id, connected: connected && (route === 'fleet' || route === 'services'), foreground });
  // null means this host check produced no host evidence (not enabled, denied,
  // failed or not yet readable), so the deployment rows make no
  // observed/not-observed claim at all.
  const observedIds = observedDeploymentIds(inventory.observation?.data);
  const text = { color: props.theme.colors.foreground };
  const catalog = query.observation?.data;
  // One projection of the confirmed unconfigured state: no repeated Unlinked badge
  // on the Services rows, one explanation above them, and no catalog Refresh
  // because rereading startup configuration cannot configure authorization. A real
  // read failure (including one that retained previous data) keeps the retry.
  const catalogReadFailed = query.observation?.problems.some(problem => problem.code === 'refresh_failed') ?? false;
  const unconfiguredCatalog = catalog?.state === 'unconfigured' && !catalogReadFailed;
  // A catalog that was actually read (configured, or confirmed unconfigured)
  // confirms this host's repository associations; a failed, invalid or loading
  // catalog cannot.
  const catalogConfirmed = !catalogReadFailed && (catalog?.state === 'configured' || unconfiguredCatalog);
  // The service details view owns its own facts: the shared repository notice and
  // Setup guide are suppressed there, and stay on every other screen.
  const serviceDetail = route === 'services' && selectedService !== null;
  const selectedDeployment = catalog?.entries.find(entry => entry.id === props.params.deploymentId && entry.status === 'available');
  const featureKey = `${props.host.id}:${selectedDeployment?.id}:${selectedDeployment?.repo}`;
  // Work remounts on a host or catalog-identity change, so a repository choice
  // never survives into another host or a reassigned catalog entry.
  const workKey = `${props.host.id}:${catalog?.entries.map(entry => `${entry.id}:${entry.repo}:${entry.status}`).join(',') ?? ''}`;
  const requestedIssue = props.params.issue !== undefined && /^[1-9][0-9]*$/.test(props.params.issue) ? Number(props.params.issue) : null;
  const transport = query.observation?.state === 'available' ? 'current' : query.observation?.state ?? (connected && foreground ? 'loading' : 'unavailable');
  const deploymentParams: Record<string, string> = selectedDeployment ? { deploymentId: selectedDeployment.id } : {};
  const catalogProblems = query.observation?.problems ?? [];
  const target = (next: string) => next === 'fleet'
    ? { screenId: 'fleet', params: { ...deploymentParams, surface: workSurface } }
    : { screenId: next, params: deploymentParams };
  const wantsWork = props.params.surface === workSurface;
  // One navigation from the default landing only: a host without a linked
  // repository has no Work rows to show, so Services is its first screen. An
  // explicit Work navigation (surface=work), every other route id and every
  // loading/error state stay untouched.
  useEffect(() => {
    if (route === 'fleet' && unconfiguredCatalog && !wantsWork) openScreen({ screenId: 'services', params: deploymentParams });
  }, [route, unconfiguredCatalog, wantsWork]);
  return <ScrollView ref={scroller} scrollEventThrottle={16}
    onScroll={event => { if (route === 'services' && selectedService === null) listOffset.current = event.nativeEvent.contentOffset.y; }}
    style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }} contentContainerStyle={{ padding: props.layout.compact ? 16 : 24, gap: 12 }}>
    <View testID="orbi-navigation" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {navigation.map(next => <ActionButton key={next} label={title(next)} accessibilityName={`Open ${title(next)}`} selected={route === next}
        theme={props.theme} onPress={() => openScreen(target(next))} />)}
    </View>
    <View testID="orbi-catalog" style={{ gap: 8 }}>
      {route !== 'fleet' && route !== 'services' && <Text style={text}>Selected host: {props.host.label}</Text>}
      {!connected && <Text style={text}>Selected host is offline. No other host will be used.</Text>}
      {!foreground && <Text style={text}>App is in the background. Catalog reads are paused.</Text>}
      {transport !== 'current' && <Text accessibilityLabel={`Catalog transport: ${transport}`} style={text}>{`Catalog: ${!connected ? 'offline' : transport}`}</Text>}
      {!!catalogProblems.length && <Text accessibilityRole="alert" style={text}>{catalogProblems.map(p => `${p.source}: ${p.code}`).join('; ')}</Text>}
      {!serviceDetail && (!catalog || unconfiguredCatalog || catalog.state === 'invalid' || catalogReadFailed) && <View accessibilityLabel="Orbi setup" testID="orbi-setup" style={{ gap: 8 }}>
        <Text style={text}>{!catalog
          ? (transport === 'loading' ? 'Loading the selected host catalog.' : 'Catalog unavailable. Reconnect the selected host or ask the operator to check the plugin, then Refresh.')
          : catalogReadFailed && !unconfiguredCatalog
            ? 'Catalog read failed. Reconnect the selected host or ask the operator to check the plugin, then Refresh.'
            : unconfiguredCatalog
              ? 'Repositories aren’t linked. Link repositories to see GitHub issues.'
              : 'Issue reads are unavailable: the configured repository catalog is invalid. Ask the operator to repair the authorized JSON file provided through PASEO_ORBI_CONFIG and explicitly reload this plugin.'}</Text>
        <ActionButton label="Setup guide" accessibilityName="Setup guide" expanded={guideOpen} theme={props.theme}
          onPress={() => setGuideOpen(value => !value)} />
        {guideOpen && <View accessibilityLabel="Repository setup guide" style={{ gap: 8 }}>
          <Text style={text}>Repositories come from an authorized JSON file the operator provides through PASEO_ORBI_CONFIG at plugin startup. The operator must provide or repair that file, then explicitly reload this plugin.</Text>
          <Text style={text}>The Setup guide only explains that operator procedure: it does not configure authorization, apply settings, discover repositories or reload the plugin. Host service inventory is independent, so Services still shows discovered Orbi units without a repository catalog.</Text>
        </View>}
        {(catalogReadFailed || !catalog || catalog.state === 'invalid') && <ActionButton label={query.refreshing ? 'Refreshing' : 'Refresh'} accessibilityName="Refresh"
          disabled={!query.canRefresh} busy={query.refreshing} theme={props.theme} onPress={() => { void query.refresh(); }} />}
      </View>}
      {catalog?.state === 'configured' && <>
        {catalog.entries.length === 0 && <Text style={text}>No configured deployments.</Text>}
        {catalog.entries.filter(entry => entry.status !== 'available').map(entry => <View key={entry.id}>
          <Text style={text}>{entry.label} ({entry.repo}): {entry.status}</Text>
          {entry.problems.map((p, i) => <Text key={i} style={text}>{p.source}: {p.code}</Text>)}
          <Text style={text}>Ask the operator to repair the authorized configuration/source profile and reload this plugin.</Text>
        </View>)}
      </>}
    </View>
    {route === 'services' ? <HostServices
      hostId={props.host.id} hostLabel={props.host.label} connected={connected} foreground={foreground}
      theme={props.theme} compact={props.layout.compact}
      entries={catalog?.entries ?? null} catalogUnconfigured={unconfiguredCatalog} catalogConfirmed={catalogConfirmed}
      openScreen={openScreen} query={inventory} selected={selectedService}
      onSelect={label => setSelectedService(label)}
      onBack={() => { restoreList.current = true; setSelectedService(null); }} />
      : route === 'fleet' ? <>
        <Work key={workKey} {...props} openScreen={openScreen} catalog={catalog ?? null}
          connected={connected} foreground={foreground} query={inventory} />
        {catalog?.state === 'configured' && <View testID="orbi-fleet">
          <ConfiguredRepositories key={`${props.host.id}:${props.params.deploymentId ?? ''}`} {...props} entries={catalog.entries} observedIds={observedIds}
            openScreen={openScreen} connected={connected} foreground={foreground} />
        </View>}
      </> : <>
        <View testID={`orbi-${route}`} style={{ gap: 12 }}>
          <Text style={text}>{title(route)} — select a repository to browse</Text>
          {catalog?.entries.filter(entry => entry.status === 'available').map(entry => <Text key={entry.id} accessibilityRole="button" accessibilityLabel={`Select ${entry.label}`} onPress={() => openScreen({ screenId: route, params: { deploymentId: entry.id } })} style={text}>{entry.label} ({entry.repo})</Text>)}
          {selectedDeployment && (route === 'issues'
            ? <Issues key={`${featureKey}:${requestedIssue ?? ''}`} deploymentId={selectedDeployment.id} repo={selectedDeployment.repo} hostId={props.host.id} connected={connected} foreground={foreground} theme={props.theme} openScreen={openScreen} initialIssue={requestedIssue} />
            : route === 'runs' ? <Runs key={`${featureKey}:${props.params.issue ?? ''}:${props.params.runId ?? ''}`} repo={selectedDeployment.repo} deploymentId={selectedDeployment.id} hostId={props.host.id} connected={connected} foreground={foreground} theme={props.theme} params={props.params} />
            : route === 'blockers' ? <Blockers key={featureKey} repo={selectedDeployment.repo} deploymentId={selectedDeployment.id} hostId={props.host.id} connected={connected} foreground={foreground} theme={props.theme} openScreen={openScreen} />
            : null)}
        </View>
      </>}
  </ScrollView>;
}
