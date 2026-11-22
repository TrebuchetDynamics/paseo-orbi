import { useState } from 'react';
import type { PluginClientContext, PluginScreenProps } from '@getpaseo/plugin/client';
import { useRpc } from '@getpaseo/plugin/client';
import { Text, View } from 'react-native';
import type { DeploymentCatalog, Observation } from '../shared/common';
import type { ServiceInventory } from '../shared/services';
import {
  issueBrowseStateTitle, issueBrowseStates, issueLabelShortcuts, issueReadRepair, issuesList,
  type IssueBrowseState, type IssuePage, type IssueSummary,
} from '../shared/issues';
import { useObservationQuery } from './observation';
import { ActionButton } from './action-button';
import { GitHubEvidenceLink } from './github-evidence-link';
import { LabelChips } from './label-chip';
import { serviceAttention, useHostServicesQuery } from './host-overview';

// Work is the default view for a configured repository. It renders page-one
// issue rows for one available deployment, one readable host service health
// line and a separate View services action. Every fact here is a bounded,
// read-only observation: no retry, mutation, label change or repository
// discovery.

// Concise age for a row; the exact timestamp stays in the Issues detail.
export function updatedAge(updatedAt: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 60000));
  if (!Number.isFinite(minutes)) return 'unknown';
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}

function WorkIssue({ issue, repo, hostId, deploymentId, theme, openScreen }: {
  issue: IssueSummary; repo: string; hostId: string; deploymentId: string;
  theme: PluginScreenProps['theme']; openScreen: PluginClientContext['openScreen'];
}) {
  const text = { color: theme.colors.foreground };
  const secondary = { ...text, fontSize: 12 };
  return <View testID={`orbi-work-issue-${issue.number}`} style={{ gap: 4, paddingVertical: 6 }}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
      {/* The glyph is decorative; the accessible name and the visible state word carry the meaning. */}
      <Text accessibilityRole="image" accessibilityLabel={`${issue.githubState === 'open' ? 'Open' : 'Closed'} issue`} style={{ ...text, width: 16, textAlign: 'center' }}>{issue.githubState === 'open' ? '○' : '●'}</Text>
      <View style={{ flexShrink: 1, gap: 4 }}>
        <Text style={text}>{`#${issue.number} ${issue.title}`}</Text>
        <Text style={secondary}>{`${issue.githubState} · ${issue.state} · updated ${updatedAge(issue.updatedAt)}`}</Text>
        <LabelChips labels={issue.labelDetails} />
      </View>
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <ActionButton label="Inspect issue" accessibilityName={`Inspect issue ${issue.number}`} theme={theme}
        onPress={() => openScreen({ screenId: 'issues', params: { deploymentId, issue: String(issue.number) } })} />
      <View style={{ minHeight: 44, justifyContent: 'center' }}>
        <GitHubEvidenceLink key={JSON.stringify([hostId, deploymentId, repo, 'issues', issue.number])}
          repo={repo} kind="issues" number={issue.number} url={issue.url} theme={theme} />
      </View>
    </View>
  </View>;
}

const issueHeading = (state: IssueBrowseState) => state === 'open' ? 'Open issues' : state === 'closed' ? 'Closed issues' : 'Issues (open and closed)';

const serviceGroups = (count: number) => `${count} service group${count === 1 ? '' : 's'}`;

// One readable health line: only a current complete or partial reading may
// publish a count, and the copy names exactly what was observed. A partial check
// never reads as all-clear, and off, denied, stale, loading or offline evidence
// reports the limitation instead of a stale current count.
function serviceHealthSummary(observation: Observation<ServiceInventory> | undefined, connected: boolean, foreground: boolean) {
  if (!connected || !foreground) return 'Service check unavailable · current activity unknown';
  if (observation === undefined) return 'Reading host services · current activity unknown';
  if (observation.state === 'stale') return 'Service check stale · current activity unknown';
  const data = observation.data;
  if (data === null) return 'Service check unavailable · current activity unknown';
  if (data.state === 'off') return 'Service check off · current activity unknown';
  if (data.state === 'unavailable') return 'Service check unavailable · current activity unknown';
  const attention = serviceAttention(data)!;
  if (data.state === 'partial') return attention.failed === 0
    ? `${serviceGroups(attention.total)} observed · Partial check, so groups and failures may be missing`
    : `Partial check · ${attention.failed} of ${serviceGroups(attention.total)} ${attention.failed === 1 ? 'needs' : 'need'} attention, and more may be missing`;
  return attention.failed === 0
    ? `${serviceGroups(attention.total)} · No failures observed`
    : `${attention.failed} of ${serviceGroups(attention.total)} ${attention.failed === 1 ? 'needs' : 'need'} attention`;
}

export function Work(props: PluginScreenProps & {
  openScreen: PluginClientContext['openScreen'];
  catalog: DeploymentCatalog | null;
  connected: boolean; foreground: boolean;
  query: ReturnType<typeof useHostServicesQuery>;
}) {
  const text = { color: props.theme.colors.foreground };
  const available = (props.catalog?.entries ?? []).filter(entry => entry.status === 'available');
  // Selection is local to this host+catalog mount (Shell keys Work by both) and
  // only ever names a currently available, authorized entry.
  const [chosen, setChosen] = useState<string | null>(null);
  const requested = props.params.deploymentId;
  const selected = available.find(entry => entry.id === chosen)
    ?? available.find(entry => entry.id === requested)
    ?? available[0] ?? null;
  const [browseState, setBrowseState] = useState<IssueBrowseState>('open');
  const [label, setLabel] = useState<string | null>(null);
  const read = useRpc(issuesList);
  // The identity matches the Issues screen's page-one observation, so a filter
  // switch, host change or late response can never publish into another scope.
  const issues = useObservationQuery<IssuePage>({
    hostId: props.host.id, deploymentId: selected?.id ?? 'work',
    selector: `issues.list:${selected?.repo ?? ''}:${browseState}:${label ?? ''}:1`,
    connected: props.connected && selected !== null, foreground: props.foreground,
    read: () => read({ deploymentId: selected!.id, page: 1, state: browseState, ...(label === null ? {} : { label }) }),
  });
  const observation = issues.observation;
  // An offline host or a backgrounded app allows no read at all, so the section
  // never claims activity it cannot have: it says unavailable and names the cause.
  const state = observation?.state ?? (props.connected && props.foreground ? 'loading' : 'unavailable');
  const page = observation?.data ?? null;
  const codes = (observation?.problems ?? []).map(problem => problem.code);
  const repair = codes.includes('auth_denied') || codes.includes('rate_limited') ? issueReadRepair : '';
  // Only current evidence may publish a count: a retained, stale, offline or
  // denied inventory keeps the undecided summary instead.
  const summary = serviceHealthSummary(props.query.observation, props.connected, props.foreground);
  // A confirmed unconfigured catalog has no issue read to explain here: the
  // shared notice above the surface says it once. Every other catalog state
  // keeps its own bounded explanation.
  const blocked = props.catalog === null
    ? (props.connected && props.foreground ? 'Reading the selected host repository catalog…' : 'Repository catalog unavailable. Reconnect the selected host or ask the operator to check the plugin.')
    : props.catalog.state === 'unconfigured'
      ? null
      : props.catalog.state === 'invalid'
        ? 'Issue reads need a validated repository catalog, and this host configuration is invalid. The Setup guide above explains the repair.'
        : 'No available configured repository. Configured repositories below lists the rejected entries.';
  const empty = page !== null && page.records.length === 0 && state === 'available';
  return <View testID="orbi-work" style={{ gap: 8 }}>
    {selected !== null && <Text testID="orbi-work-repository" style={text}>{`Repository: ${selected.label} (${selected.repo})`}</Text>}
    {available.length > 1 && <View testID="orbi-work-repositories" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {available.map(entry => <ActionButton key={entry.id} label={`${entry.label} (${entry.repo})`} accessibilityName={`Work repository ${entry.label}`}
        selected={entry.id === selected?.id} theme={props.theme} onPress={() => setChosen(entry.id)} />)}
    </View>}
    {/* The health summary is readable text; the separate View services action is
        the only navigation to this host's Services list. */}
    <View testID="orbi-work-services" style={{ gap: 8 }}>
      <Text testID="orbi-work-health" style={text}>{summary}</Text>
      <ActionButton label="View services" accessibilityName="View services" testID="orbi-work-view-services"
        theme={props.theme} onPress={() => props.openScreen({ screenId: 'services', params: selected ? { deploymentId: selected.id } : {} })} />
    </View>
    {selected === null ? blocked !== null && <Text testID="orbi-work-blocked" style={text}>{blocked}</Text> : <>
      <Text accessibilityRole="header" testID="orbi-work-issues-heading" style={text}>{issueHeading(browseState)}</Text>
      <View testID="orbi-work-filters" style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {issueBrowseStates.map(next => <ActionButton key={next} label={issueBrowseStateTitle(next)} accessibilityName={`Browse ${next} issues`}
            selected={browseState === next} theme={props.theme} onPress={() => { setBrowseState(next); }} />)}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[null, ...issueLabelShortcuts].map(next => <ActionButton key={next ?? 'all'} label={next ?? 'All labels'}
            accessibilityName={next === null ? 'All labels' : `Filter by label ${next}`} selected={label === next}
            theme={props.theme} onPress={() => setLabel(next)} />)}
        </View>
      </View>
      <View testID="orbi-work-issues" style={{ gap: 4 }}>
        <Text testID="orbi-work-issues-status" style={text}>{`Issues: ${state === 'available' ? 'current' : state}`}</Text>
        {state === 'stale' && <Text testID="orbi-work-issues-stale" style={text}>{`Last seen ${observation?.lastSuccessfulAt ?? 'never'}. Current activity unknown; retained rows may be out of date.`}</Text>}
        {!props.connected && <Text testID="orbi-work-issues-offline" style={text}>Selected host is offline. Issue reads are paused and no other host is used. Reconnect the selected host, then Refresh issues.</Text>}
        {!!codes.length && <Text accessibilityRole="alert" style={text}>{(observation?.problems ?? []).map(problem => `${problem.source}: ${problem.code}`).join('; ')}</Text>}
        {!!repair && <Text style={text}>{repair}</Text>}
        {page?.records.map(issue => <WorkIssue key={issue.number} issue={issue} repo={page.repo} hostId={props.host.id}
          deploymentId={selected.id} theme={props.theme} openScreen={props.openScreen} />)}
        {empty && <Text testID="orbi-work-empty" style={text}>{page.hasNextPage
          ? 'No issues on this page. Pull-request entries are excluded; continue in Issues.'
          : `No ${browseState === 'all' ? '' : `${browseState} `}issues found.`}</Text>}
        {page?.hasNextPage && <ActionButton label="More issues are available; continue in Issues." accessibilityName="Continue browsing issues"
          theme={props.theme} onPress={() => props.openScreen({ screenId: 'issues', params: { deploymentId: selected.id } })} />}
        <ActionButton label={issues.refreshing ? 'Refreshing' : 'Refresh issues'} accessibilityName="Refresh issues"
          disabled={!issues.canRefresh} busy={issues.refreshing} theme={props.theme} onPress={() => { void issues.refresh(); }} />
        {props.connected && !props.foreground && <Text style={text}>App is in the background. Issue reads are paused.</Text>}
      </View>
    </>}
  </View>;
}
