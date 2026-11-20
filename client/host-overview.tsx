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

type FamilyFact = 'failed' | 'running' | 'idle' | 'waiting' | 'installed' | 'unknown';
const familyFactText: Record<FamilyFact, string> = {
  failed: 'Failed',
  running: 'Running',
  idle: 'Idle',
  waiting: 'Timer waiting',
  installed: 'Installed',
  unknown: 'Unknown / transitional',
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
  const idle = observed.filter(unit => unit.kind === 'service' && runtime(unit).loadState === 'loaded' && runtime(unit).activeState === 'inactive' && runtime(unit).subState === 'dead').length;
  const failed = observed.some(unit => runtime(unit).activeState === 'failed' || runtime(unit).subState === 'failed');
  const waiting = observed.some(unit => unit.kind === 'timer' && runtime(unit).activeState === 'active' && runtime(unit).subState === 'waiting');
  // Worker and timer facts stay independent: a running worker must not hide a
  // waiting timer, and a waiting timer must not hide an idle or failed worker.
  const facts: FamilyFact[] = [];
  if (failed) facts.push('failed');
  if (running > 0) facts.push('running');
  else if (idle > 0) facts.push('idle');
  if (waiting) facts.push('waiting');
  if (group.units.length > 0 && observed.length === 0) facts.push('installed');
  if (facts.length === 0) facts.push('unknown');
  return { facts };
}
function familyRank(group: InventoryGroup) {
  const { facts } = summarizeFamily(group);
  return facts.includes('failed') ? 0 : facts.includes('running') ? 1 : facts.includes('waiting') ? 2 : 3;
}
// Failed/attention, running, timer waiting, then other/not loaded; stable label tie-break.
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

// These names are presentation only: never use a slug for authorization or navigation.
const shortName = (label: string) => /^orbi-(.+)-[a-f0-9]{8}$/.exec(label)?.[1] ?? label;
function authorizedEntry(group: InventoryGroup, entries: DeploymentCatalog['entries'] | null) {
  const candidates = entries?.filter(candidate => candidate.id === group.deploymentId) ?? [];
  return group.association === 'matched' && candidates.length === 1 && candidates[0].status === 'available' ? candidates[0] : null;
}
function displayNames(groups: InventoryGroup[], entries: DeploymentCatalog['entries'] | null) {
  const names = new Map(groups.map(group => {
    const collision = groups.some(other => other.label !== group.label && shortName(other.label) === shortName(group.label));
    return [group.label, authorizedEntry(group, entries)?.repo ?? `${shortName(group.label)}${collision ? ` · ${group.label.slice(-8)}` : ''}`];
  }));
  // Resolve final-name collisions, including raw/short names and collisions
  // introduced by a fallback. Exact labels are unique inventory identities.
  for (;;) {
    const counts = new Map<string, number>();
    for (const name of names.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
    let changed = false;
    for (const [label, name] of names) {
      if (counts.get(name)! > 1 && name !== label) { names.set(label, label); changed = true; }
    }
    if (!changed) return names;
  }
}
const isFailed = (unit: InventoryUnit | undefined) => unit?.runtime != null && (unit.runtime.activeState === 'failed' || unit.runtime.subState === 'failed');
const compareSlots = (left: string, right: string) => {
  const a = left.replace(/^0+/, '') || '0', b = right.replace(/^0+/, '') || '0';
  return a.length - b.length || a.localeCompare(b) || left.localeCompare(right);
};
const slotOf = (group: InventoryGroup, unit: InventoryUnit) => {
  const match = /^(.*)@(\d+)\.(service|timer)$/.exec(unit.id);
  return match && match[1] === group.label ? match[2] : null;
};
// Collapsed rows name the first observed failure. A numbered slot is only
// claimed by exact family identity; otherwise the observed unit kind is named.
const failedUnits = (group: InventoryGroup) => group.units
  .filter(unit => isFailed(unit))
  .map(unit => ({ slot: slotOf(group, unit), kind: unit.kind === 'service' ? 'Worker' : 'Timer' }))
  .sort((left, right) => left.slot === null ? (right.slot === null ? 0 : 1) : right.slot === null ? -1 : compareSlots(left.slot, right.slot));
function failureSummary(group: InventoryGroup): string | null {
  const failures = failedUnits(group);
  if (failures.length === 0) return null;
  const first = failures[0];
  const label = first.slot === null ? `${first.kind} failed` : `Slot ${first.slot} · ${first.kind} failed`;
  return failures.length === 1 ? label : `${label} · +${failures.length - 1} more`;
}
function slotState(unit: InventoryUnit | undefined, timer = false): string {
  const prefix = timer ? 'Timer ' : '';
  if (!unit) return timer ? 'Timer not observed' : 'Service not observed';
  const runtime = unit.runtime;
  if (!runtime) return `${prefix}${timer ? 'unknown' : 'Unknown'}`;
  if (runtime.activeState === 'failed' || runtime.subState === 'failed') return `${prefix}${timer ? 'failed' : 'Failed'}`;
  if (runtime.loadState === 'not-found') return timer ? 'Timer not found' : 'Service not found';
  if (runtime.loadState !== 'loaded') return `${prefix}Load ${runtime.loadState} · ${runtime.activeState}/${runtime.subState}`;
  if (runtime.activeState === 'inactive' && runtime.subState === 'dead') return timer ? 'Timer idle' : 'Idle';
  if (runtime.activeState === 'active' && runtime.subState === (timer ? 'waiting' : 'running')) return timer ? 'Timer waiting' : 'Running';
  return `${prefix}${runtime.activeState}/${runtime.subState}`;
}
function slotLines(group: InventoryGroup): string[] {
  const slots = new Map<string, { service?: InventoryUnit; timer?: InventoryUnit }>();
  for (const unit of group.units) {
    const match = /^(.*)@(\d+)\.(service|timer)$/.exec(unit.id);
    if (!match || match[1] !== group.label) continue;
    const slot = slots.get(match[2]) ?? {};
    slot[match[3] as 'service' | 'timer'] = unit;
    slots.set(match[2], slot);
  }
  return [...slots].sort(([leftId, left], [rightId, right]) => {
    const severity = (slot: { service?: InventoryUnit; timer?: InventoryUnit }) => isFailed(slot.service) || isFailed(slot.timer) ? 0 : 1;
    return severity(left) - severity(right) || compareSlots(leftId, rightId);
  }).map(([id, slot]) => `Slot ${id} · ${slotState(slot.service)} · ${slotState(slot.timer, true)}`);
}
function FamilyRow({ group, hostId, theme, entries, openScreen, expanded, toggle, name }: {
  group: InventoryGroup; hostId: string; theme: PluginHostProps['theme'];
  entries: DeploymentCatalog['entries'] | null; openScreen: PluginClientContext['openScreen'];
  expanded: boolean; toggle: () => void; name: string;
}) {
  const text = { color: theme.colors.foreground };
  const secondary = { ...text, fontSize: 12 };
  const { facts } = summarizeFamily(group);
  const failure = failureSummary(group);
  // A named failure already carries the failed fact; do not repeat "Failed".
  const status = facts.filter(fact => fact !== 'failed' || failure === null);
  const entry = authorizedEntry(group, entries);
  const [technical, setTechnical] = useState(false);
  return <View testID={`orbi-family-${group.label}`} style={{ gap: 4, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: theme.colors.surface1 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${group.label}`} accessibilityState={{ expanded }}
      style={({ pressed }) => ({ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, opacity: pressed ? 0.65 : 1 })}
      onPress={toggle}>
      <View style={{ flexShrink: 1, gap: 4 }}>
        <Text style={{ ...text, fontSize: 16, fontWeight: '600' }}>{name}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {failure !== null && <Text style={secondary}>{failure}</Text>}
          {status.map(fact => <Text key={fact} style={secondary}>{familyFactText[fact]}</Text>)}
          {!entry && <Text style={secondary}>Unlinked</Text>}
        </View>
      </View>
      <Text testID={`orbi-chevron-${group.label}`} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={text}>{expanded ? '▾' : '▸'}</Text>
    </Pressable>
    {entry !== null && <Pressable accessibilityRole="button" accessibilityLabel={`View repository ${entry.label}`}
      style={{ minHeight: 44, justifyContent: 'center' }}
      onPress={() => openScreen({ screenId: 'issues', params: { deploymentId: entry.id } })}><Text style={text}>View repository</Text></Pressable>}
    {expanded && <View style={{ gap: 2 }}>
      {slotLines(group).map(line => <Text key={line} style={text}>{line}</Text>)}
      <Pressable accessibilityRole="button" accessibilityLabel={`Unit details for ${group.label}`} accessibilityState={{ expanded: technical }}
        style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', opacity: pressed ? 0.65 : 1 })} onPress={() => setTechnical(value => !value)}><Text style={text}>Unit details</Text></Pressable>
      {technical && <View style={{ gap: 2 }}>
        <Text style={text}>{group.label}</Text>
        <Text style={text}>{associationText(group, entry)}</Text>
        <Text style={text}>Unit activity does not establish issue delivery.</Text>
        {group.units.map(unit => <Text key={`${hostId}:${unit.id}`} style={text}>{unitLine(unit)}</Text>)}
      </View>}
    </View>}
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
  const [setupExpanded, setSetupExpanded] = useState(false);
  const observation = query.observation;
  const data = observation?.data ?? null;
  const families = sortFamilies(data?.groups ?? []);
  const names = displayNames(families, entries);
  const attention = families.filter(group => summarizeFamily(group).facts.includes('failed')).length;
  const off = data?.state === 'off';
  const state = data?.state ?? (!connected || !foreground ? 'unavailable' : 'loading');
  // Only fresh evidence may publish counts, and only a fresh complete empty
  // check may publish absence. Off/loading, unavailable, stale and offline are
  // undecided, not empty.
  const evidence = data !== null && (data.state === 'complete' || data.state === 'partial');
  const current = evidence && connected && foreground
    && (observation?.state === 'available' || observation?.state === 'partial');
  // A partial check with no confirmed rows may be missing units; it never
  // publishes a zero count that could read as an empty host.
  const countEvidence = current && (families.length > 0 || data?.state === 'complete');
  const inventoryProblems = (data?.problems ?? []).map(problem => `${problem.source}: ${problem.code}`);
  const transportProblems = observation?.problems.map(problem => `${problem.source}: ${problem.code}`) ?? [];
  const problems = [...inventoryProblems, ...transportProblems].join('; ');
  const limited = (data?.problems ?? []).some(problem => ['malformed_record', 'read_limit', 'row_limit'].includes(problem.code));
  const failed = (data?.problems ?? []).some(problem => ['process_failed', 'process_timeout', 'process_limit'].includes(problem.code));
  const stale = observation?.state === 'stale' && observation.lastSuccessfulAt !== null;
  const copies = [
    current && data?.state === 'complete' && families.length === 0 ? 'No Orbi units found.' : '',
    current && data?.state === 'partial' && families.length === 0 ? 'Partial · no units confirmed; units may be missing.' : '',
    current && data?.state === 'partial' && families.length > 0 ? 'Partial · units may be missing.' : '',
    data?.state === 'unavailable' ? 'Unavailable · current activity unknown.' : '',
    state === 'loading' ? 'Reading services…' : '',
    stale ? `Last success: ${observation!.lastSuccessfulAt}` : '',
    failed ? 'Read failed · check systemd/DBus access.' : '',
    limited ? 'Read limited · units may be missing.' : '',
  ].filter(Boolean);
  const panel = { gap: compact ? 8 : 12 };
  return <View testID="orbi-host-services" style={panel}>
    <Text accessibilityRole="header" testID="orbi-overview-heading" style={text}>{`${hostLabel} · Fleet`}</Text>
    <Text style={text}>{off ? 'Service check off · activity unknown' : stale ? 'Stale · current activity unknown' : `Services: ${state === 'complete' ? 'Current' : state}`}</Text>
    {countEvidence && families.length > 0 && <Text testID="orbi-attention-count" style={text}>{`${attention} of ${families.length} groups ${attention === 1 ? 'needs' : 'need'} attention`}</Text>}
    {!connected && <Text style={text}>Offline · current activity unknown</Text>}
    {connected && !foreground && <Text style={text}>The app is in the background. Host service reads are paused.</Text>}
    {!!problems && <Text accessibilityRole="alert" style={text}>{problems}</Text>}
    {off ? <View style={{ gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Set up service access" accessibilityState={{ expanded: setupExpanded }}
        style={{ minHeight: 44, justifyContent: 'center' }}
        onPress={() => setSetupExpanded(value => !value)}><Text style={text}>{setupExpanded ? 'Hide service access setup' : 'Set up service access'}</Text></Pressable>
      {setupExpanded && <View accessibilityLabel="Service access setup" style={{ gap: 8 }}>
        <Text style={text}>Host service inventory is not enabled on this host. The operator can opt in with PASEO_ORBI_HOST_INVENTORY=1 at plugin startup and explicitly authorize a reload.</Text>
        <Text style={text}>Connected clients on this host can then see Orbi unit names. No other host is read. Refresh cannot enable access or reload this plugin.</Text>
      </View>}
    </View> : <Pressable accessibilityRole="button" accessibilityLabel="Refresh services" disabled={!query.canRefresh}
      accessibilityState={{ disabled: !query.canRefresh, busy: query.refreshing }}
      style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', borderWidth: 1, borderColor: theme.colors.foreground, borderRadius: 8, paddingHorizontal: 12, opacity: !query.canRefresh ? 0.5 : pressed ? 0.7 : 1 })}
      onPress={query.refresh}><Text style={text}>{query.refreshing ? 'Refreshing' : 'Refresh services'}</Text></Pressable>}
    {copies.map(copy => <Text key={copy} style={text}>{copy}</Text>)}
    {families.map(group => <FamilyRow key={`${hostId}:${group.label}`} group={group} hostId={hostId} theme={theme} entries={entries} openScreen={openScreen}
      name={names.get(group.label)!}
      expanded={expanded === group.label} toggle={() => setExpanded(expanded === group.label ? null : group.label)} />)}
  </View>;
}
