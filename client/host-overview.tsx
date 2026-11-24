import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PluginClientContext, PluginHostProps } from '@getpaseo/plugin/client';
import { useRpc } from '@getpaseo/plugin/client';
import { Text, View } from 'react-native';
import type { ControlAction, DeploymentCatalog, Observation } from '../shared/common';
import { servicesInventory, type InventoryGroup, type InventoryUnit, type ServiceInventory } from '../shared/services';
import type { ControlObservation, ControlOutcome, ControlReason } from '../shared/service-control';
import { servicesControl } from '../shared/service-control';
import { claimOf, readingEvidence, useObservationQuery } from './observation';
import { ActionButton } from './action-button';
import { associationOf, authorizedEntry, displayNames, type CatalogEvidence } from './repository-catalog';

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
      const succeeded = readingEvidence(data.state);
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
  const services = group.units.filter(unit => unit.kind === 'service');
  const running = observed.filter(unit => unit.kind === 'service' && runtime(unit).activeState === 'active' && runtime(unit).subState === 'running').length;
  const idle = observed.filter(unit => unit.kind === 'service' && runtime(unit).loadState === 'loaded' && runtime(unit).activeState === 'inactive' && runtime(unit).subState === 'dead').length;
  const failed = observed.some(unit => runtime(unit).activeState === 'failed' || runtime(unit).subState === 'failed');
  const waiting = observed.some(unit => unit.kind === 'timer' && runtime(unit).activeState === 'active' && runtime(unit).subState === 'waiting');
  // Worker and timer facts stay independent: a running worker must not hide a
  // waiting timer, and a waiting timer must not hide an idle or failed worker.
  const facts: FamilyFact[] = [];
  if (failed) facts.push('failed');
  if (running > 0) facts.push('running');
  // Idle describes the group's workers, so every service instance must be
  // positively observed idle. A transitional (active/exited, activating) or
  // not-observed worker keeps its unknown/transitional fact instead.
  else if (idle > 0 && idle === services.length) facts.push('idle');
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
// One compact attention summary for the Work surface, computed from the same
// evidence the detailed rows use. A denied, off or failed check publishes no
// count at all; a partial check counts only observed groups.
export function serviceAttention(inventory: ServiceInventory | null | undefined) {
  if (!inventory || !readingEvidence(inventory.state)) return null;
  return {
    failed: inventory.groups.filter(group => summarizeFamily(group).facts.includes('failed')).length,
    total: inventory.groups.length,
    partial: inventory.state === 'partial',
  };
}

// Configured deployments that this host check actually observed through a
// unique authorized association. Discovery alone never appears here. A check
// that produced no evidence ('off', denied/unavailable) returns null so a
// deployment row never claims "not observed" from a check that failed.
export function observedDeploymentIds(inventory: ServiceInventory | null | undefined): string[] | null {
  if (!inventory || !readingEvidence(inventory.state)) return null;
  return [...new Set(inventory.groups.filter(group => group.association === 'matched' && group.deploymentId !== null).map(group => group.deploymentId!))];
}

const unitLine = (unit: InventoryUnit) => {
  const runtime = unit.runtime === null ? 'runtime not observed' : `${unit.runtime.activeState}/${unit.runtime.subState}, load ${unit.runtime.loadState}`;
  const template = unit.id.includes('@.') ? ' (template, not a running service)' : '';
  return `${unit.id}: ${runtime}; unit file ${unit.unitFileState ?? 'not observed'}${template}`;
};
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
// A numeric slot has two subjects: the worker that runs a delivery and the timer
// that schedules the check. Both are named in reading order, and a fact about one
// never implies a fact about the other.
function slotState(unit: InventoryUnit | undefined, timer = false): string {
  const subject = timer ? 'Timer' : 'Worker';
  if (!unit) return `${subject} not observed`;
  const runtime = unit.runtime;
  if (!runtime) return `${subject} unknown`;
  if (runtime.activeState === 'failed' || runtime.subState === 'failed') return `${subject} failed`;
  if (runtime.loadState === 'not-found') return `${subject} not found`;
  if (runtime.loadState !== 'loaded') return `${subject} load ${runtime.loadState} · ${runtime.activeState}/${runtime.subState}`;
  if (runtime.activeState === 'inactive' && runtime.subState === 'dead') return `${subject} idle`;
  if (runtime.activeState === 'active' && runtime.subState === (timer ? 'waiting' : 'running')) return timer ? 'Timer waiting' : 'Worker running';
  return `${subject} ${runtime.activeState}/${runtime.subState}`;
}
// One explanation for the whole list, not once per slot: the two subjects are
// parts of one slot, so neither an idle worker nor a waiting timer is a second
// service and a waiting timer does not establish that an issue is queued.
const slotExplanation = 'The timer schedules a check. The worker runs it. They are two parts of the same slot, not two workers.';
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

// ---- Operator-authorized service controls -----------------------------------
// The client only ever names an approved deployment, an observed slot inside
// the catalog's approved bound, and an approved action. The exact unit and the
// lifecycle command are derived on the daemon; a display label is never
// authority and this screen cannot widen the operator grant.

const actionText: Record<ControlAction, string> = { start: 'Start', stop: 'Stop', restart: 'Restart' };
const effectText: Record<ControlAction, string> = {
  start: 'start this runner slot so its scheduler can pick up work',
  stop: 'stop this runner slot through its operator-bound Orbi lifecycle command',
  restart: 'restart this runner slot; it is only offered while idle or failed, never during a possible delivery',
};
const reasonText: Record<ControlReason, string> = {
  deployment_unavailable: 'Not approved: this repository is not in the current authorized configuration.',
  action_not_approved: 'Not approved: the operator has not granted this action for this repository.',
  target_out_of_range: "Not approved: this slot is outside the repository's approved targets.",
  active_delivery: 'Refused: this slot is running or transitional, so it may have an active delivery. Restart is offered only while it is idle or failed.',
  disposed: 'Not sent: the plugin is stopping or its operator grant was withdrawn.',
  busy: 'Another action for this repository is still in progress. Nothing else was sent.',
  process_failed: 'The lifecycle command failed. Check the slot state before trying again.',
  process_timeout: 'Outcome unknown: the lifecycle command did not finish in time and may still be running. Recheck the slot before trying again.',
  process_limit: 'Not sent: too many lifecycle commands are already running.',
  observe_failed: 'Outcome unknown: the slot state could not be re-read. Recheck the slot before trying again.',
};
function observedText(observed: ControlObservation | null): string {
  if (!observed) return 'state not re-observed';
  if (observed.activeState === 'failed' || observed.subState === 'failed') return 'Failed';
  if (observed.loadState === 'not-found') return 'Unit not found';
  if (observed.activeState === 'inactive' && observed.subState === 'dead') return 'Idle';
  if (observed.activeState === 'active' && observed.subState === 'running') return 'Running';
  return `${observed.activeState}/${observed.subState}`;
}
// Numeric instances this row actually observed, bounded by the operator-approved
// target range. An unobserved or out-of-range instance is never offered.
function controlSlots(group: InventoryGroup, bound: number): number[] {
  const slots = new Set<number>();
  for (const unit of group.units) {
    const match = /^(.+)@(\d+)\.(?:service|timer)$/.exec(unit.id);
    if (!match || match[1] !== group.label) continue;
    const slot = Number(match[2]);
    if (Number.isSafeInteger(slot) && slot >= 1 && slot <= bound) slots.add(slot);
  }
  return [...slots].sort((left, right) => left - right);
}
type ControlFeedback = Readonly<{
  action: ControlAction; slot: number; outcome: ControlOutcome; reason: ControlReason | null;
  observed: ControlObservation | null; transport: boolean;
}>;
function feedbackText(feedback: ControlFeedback): string {
  if (feedback.transport) return `${actionText[feedback.action]} outcome unknown · Slot ${feedback.slot} · the request did not complete. Nothing is reported as success; recheck the slot before trying again.`;
  if (feedback.outcome === 'pending') return reasonText.busy;
  if (feedback.outcome === 'denied') return feedback.reason === null ? 'Not sent.' : reasonText[feedback.reason];
  const state = observedText(feedback.observed);
  const reason = feedback.reason === null ? '' : ` ${reasonText[feedback.reason]}`;
  if (feedback.outcome === 'succeeded') return `${actionText[feedback.action]} succeeded · Slot ${feedback.slot} · ${state}`;
  if (feedback.outcome === 'failed') return `${actionText[feedback.action]} failed · Slot ${feedback.slot} · ${state}.${reason}`;
  return `${actionText[feedback.action]} outcome unknown · Slot ${feedback.slot} · ${state}.${reason} No automatic retry was made.`;
}

function FamilyActions({ hostId, hostLabel, entry, group, theme }: {
  hostId: string; hostLabel: string; entry: DeploymentCatalog['entries'][number];
  group: InventoryGroup; theme: PluginHostProps['theme'];
}) {
  const text = { color: theme.colors.foreground };
  const secondary = { ...text, fontSize: 12 };
  const call = useRpc(servicesControl);
  const controls = entry.controls;
  const slots = controls === null ? [] : controlSlots(group, controls.slots);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<{ action: ControlAction; slot: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<ControlFeedback | null>(null);
  // A host switch unmounts this row (it is keyed by host and family). This guard
  // only stops a late answer from publishing into a row that is already gone.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  if (controls === null) return null;

  const submit = async (action: ControlAction, slot: number) => {
    if (sending) return;
    setSending(true);
    try {
      const result = await call({ deploymentId: entry.id, slot, action });
      if (!mounted.current) return;
      setFeedback({ action, slot, outcome: result.outcome, reason: result.reason, observed: result.observed, transport: false });
      setConfirming(null);
    } catch {
      // A failed transport is not evidence that nothing ran, so it is never
      // reported as success and never retried automatically.
      if (!mounted.current) return;
      setFeedback({ action, slot, outcome: 'unknown', reason: null, observed: null, transport: true });
      setConfirming(null);
    } finally { if (mounted.current) setSending(false); }
  };

  return <View testID={`orbi-actions-${group.label}`} style={{ gap: 8 }}>
    <ActionButton label={open ? 'Hide actions' : 'Actions'} accessibilityName={`Actions for ${group.label}`}
      expanded={open} theme={theme} onPress={() => setOpen(value => !value)} />
    {open && <View style={{ gap: 8 }}>
      {slots.length === 0 && <Text style={text}>No observed slot is inside this repository's approved targets.</Text>}
      {slots.map(slot => {
        const service = group.units.find(unit => unit.kind === 'service' && unit.id === `${group.label}@${slot}.service`);
        const pending = confirming !== null && confirming.slot === slot;
        return <View key={`${hostId}:${group.label}:${slot}`} style={{ gap: 4 }}>
          <Text style={text}>{`Slot ${slot} · ${slotState(service)}`}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {controls.actions.map(action => <ActionButton key={action} label={actionText[action]}
              accessibilityName={`${actionText[action]} slot ${slot}`}
              variant={action === 'start' ? 'primary' : action === 'stop' ? 'danger' : 'secondary'}
              disabled={sending || confirming !== null}
              busy={sending && pending && confirming?.action === action} theme={theme}
              onPress={() => { setFeedback(null); setConfirming({ action, slot }); }} />)}
          </View>
          {pending && confirming !== null && <View testID={`orbi-confirm-${group.label}-${slot}`} style={{ gap: 4 }}>
            <Text style={text}>{`Confirm ${actionText[confirming.action].toLowerCase()} · Slot ${slot}`}</Text>
            <Text style={text}>{`Host: ${hostLabel}`}</Text>
            <Text style={text}>{`Repository: ${entry.repo}`}</Text>
            <Text style={text}>{`Target: ${group.label}@${slot}.service`}</Text>
            <Text style={text}>{`Effect: ${effectText[confirming.action]}`}</Text>
            <Text style={secondary}>Confirmation is not authorization. The daemon rechecks the operator grant before it runs anything.</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <ActionButton label={sending ? 'Submitting…' : `Confirm ${actionText[confirming.action].toLowerCase()}`}
                accessibilityName={`Confirm ${actionText[confirming.action].toLowerCase()} slot ${slot}`}
                variant={confirming.action === 'stop' ? 'danger' : 'primary'} disabled={sending} busy={sending} theme={theme}
                onPress={() => void submit(confirming.action, slot)} />
              <ActionButton label="Cancel" accessibilityName={`Cancel ${actionText[confirming.action].toLowerCase()} slot ${slot}`}
                disabled={sending} theme={theme} onPress={() => setConfirming(null)} />
            </View>
          </View>}
        </View>;
      })}
      {feedback !== null && <Text accessibilityRole="alert" testID={`orbi-control-result-${group.label}`} style={text}>{feedbackText(feedback)}</Text>}
    </View>}
  </View>;
}

// One row per observed group. There is no disclosure, chevron or hidden
// inventory: the row names the group, its verified repository (or unlinked
// display name), the readable worker/scheduler facts and the first failed slot
// without a tap. Raw unit data stays on the diagnostic view, never on a row.
function ServiceRow({ group, name, theme, entries, openScreen, showUnlinked, lastSeen, onDetails }: {
  group: InventoryGroup; name: string; theme: PluginHostProps['theme'];
  entries: DeploymentCatalog['entries'] | null; openScreen: PluginClientContext['openScreen'];
  showUnlinked: boolean;
  // Set only when the whole snapshot is retained after a failed refresh or a
  // disconnect. It lives on the row so the retained facts never read as current
  // once the header has scrolled away.
  lastSeen: string | null;
  onDetails: () => void;
}) {
  const text = { color: theme.colors.foreground };
  const secondary = { ...text, fontSize: 12 };
  const { facts } = summarizeFamily(group);
  const failure = failureSummary(group);
  // A named failure already carries the failed fact; do not repeat "Failed".
  const status = facts.filter(fact => fact !== 'failed' || failure === null);
  const entry = authorizedEntry(group, entries);
  return <View testID={`orbi-family-${group.label}`} style={{ gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: theme.colors.surface1 }}>
    <Text style={{ ...text, fontSize: 16, fontWeight: '600' }}>{name}</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {lastSeen !== null && <Text testID={`orbi-last-seen-${group.label}`} style={secondary}>{`Last seen ${lastSeen}`}</Text>}
      {failure !== null && <Text style={secondary}>{failure}</Text>}
      {status.map(fact => <Text key={fact} style={secondary}>{familyFactText[fact]}</Text>)}
      {showUnlinked && !entry && <Text style={secondary}>Unlinked</Text>}
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <ActionButton label="Details" accessibilityName={`Details for ${name}`} theme={theme} onPress={onDetails} />
      {entry !== null && <ActionButton label="View repository" accessibilityName={`View repository ${entry.label}`} theme={theme}
        onPress={() => openScreen({ screenId: 'issues', params: { deploymentId: entry.id } })} />}
    </View>
  </View>;
}

// Host-scoped detail view. A selected label is only a selection: every fact is
// resolved again from the selected host's current inventory evidence, so a
// passed or stale unit/path can never become authority for what is shown. The
// service name, failed-first slot facts and freshness lead; setup material and
// the raw unit records never occupy the default view.
export function ServiceDetails({ hostId, hostLabel, group, name, theme, entries, openScreen, onBack, lastSeen, catalogEvidence }: {
  hostId: string; hostLabel: string; theme: PluginHostProps['theme'];
  group: InventoryGroup | null; name: string | null;
  entries: DeploymentCatalog['entries'] | null;
  openScreen: PluginClientContext['openScreen'];
  onBack: () => void;
  // Retained evidence keeps its last successful time here too, so the facts on
  // this view never read as a current observation.
  lastSeen: string | null;
  // The shell's explicit catalog evidence: only a settled read can confirm or rule
  // out a link, so a pending read is never reported as a failure or an absence.
  catalogEvidence: CatalogEvidence;
}) {
  const text = { color: theme.colors.foreground };
  const secondary = { ...text, fontSize: 12 };
  const entry = group === null ? null : authorizedEntry(group, entries);
  // One classification owns both association sentences: the short line that
  // leads this view and the long explanation revealed by View diagnostics.
  const association = group === null ? null : associationOf(group, entry, catalogEvidence);
  // Only a group with numeric slots gets the explanation: an absent slot is not
  // invented and an empty list gains no diagnostic clutter.
  const slots = group === null ? [] : slotLines(group);
  // Diagnostics are a local disclosure: activating it reads nothing and changes
  // no state outside this view. A different selection starts closed again.
  const [diagnostics, setDiagnostics] = useState(false);
  useEffect(() => { setDiagnostics(false); }, [group?.label]);
  return <View testID="orbi-service-details" style={{ gap: 8 }}>
    <Text accessibilityRole="header" testID="orbi-service-details-heading" style={text}>{`Service details · ${hostLabel}`}</Text>
    <ActionButton label="Back to services" accessibilityName="Back to services" theme={theme} onPress={onBack} />
    {group === null || name === null
      ? <Text testID="orbi-service-details-missing" style={text}>This service is not in the current host evidence. Refresh services to re-read this host; no other host or passed unit is used.</Text>
      : <>
        {/* Name, failed-first slot facts and freshness lead; setup and raw units never occupy this view. */}
        <Text style={{ ...text, fontSize: 16, fontWeight: '600' }}>{name}</Text>
        {slots.map(line => <Text key={line} style={text}>{line}</Text>)}
        {lastSeen !== null && <Text testID="orbi-service-details-last-seen" style={text}>{`Last seen ${lastSeen}. Current activity unknown.`}</Text>}
        <Text testID="orbi-service-association" style={text}>{association!.note}</Text>
        <Text style={text}>Unit activity does not establish issue delivery.</Text>
        {entry !== null && <FamilyActions hostId={hostId} hostLabel={hostLabel} entry={entry} group={group} theme={theme} />}
        <ActionButton label="View diagnostics" accessibilityName="View diagnostics" expanded={diagnostics}
          theme={theme} onPress={() => setDiagnostics(value => !value)} />
        {diagnostics && <View accessibilityLabel="Service diagnostics" testID="orbi-service-diagnostics" style={{ gap: 8 }}>
          {slots.length > 0 && <Text testID="orbi-service-slot-explanation" style={text}>{slotExplanation}</Text>}
          <Text style={text}>{association!.detail}</Text>
          <Text style={text}>Raw unit data follows.</Text>
          <View testID="orbi-service-units" style={{ gap: 2 }}>
            {group.units.map(unit => <Text key={`${hostId}:${unit.id}`} style={secondary}>{unitLine(unit)}</Text>)}
          </View>
        </View>}
      </>}
  </View>;
}

// The Services screen owns the observed host inventory list. It is scoped to the
// selected host, shows every observed group failures first, and hands one group
// at a time to the diagnostic view; it reads nothing else.
export function HostServices({ hostId, hostLabel, theme, compact, connected, foreground, entries, catalogUnconfigured, catalogEvidence, openScreen, query, selected, onSelect, onBack, repositoryBlock }: {
  hostId: string; hostLabel: string; theme: PluginHostProps['theme']; compact: boolean;
  connected: boolean; foreground: boolean;
  entries: DeploymentCatalog['entries'] | null; catalogUnconfigured: boolean;
  // The one shared repository block (setup notice and guide) belongs to the list,
  // immediately above the rows, so host identity and service status lead.
  repositoryBlock?: ReactNode;
  // The shell's explicit repository-catalog evidence for this host: a match may
  // only be stated as absent, unavailable or confirmed from a settled read.
  catalogEvidence: CatalogEvidence;
  openScreen: PluginClientContext['openScreen'];
  query: ReturnType<typeof useHostServicesQuery>;
  // One selected family label; the list survives Back without a remount.
  selected: string | null;
  onSelect: (label: string) => void;
  onBack: () => void;
}) {
  const text = { color: theme.colors.foreground };
  const [setupExpanded, setSetupExpanded] = useState(false);
  const observation = query.observation;
  const data = observation?.data ?? null;
  // The claim decides what this reading may say and publish; the sentences, word
  // mapping, testIDs and problem rendering below stay exactly as they were.
  const claim = claimOf(observation, { connected, foreground });
  const families = sortFamilies(data?.groups ?? []);
  const names = displayNames(families, entries);
  const stale = claim.stale;
  if (selected !== null) {
    const group = families.find(candidate => candidate.label === selected) ?? null;
    return <ServiceDetails hostId={hostId} hostLabel={hostLabel} theme={theme} group={group}
      name={group === null ? null : names.get(group.label)!} entries={entries} openScreen={openScreen} onBack={onBack}
      lastSeen={stale ? observation!.lastSuccessfulAt : null} catalogEvidence={catalogEvidence} />;
  }
  const attention = families.filter(group => summarizeFamily(group).facts.includes('failed')).length;
  const off = claim.state === 'off';
  // A confirmed unconfigured catalog explains the missing repository detail once
  // on the Services screen instead of repeating a badge on every row. 'off' shows
  // no service rows at all, so the explanation belongs to the rows this state shows.
  const unconfigured = catalogUnconfigured && !off;
  // A first read that already failed is a settled 'unavailable', not progress,
  // and only fresh evidence may publish a count: off/loading, unavailable, stale
  // and offline are undecided, not empty.
  const state = claim.state;
  const current = claim.count;
  const absence = claim.absence;
  const inventoryProblems = (data?.problems ?? []).map(problem => `${problem.source}: ${problem.code}`);
  const transportProblems = observation?.problems.map(problem => `${problem.source}: ${problem.code}`) ?? [];
  const problems = [...inventoryProblems, ...transportProblems].join('; ');
  const limited = (data?.problems ?? []).some(problem => ['malformed_record', 'read_limit', 'row_limit'].includes(problem.code));
  const failed = (data?.problems ?? []).some(problem => ['process_failed', 'process_timeout', 'process_limit'].includes(problem.code));
  // Retained rows keep their last observed facts, labelled per row; no count or
  // absence claim survives a failed refresh or disconnect.
  const lastSeen = stale ? observation!.lastSuccessfulAt : null;
  // A payload that answered 'unavailable' and a first read that failed both mean
  // the same settled fact. A disconnected host owns its own 'Offline' line
  // instead of repeating this sentence; paused background reads keep it, so the
  // sentence every state shows stays exactly as it was before the claim.
  const unavailable = claim.state === 'unavailable'
    && (claim.payload !== null || (connected && claim.envelope !== null));
  const copies = [
    absence && families.length === 0 ? 'No Orbi units found.' : '',
    current && claim.payload === 'partial' && families.length === 0 ? 'Partial · no units confirmed; units may be missing.' : '',
    current && claim.payload === 'partial' && families.length > 0 ? 'Partial · units may be missing.' : '',
    unavailable ? 'Unavailable · current activity unknown.' : '',
    claim.reading ? 'Reading services…' : '',
    stale ? `Last success: ${observation!.lastSuccessfulAt}` : '',
    failed ? 'Read failed · check systemd/DBus access.' : '',
    limited ? 'Read limited · units may be missing.' : '',
  ].filter(Boolean);
  const panel = { gap: compact ? 8 : 12 };
  return <View testID="orbi-host-services" style={panel}>
    <Text accessibilityRole="header" testID="orbi-services-heading" style={text}>{`Services · ${hostLabel}`}</Text>
    <Text style={text}>{off ? 'Service check off · activity unknown' : stale ? 'Stale · current activity unknown' : `Services: ${state === 'complete' ? 'Current' : state}`}</Text>
    {current && families.length > 0 && <Text testID="orbi-attention-count" style={text}>{`${attention} of ${families.length} ${claim.payload === 'partial' ? 'observed ' : ''}groups ${attention === 1 ? 'needs' : 'need'} attention`}</Text>}
    {!connected && <Text style={text}>Offline · current activity unknown</Text>}
    {connected && !foreground && <Text style={text}>The app is in the background. Host service reads are paused.</Text>}
    {!!problems && <Text accessibilityRole="alert" style={text}>{problems}</Text>}
    {off ? <View style={{ gap: 8 }}>
      <ActionButton label={setupExpanded ? 'Hide service access setup' : 'Set up service access'} accessibilityName="Set up service access"
        expanded={setupExpanded} theme={theme} onPress={() => setSetupExpanded(value => !value)} />
      {setupExpanded && <View accessibilityLabel="Service access setup" style={{ gap: 8 }}>
        <Text style={text}>Host service inventory is not enabled on this host. The operator can opt in with PASEO_ORBI_HOST_INVENTORY=1 at plugin startup and explicitly authorize a reload.</Text>
        <Text style={text}>Connected clients on this host can then see Orbi unit names. No other host is read. Refresh cannot enable access or reload this plugin.</Text>
      </View>}
    </View> : <ActionButton label={query.refreshing ? 'Refreshing' : 'Refresh services'} accessibilityName="Refresh services"
      disabled={!query.canRefresh} busy={query.refreshing} theme={theme} onPress={() => { void query.refresh(); }} />}
    {copies.map(copy => <Text key={copy} style={text}>{copy}</Text>)}
    {repositoryBlock}
    {families.map(group => <ServiceRow key={`${hostId}:${group.label}`} group={group} name={names.get(group.label)!}
      theme={theme} entries={entries} openScreen={openScreen} showUnlinked={!unconfigured} lastSeen={lastSeen}
      onDetails={() => onSelect(group.label)} />)}
  </View>;
}
