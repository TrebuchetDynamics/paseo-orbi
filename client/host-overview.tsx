import { useState } from 'react';
import type { PluginClientContext, PluginHostProps } from '@getpaseo/plugin/client';
import { useRpc } from '@getpaseo/plugin/client';
import { Pressable, Text, View } from 'react-native';
import type { DeploymentCatalog, Observation } from '../shared/common';
import { servicesInventory, type InventoryGroup, type InventoryUnit, type ServiceInventory } from '../shared/services';
import { useObservationQuery } from './observation';

// Host-first Overview. It reads one host-scoped services.inventory({}) snapshot
// and never resolves a repository: an association carries a deployment id only
// when the server already validated a unique exact unit-name prefix, and the
// client still requires that deployment to be available in the current catalog.

type FamilyFact = 'failed' | 'running' | 'scheduled' | 'installed' | 'notRunning';
const familyFactText: Record<FamilyFact, string> = {
  failed: 'Failed',
  running: 'Running · Issue unknown',
  scheduled: 'Scheduled · no runner observed running',
  installed: 'Installed',
  notRunning: 'Not running · Issue unknown',
};

export function useHostServicesQuery(options: { hostId: string; connected: boolean; foreground: boolean }) {
  const read = useRpc(servicesInventory);
  return useObservationQuery<ServiceInventory>({
    hostId: options.hostId, deploymentId: 'host', selector: 'services.inventory',
    connected: options.connected, foreground: options.foreground,
    read: async (): Promise<Observation<ServiceInventory>> => {
      const data = await read({});
      const observedAt = data.observedAt ?? new Date().toISOString();
      // Only a check that actually produced host evidence may be retained as a
      // success. 'off' is a startup permission answer and 'unavailable' is a
      // denied or failed read; neither may later read as this host's last
      // successful observation.
      const succeeded = data.state === 'complete' || data.state === 'partial';
      return {
        state: data.state === 'partial' ? 'partial' : data.state === 'unavailable' ? 'unavailable' : 'available',
        observedAt, lastSuccessfulAt: succeeded ? observedAt : null,
        data, problems: [],
      };
    },
  });
}

// Only observed service instances count as running. A timer schedule, an
// installed/template name and a starting or active/exited service are not
// running services; one family keeps every supported fact visible at once.
function summarizeFamily(group: InventoryGroup) {
  const observed = group.units.filter(unit => unit.runtime !== null);
  const runtime = (unit: InventoryUnit) => unit.runtime!;
  const running = observed.filter(unit => unit.kind === 'service' && runtime(unit).activeState === 'active' && runtime(unit).subState === 'running').length;
  const failed = observed.some(unit => runtime(unit).activeState === 'failed' || runtime(unit).subState === 'failed');
  const waiting = observed.some(unit => unit.kind === 'timer' && runtime(unit).activeState === 'active' && runtime(unit).subState === 'waiting');
  const facts: FamilyFact[] = [];
  if (failed) facts.push('failed');
  if (running > 0) facts.push('running');
  else if (waiting) facts.push('scheduled');
  if (group.units.length > 0 && observed.length === 0) facts.push('installed');
  if (facts.length === 0) facts.push('notRunning');
  return { facts, running };
}
function familyRank(group: InventoryGroup) {
  const { facts } = summarizeFamily(group);
  return facts.includes('failed') ? 0 : facts.includes('running') ? 1 : facts.includes('scheduled') ? 2 : 3;
}
// Failed/attention, running, scheduled, then other/not loaded; stable label tie-break.
function sortFamilies(groups: readonly InventoryGroup[]): InventoryGroup[] {
  return [...groups].sort((left, right) => familyRank(left) - familyRank(right) || (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));
}
// Configured deployments that this host check actually observed through a
// unique authorized association. Discovery alone never appears here. A check
// that produced no evidence ('off', denied/unavailable) returns null so a
// deployment row never claims "not observed" from a check that failed.
export function observedDeploymentIds(inventory: ServiceInventory | null | undefined): string[] | null {
  if (!inventory || (inventory.state !== 'complete' && inventory.state !== 'partial')) return null;
  return [...new Set(inventory.groups.filter(group => group.association === 'matched' && group.deploymentId !== null).map(group => group.deploymentId!))];
}

// A route change mounts a fresh Overview screen. One expanded family is retained
// per host+repository surface so in-page navigation keeps the host-scoped family,
// and it is discarded when that host or repository identity changes.
let retained: { surface: string; label: string | null } = { surface: '', label: null };
export function resetHostOverviewState() { retained = { surface: '', label: null }; }
function useExpandedFamily(surface: string) {
  const [expanded, setExpanded] = useState<string | null>(retained.surface === surface ? retained.label : null);
  return [expanded, (label: string | null) => { retained = { surface, label }; setExpanded(label); }] as const;
}

const unitLine = (unit: InventoryUnit) => {
  const runtime = unit.runtime === null ? 'runtime not observed' : `${unit.runtime.activeState}/${unit.runtime.subState}, load ${unit.runtime.loadState}`;
  const template = unit.id.includes('@.') ? ' (template, not a running service)' : '';
  return `${unit.id}: ${runtime}; unit file ${unit.unitFileState ?? 'not observed'}${template}`;
};
const associationText = (group: InventoryGroup, entry: DeploymentCatalog['entries'][number] | null) => {
  if (group.association === 'matched') {
    return entry
      ? `Matches configured deployment ${entry.label} (${entry.repo}) by unit name. Unit origin is not verified; this association is display-only.`
      : 'Associated deployment is not in the current authorized catalog. Repository detail stays unavailable until the operator restores authorization and reloads.';
  }
  if (group.association === 'incompatible') {
    return 'A configured deployment claims this unit prefix, but its source profile is unsupported for repository detail. This compatibility limit does not mean the runner is broken.';
  }
  if (group.association === 'ambiguous') {
    return 'Multiple configured deployments claim this unit prefix. Repository detail stays unavailable until the operator makes the association unique.';
  }
  return 'Discovered on this host only; no configured deployment claims this unit name, so repository detail is unavailable. Discovery is not authority.';
};

function FamilyRow({ group, hostId, theme, entries, openScreen, expanded, toggle }: {
  group: InventoryGroup; hostId: string; theme: PluginHostProps['theme'];
  entries: DeploymentCatalog['entries'] | null; openScreen: PluginClientContext['openScreen'];
  expanded: boolean; toggle: () => void;
}) {
  const text = { color: theme.colors.foreground };
  const { facts } = summarizeFamily(group);
  const entry = group.association === 'matched' && group.deploymentId !== null
    ? entries?.find(candidate => candidate.id === group.deploymentId && candidate.status === 'available') ?? null
    : null;
  return <View testID={`orbi-family-${group.label}`} style={{ gap: 4, padding: 8, borderWidth: 1, borderColor: theme.colors.foreground }}>
    <Text style={text}>{group.label}</Text>
    <Text style={text}>Host unit family ({group.kind})</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {facts.map(fact => <Text key={fact} style={text}>{familyFactText[fact]}</Text>)}
    </View>
    <Text style={text}>{associationText(group, entry)}</Text>
    {entry !== null && <Pressable accessibilityRole="button" accessibilityLabel={`View repository ${entry.label}`}
      style={{ padding: 4, borderWidth: 1, borderColor: theme.colors.foreground }}
      onPress={() => openScreen({ screenId: 'issues', params: { deploymentId: entry.id } })}><Text style={text}>View repository</Text></Pressable>}
    <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${group.label}`} accessibilityState={{ expanded }}
      style={{ padding: 4, borderWidth: 1, borderColor: theme.colors.foreground }}
      onPress={toggle}><Text style={text}>{expanded ? 'Hide slots' : 'Inspect slots'}</Text></Pressable>
    {expanded && <View style={{ gap: 2 }}>{group.units.map(unit => <Text key={`${hostId}:${unit.id}`} style={text}>{unitLine(unit)}</Text>)}</View>}
  </View>;
}

export function HostServices({ hostId, hostLabel, surfaceKey, connected, foreground, theme, compact, entries, openScreen, query }: {
  hostId: string; hostLabel: string; surfaceKey: string; connected: boolean; foreground: boolean;
  theme: PluginHostProps['theme']; compact: boolean;
  entries: DeploymentCatalog['entries'] | null; openScreen: PluginClientContext['openScreen'];
  query: ReturnType<typeof useHostServicesQuery>;
}) {
  const text = { color: theme.colors.foreground };
  const [expanded, setExpanded] = useExpandedFamily(surfaceKey);
  const observation = query.observation;
  const data = observation?.data ?? null;
  const families = sortFamilies(data?.groups ?? []);
  const attention = families.filter(group => summarizeFamily(group).facts.includes('failed')).length;
  const state = data?.state ?? (!connected || !foreground ? 'unavailable' : 'loading');
  const inventoryProblems = (data?.problems ?? []).map(problem => `${problem.source}: ${problem.code}`);
  const transportProblems = observation?.problems.map(problem => `${problem.source}: ${problem.code}`) ?? [];
  const problems = [...inventoryProblems, ...transportProblems].join('; ');
  const limited = (data?.problems ?? []).some(problem => ['malformed_record', 'read_limit', 'row_limit'].includes(problem.code));
  const failed = (data?.problems ?? []).some(problem => ['process_failed', 'process_timeout', 'process_limit'].includes(problem.code));
  const stale = observation?.state === 'stale' && observation.lastSuccessfulAt !== null;
  const copies = [
    data?.state === 'off' ? 'Host service inventory is not enabled on this host. The operator can opt in with PASEO_ORBI_HOST_INVENTORY=1 at plugin startup and explicitly authorize a reload.' : '',
    data?.state === 'complete' && families.length === 0 ? "No matching Orbi user units found in the selected host's user services (complete check)." : '',
    data?.state === 'partial' && families.length === 0 ? 'No Orbi user units confirmed on this host. Other units may be missing because at least one host source did not complete; do not treat this as empty.' : '',
    data?.state === 'partial' && families.length > 0 ? 'Some host service sources did not complete; other Orbi user units may be missing on this host.' : '',
    data?.state === 'unavailable' ? 'Current activity on this host is unknown: its user services could not be read; reads may have been denied.' : '',
    state === 'loading' ? "Reading the selected host's user services." : '',
    stale ? `Showing this host's last successful observation from ${observation!.lastSuccessfulAt}; current activity is unknown.` : '',
    failed ? 'Ask the operator to check user systemd/DBus access on this host, then Refresh.' : '',
    limited ? 'The host output exceeded the bounded reader; this is not an empty inventory.' : '',
  ].filter(Boolean);
  const panel = { gap: 8, padding: compact ? 12 : 16, borderWidth: 1, borderColor: theme.colors.foreground };
  return <View testID="orbi-host-services" style={panel}>
    <Text accessibilityRole="header" testID="orbi-overview-heading" style={text}>{`Your Linux user services — ${hostLabel}`}</Text>
    <Text style={text}>{`Host service check: ${state}`}</Text>
    <Text style={text}>{`Observed unit families: ${families.length}; families with failed units: ${attention}. Observed unit activity is not an active delivery.`}</Text>
    <Text style={text}>{`Last check: ${data?.observedAt ?? 'not yet observed'}; last successful check: ${observation?.lastSuccessfulAt ?? 'never'}`}</Text>
    {!connected && <Text style={text}>Selected host is offline. Host service reads are paused and current activity is unknown. Reconnect this host, then Refresh.</Text>}
    {connected && !foreground && <Text style={text}>The app is in the background. Host service reads are paused.</Text>}
    <Text accessibilityRole="alert" style={text}>{problems}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Refresh host services" disabled={!query.canRefresh}
      accessibilityState={{ disabled: !query.canRefresh, busy: query.refreshing }}
      style={{ padding: 4, borderWidth: 1, borderColor: theme.colors.foreground, opacity: query.canRefresh ? 1 : 0.5 }}
      onPress={query.refresh}><Text style={text}>{query.refreshing ? 'Refreshing' : 'Refresh'}</Text></Pressable>
    {copies.map(copy => <Text key={copy} style={text}>{copy}</Text>)}
    {families.map(group => <FamilyRow key={`${hostId}:${group.label}`} group={group} hostId={hostId} theme={theme} entries={entries} openScreen={openScreen}
      expanded={expanded === group.label} toggle={() => setExpanded(expanded === group.label ? null : group.label)} />)}
  </View>;
}
