import { useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { useRpc, type PluginScreenProps } from '@getpaseo/plugin/client';
import { attentionText, blockersList, blockersRead, failureGuidance, waitGuidance, type Blocker, type BlockerPage, type BlockerDetails } from '../shared/blockers';
import { ObservationView, useObservationQuery } from './observation';

type Props = { deploymentId: string; hostId: string; connected: boolean; foreground: boolean; theme: PluginScreenProps['theme'] };
export function BlockerEvidence({ data, theme }: { data: Blocker | BlockerDetails; theme: Props['theme'] }) {
  const text = { color: theme.colors.foreground };
  const reports = data.reports;
  const link = (url: string, label: string) => <Text style={text} accessibilityRole="link" onPress={() => { void Linking.openURL(url).catch(() => undefined); }}>{label}: {url}</Text>;
  return <View style={{ gap: 8 }}>
    <Text style={text}>#{data.issue.number} {data.issue.title} — GitHub {data.issue.githubState}; updated {data.issue.updatedAt}</Text>
    <Text style={text}>Classification: {data.issue.state}; provenance: {data.issue.provenance}{data.issue.badge ? ` (${data.issue.badge})` : ''}</Text>
    <Text style={text}>Labels: {data.issue.labels.join(', ') || 'none'}{data.issue.warning ? ' — conflicting lifecycle labels' : ''}</Text>
    {link(data.issue.url, 'GitHub source')}
    <Text style={text}>{attentionText[data.attention]}</Text>
    <Text style={text}>Reported run: {reports.selectedRunId ?? 'unknown'}; {reports.complete ? 'complete report read' : 'incomplete — retained evidence may be stale; current run not established'}</Text>
    <Text style={text}>{failureGuidance(reports.failure)}</Text>
    {reports.failure.status === 'available' && <Text style={text}>Reason: {reports.failure.data.reason_code}; action: {reports.failure.data.action_code}</Text>}
    <Text style={text}>Scene metadata: {reports.scene.status}; Base CI metadata: {reports.baseCi.status}</Text>
    {reports.baseCi.status === 'available' && <Text style={text}>{waitGuidance(reports.baseCi.data.state)}</Text>}
    {(['attribution', 'failure', 'scene', 'baseCi'] as const).map(key => {
      const attr = key === 'attribution' ? reports.attribution : reports[key].attribution;
      return attr ? <View key={key}><Text style={text}>{key}: {attr.repo}#{attr.issue}; comment {attr.commentId}; updated {attr.updatedAt}</Text>{link(`https://github.com/${attr.repo}/issues/${attr.issue}#issuecomment-${attr.commentId}`, 'Report source')}</View> : null;
    })}
    {'artifacts' in data && <View style={{ gap: 8 }}>
      <Text style={text}>Artifact metadata only (no contents). Exact attributed scene candidates; missing evidence does not clear a GitHub blocker.</Text>
      {data.artifacts.map(artifact => <Text key={artifact.name} style={text}>{artifact.name}: {artifact.status}; bytes {artifact.size ?? 'unknown'}; modified {artifact.modifiedAt ?? 'unknown'}</Text>)}
      <Text style={text}>Profile: {data.retention.profile}; worktree_retain_hours: {data.retention.worktreeRetainHours}; keep_failed_worktrees: {data.retention.keepFailedWorktrees === null ? 'unsupported on release profile' : String(data.retention.keepFailedWorktrees)}</Text>
      <Text style={text}>Observed presence is not a retention guarantee. Official v0.7.41 may delete terminally failed worktrees; the pinned installed build supports retention. 72 hours does not imply automatic reclamation of an open blocked scene. No cleanup or recreation is performed.</Text>
    </View>}
  </View>;
}
export function Blockers(props: Props) {
  const [page, setPage] = useState(1);
  const [selected, select] = useState<number | null>(null);
  const read = useRpc(blockersList), inspect = useRpc(blockersRead);
  const query = useObservationQuery<BlockerPage>({ ...props, selector: `blockers.list:${page}`, read: () => read({ deploymentId: props.deploymentId, page }) });
  const detail = useObservationQuery<BlockerDetails>({ ...props, connected: props.connected && selected !== null, selector: `blockers.read:${selected ?? 'none'}`, read: () => inspect({ deploymentId: props.deploymentId, issue: selected! }) });
  const text = { color: props.theme.colors.foreground };
  return <View style={{ gap: 12 }}>
    <Text style={text}>Recovery stays Orbi/operator-owned. Guidance and reported retry safety never authorize recovery. This screen only reads evidence.</Text>
    <Text style={text}>auth_denied: ask the operator to repair the daemon user's existing gh authentication/permissions externally, then Refresh. rate_limited: wait for GitHub's reset gate. incomplete/network_failed: repair access externally and Refresh; unavailable evidence never means no blockers.</Text>
    <Text style={text} accessibilityRole="link" onPress={() => { void Linking.openURL('https://github.com/orbi-build/orbi/blob/fbafd09fe49a20299e96565f100633bca61ae2af/src/orbi/failure.py#L45').catch(() => undefined); }}>Failure schema source (pinned v1)</Text>
    <ObservationView {...query} theme={props.theme}>{data => <View style={{ gap: 12 }}>
      <Text style={text}>{data.repo} — Blockers page {data.page}; scope {data.complete ? 'complete' : 'incomplete / retained membership'}</Text>
      {data.records.length === 0 && <Text style={text}>{data.complete ? data.page === 1 ? 'No blockers in the complete observed scope.' : 'No blockers on this page.' : 'Blocker membership unavailable; not an empty success.'}</Text>}
      {data.records.map(blocker => <View key={blocker.issue.number}>
        <BlockerEvidence data={blocker} theme={props.theme} />
        <Pressable accessibilityRole="button" accessibilityLabel={`Inspect blocker ${blocker.issue.number}`} onPress={() => select(blocker.issue.number)}><Text style={text}>Inspect artifact metadata</Text></Pressable>
      </View>)}
      <Pressable accessibilityRole="button" accessibilityLabel="Previous blockers page" disabled={page === 1} onPress={() => { select(null); setPage(page - 1); }}><Text style={text}>Previous page</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Next blockers page" disabled={!data.hasNextPage} onPress={() => { select(null); setPage(page + 1); }}><Text style={text}>Next page</Text></Pressable>
    </View>}</ObservationView>
    {selected !== null && <ObservationView {...detail} theme={props.theme}>{data => <BlockerEvidence data={data} theme={props.theme} />}</ObservationView>}
  </View>;
}
