import { useState } from 'react';
import type { PluginClientContext, PluginScreenProps } from '@getpaseo/plugin/client';
import { useRpc } from '@getpaseo/plugin/client';
import { Pressable, Text, View } from 'react-native';
import type { DeploymentCatalog } from '../shared/common';
import {
  issueBrowseStateTitle, issueBrowseStates, issueLabelShortcuts, issueReadRepair, issuesList,
  type IssueBrowseState, type IssuePage, type IssueSummary,
} from '../shared/issues';
import { useObservationQuery } from './observation';
import { GitHubEvidenceLink } from './github-evidence-link';
import { LabelChips } from './label-chip';
import { HostServices, serviceAttention, useHostServicesQuery } from './host-overview';

// Work is the default view for a configured repository. It renders page-one
// issue rows for one available deployment and keeps the host service inventory
// one technical-details disclosure away. Every fact here is a bounded, read-only
// observation: no retry, mutation, label change or repository discovery.

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
      <Pressable accessibilityRole="button" accessibilityLabel={`Inspect issue ${issue.number}`}
        style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', opacity: pressed ? 0.65 : 1 })}
        onPress={() => openScreen({ screenId: 'issues', params: { deploymentId, issue: String(issue.number) } })}>
        <Text style={text}>Inspect issue</Text>
      </Pressable>
      <View style={{ minHeight: 44, justifyContent: 'center' }}>
        <GitHubEvidenceLink key={JSON.stringify([hostId, deploymentId, repo, 'issues', issue.number])}
          repo={repo} kind="issues" number={issue.number} url={issue.url} theme={theme} />
      </View>
    </View>
  </View>;
}

const issueHeading = (state: IssueBrowseState) => state === 'open' ? 'Open issues' : state === 'closed' ? 'Closed issues' : 'Issues (open and closed)';

export function Work(props: PluginScreenProps & {
  openScreen: PluginClientContext['openScreen'];
  catalog: DeploymentCatalog | null;
  // Confirmed unconfigured projection from the catalog owner, never a read failure.
  catalogUnconfigured: boolean;
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
  const [servicesOpen, setServicesOpen] = useState(false);
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
  const state = observation?.state ?? 'loading';
  const page = observation?.data ?? null;
  const codes = (observation?.problems ?? []).map(problem => problem.code);
  const repair = codes.includes('auth_denied') || codes.includes('rate_limited') ? issueReadRepair : '';
  // Only current evidence may publish an attention count: a retained, stale,
  // offline or denied inventory keeps the undecided summary instead.
  const inventory = props.query.observation;
  const freshInventory = inventory !== undefined && props.connected && props.foreground
    && (inventory.state === 'available' || inventory.state === 'partial');
  const attention = serviceAttention(freshInventory ? inventory.data : null);
  const serviceState = !props.connected || !props.foreground ? 'unavailable'
    : inventory === undefined ? 'reading'
      : inventory.state === 'stale' ? 'stale'
        : inventory.data?.state ?? inventory.state;
  const summary = attention === null
    ? `Services: ${serviceState} · current activity unknown`
    : attention.failed === 0
      ? `Services: ${attention.partial ? 'partial' : 'current'} · ${attention.total} ${attention.partial ? 'observed ' : ''}groups, no failed groups`
      : `Services: ${attention.partial ? 'partial' : 'current'} · ${attention.failed} of ${attention.total} ${attention.partial ? 'observed ' : ''}groups ${attention.failed === 1 ? 'needs' : 'need'} attention`;
  const blocked = props.catalog === null
    ? (props.connected && props.foreground ? 'Reading the selected host repository catalog…' : 'Repository catalog unavailable. Reconnect the selected host or ask the operator to check the plugin.')
    : props.catalog.state === 'unconfigured'
      ? 'Issue reads need a validated repository catalog, which this host does not have. Set up repositories below explains the missing authorization.'
      : props.catalog.state === 'invalid'
        ? 'Issue reads need a validated repository catalog, and this host configuration is invalid. Set up repositories below explains the repair.'
        : 'No available configured repository. Configured repositories below lists the rejected entries.';
  const empty = page !== null && page.records.length === 0 && state === 'available';
  return <View testID="orbi-work" style={{ gap: 8 }}>
    <Text accessibilityRole="header" testID="orbi-work-heading" style={text}>{`Work · ${props.host.label}`}</Text>
    {selected !== null && <Text testID="orbi-work-repository" style={text}>{`Repository: ${selected.label} (${selected.repo})`}</Text>}
    {available.length > 1 && <View testID="orbi-work-repositories" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {available.map(entry => <Pressable key={entry.id} accessibilityRole="button" accessibilityLabel={`Work repository ${entry.label}`}
        accessibilityState={{ selected: entry.id === selected?.id }}
        style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, borderWidth: entry.id === selected?.id ? 2 : 1, borderColor: props.theme.colors.foreground }}
        onPress={() => setChosen(entry.id)}><Text style={text}>{`${entry.label} (${entry.repo})`}</Text></Pressable>)}
    </View>}
    <Text testID="orbi-work-services-summary" style={text}>{summary}</Text>
    {selected === null ? <Text testID="orbi-work-blocked" style={text}>{blocked}</Text> : <>
      <Text accessibilityRole="header" testID="orbi-work-issues-heading" style={text}>{issueHeading(browseState)}</Text>
      <View testID="orbi-work-filters" style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {issueBrowseStates.map(next => <Pressable key={next} accessibilityRole="button" accessibilityLabel={`Browse ${next} issues`}
            accessibilityState={{ selected: browseState === next }}
            style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, borderWidth: browseState === next ? 2 : 1, borderColor: props.theme.colors.foreground }}
            onPress={() => { setBrowseState(next); }}><Text style={text}>{issueBrowseStateTitle(next)}</Text></Pressable>)}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[null, ...issueLabelShortcuts].map(next => <Pressable key={next ?? 'all'} accessibilityRole="button"
            accessibilityLabel={next === null ? 'All labels' : `Filter by label ${next}`} accessibilityState={{ selected: label === next }}
            style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, borderWidth: label === next ? 2 : 1, borderColor: props.theme.colors.foreground }}
            onPress={() => setLabel(next)}><Text style={text}>{next ?? 'All labels'}</Text></Pressable>)}
        </View>
      </View>
      <View testID="orbi-work-issues" style={{ gap: 4 }}>
        <Text testID="orbi-work-issues-status" style={text}>{`Issues: ${state === 'available' ? 'current' : state}`}</Text>
        {state === 'stale' && <Text testID="orbi-work-issues-stale" style={text}>{`Last seen ${observation?.lastSuccessfulAt ?? 'never'}. Current activity unknown; retained rows may be out of date.`}</Text>}
        {!!codes.length && <Text accessibilityRole="alert" style={text}>{(observation?.problems ?? []).map(problem => `${problem.source}: ${problem.code}`).join('; ')}</Text>}
        {!!repair && <Text style={text}>{repair}</Text>}
        {page?.records.map(issue => <WorkIssue key={issue.number} issue={issue} repo={page.repo} hostId={props.host.id}
          deploymentId={selected.id} theme={props.theme} openScreen={props.openScreen} />)}
        {empty && <Text testID="orbi-work-empty" style={text}>{page.hasNextPage
          ? 'No issues on this page. Pull-request entries are excluded; continue in Issues.'
          : `No ${browseState === 'all' ? '' : `${browseState} `}issues found.`}</Text>}
        {page?.hasNextPage && <Pressable accessibilityRole="button" accessibilityLabel="Continue browsing issues"
          style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', opacity: pressed ? 0.65 : 1 })}
          onPress={() => props.openScreen({ screenId: 'issues', params: { deploymentId: selected.id } })}>
          <Text style={text}>More issues are available; continue in Issues.</Text>
        </Pressable>}
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh issues" disabled={!issues.canRefresh}
          accessibilityState={{ disabled: !issues.canRefresh, busy: issues.refreshing }}
          style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', borderWidth: 1, borderColor: props.theme.colors.foreground, borderRadius: 8, paddingHorizontal: 12, opacity: !issues.canRefresh ? 0.5 : pressed ? 0.7 : 1 })}
          onPress={issues.refresh}><Text style={text}>{issues.refreshing ? 'Refreshing' : 'Refresh issues'}</Text></Pressable>
        {props.connected && !props.foreground && <Text style={text}>App is in the background. Issue reads are paused.</Text>}
      </View>
    </>}
    <View testID="orbi-work-services" style={{ gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Services (technical details)" accessibilityState={{ expanded: servicesOpen }}
        style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', opacity: pressed ? 0.65 : 1 })}
        onPress={() => setServicesOpen(value => !value)}>
        <Text style={text}>{servicesOpen ? 'Hide services (technical details)' : 'Services (technical details)'}</Text>
      </Pressable>
      {servicesOpen && <HostServices
        key={`${props.host.id}:${selected?.id ?? ''}:${selected?.repo ?? ''}`} surfaceKey={`${props.host.id}:${selected?.id ?? ''}:${selected?.repo ?? ''}`}
        hostId={props.host.id} hostLabel={props.host.label} connected={props.connected} foreground={props.foreground}
        theme={props.theme} compact={props.layout.compact}
        entries={props.catalog?.entries ?? null} catalogUnconfigured={props.catalogUnconfigured}
        openScreen={props.openScreen} query={props.query} />}
    </View>
  </View>;
}
