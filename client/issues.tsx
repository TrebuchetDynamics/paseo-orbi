import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useRpc, type PluginClientContext, type PluginScreenProps } from '@getpaseo/plugin/client';
import { issuesList, issuesGet, issueStates, type IssueDetail, type IssuePage } from '../shared/issues';
import { waitGuidance } from '../shared/blockers';
import { ObservationView, useObservationQuery } from './observation';
import { GitHubEvidenceLink } from './github-evidence-link';

type Props = { deploymentId: string; hostId: string; repo: string; connected: boolean; foreground: boolean; theme: PluginScreenProps['theme']; openScreen: PluginClientContext['openScreen'] };
function Detail({ data, ...props }: Props & { data: IssueDetail }) {
  const text = { color: props.theme.colors.foreground };
  // Only a complete report establishes the current run; any other read stays inert text.
  const reportedRun = data.reports.complete ? data.reports.selectedRunId : null;
  return <View>
    <Text style={text}>#{data.issue.number}: {data.issue.state} — {data.issue.badge ?? 'no lifecycle label'} ({data.issue.provenance})</Text>
    <Text style={text}>Merge evidence: {data.mergeEvidence}. Receipts and labels alone do not verify a merge.</Text>
    <Text style={text}>Dependencies: {!data.dependencies.complete ? 'unknown / incomplete or unavailable' : data.dependencies.records.some(r => r.githubState === 'open') ? 'blocked by open issues' : 'no open blockers observed'}</Text>
    {data.dependencies.records.map(dependency => <Text key={dependency.number} style={text}>#{dependency.number} {dependency.title} ({dependency.githubState})</Text>)}
    {reportedRun
      ? <Pressable accessibilityRole="button" accessibilityLabel={`Inspect run ${reportedRun} in Runs`} onPress={() => props.openScreen({ screenId: 'runs', params: { deploymentId: props.deploymentId, issue: String(data.issue.number), runId: reportedRun } })}>
        <Text style={text}>{`Reported run: ${reportedRun}; reports complete — open in Runs`}</Text>
      </Pressable>
      : <Text style={text}>Reported run: {data.reports.selectedRunId ?? 'unknown'}; reports {data.reports.complete ? 'complete' : 'incomplete — current run not established; retained evidence may be stale'}</Text>}
    {data.reports.attribution && <Text style={text}>Run attribution: {data.reports.attribution.repo}#{data.reports.attribution.issue}, comment {data.reports.attribution.commentId}, updated {data.reports.attribution.updatedAt}</Text>}
    <Text style={text}>Progress: {data.reports.progress.status}{data.reports.progress.status === 'available' ? `; reported stage: ${data.reports.progress.data.step ?? 'unknown'} (not live execution; GitHub facts take precedence)` : ''}</Text>
    <Text style={text}>Failure: {data.reports.failure.status}{data.reports.failure.status === 'available' ? `; ${data.reports.failure.data.reason_code}; action: ${data.reports.failure.data.action_code}` : ''}</Text>
    <Text style={text}>Scene: {data.reports.scene.status}; Base CI: {data.reports.baseCi.status}; Receipt: {data.reports.mergedReceipt.status}</Text>
    {data.reports.scene.status === 'available' && <Text style={text}>Scene review_round: {data.reports.scene.data.review_round}</Text>}
    {data.reports.baseCi.status === 'available' && <Text style={text}>Base CI: {data.reports.baseCi.data.state}; PR #{data.reports.baseCi.data.pr}</Text>}
    {data.reports.baseCi.status === 'available' && <Text style={text}>{waitGuidance(data.reports.baseCi.data.state)}</Text>}
    {data.reports.mergedReceipt.status === 'available' && <Text style={text}>Reported receipt: merge_commit {data.reports.mergedReceipt.data.merge_commit}; review_rounds {data.reports.mergedReceipt.data.review_rounds}; commits {data.reports.mergedReceipt.data.commits}; external_commits {data.reports.mergedReceipt.data.external_commits}; run_id {data.reports.mergedReceipt.data.run_id}</Text>}
    <Text style={text}>PR identity: {data.reports.prIdentity.status}{data.reports.prIdentity.status === 'available' ? `; ${data.reports.prIdentity.url} (${data.reports.prIdentity.source})` : ''}</Text>
    {data.reports.prIdentity.status === 'available' && <GitHubEvidenceLink
      key={JSON.stringify([props.hostId, props.deploymentId, props.repo, 'pull', data.reports.prIdentity.number])}
      repo={props.repo} kind="pull" number={data.reports.prIdentity.number} url={data.reports.prIdentity.url} theme={props.theme} />}
    {(['progress', 'failure', 'scene', 'baseCi', 'mergedReceipt'] as const).map(key => {
      const attr = data.reports[key].attribution;
      return attr ? <Text key={key} style={text}>{key}: {attr.repo}#{attr.issue}, comment {attr.commentId}, updated {attr.updatedAt}</Text> : null;
    })}
  </View>;
}
export function Issues(props: Props) {
  const [page, setPage] = useState(1);
  const [selected, select] = useState<number | null>(null);
  const [issueText, setIssueText] = useState('');
  const read = useRpc(issuesList);
  const readDetail = useRpc(issuesGet);
  const query = useObservationQuery<IssuePage>({ ...props, selector: `issues.list:${props.repo}:${page}`, read: () => read({ deploymentId: props.deploymentId, page }) });
  const detail = useObservationQuery<IssueDetail>({ ...props, connected: props.connected && selected !== null, selector: `issues.get:${props.repo}:${selected ?? 'none'}`,
    read: () => readDetail({ deploymentId: props.deploymentId, issue: selected! }) });
  const text = { color: props.theme.colors.foreground };
  const lookup = /^[1-9][0-9]*$/.test(issueText) && Number.isSafeInteger(Number(issueText));
  return <View>
    <Text style={text}>Ready candidate does not promise pickup. Dependency status is unknown until an issue is selected. Labels are evidence, not execution instructions.</Text>
    <Text style={text}>If auth_denied: ask the operator to repair the daemon user's existing gh authentication, then Refresh. rate_limited: wait for GitHub's retry/reset gate; Refresh cannot bypass it.</Text>
    <TextInput accessibilityLabel="Issue number to inspect" value={issueText} onChangeText={setIssueText} keyboardType="number-pad" style={{ ...text, borderColor: props.theme.colors.foreground, borderWidth: 1 }} />
    <Pressable accessibilityRole="button" accessibilityLabel="Inspect issue by number" disabled={!lookup} onPress={() => { if (lookup) select(Number(issueText)); }}><Text style={text}>Inspect issue</Text></Pressable>
    <ObservationView {...query} theme={props.theme}>{data => <View>
      <Text style={text}>{data.repo} — Page {data.page}. This displayed page is not the complete active scope.</Text>
      {data.records.length === 0 && <Text style={text}>No issues on this observed page.</Text>}
      {issueStates.map(state => {
        const records = data.records.map(issue => {
          const observed = detail.observation?.data?.issue;
          return observed?.number === issue.number && observed.updatedAt >= issue.updatedAt ? observed : issue;
        }).filter(issue => issue.state === state);
        return records.length ? <View key={state}><Text style={text}>{state}</Text>{records.map(issue => <View key={issue.number}><Pressable accessibilityRole="button" accessibilityLabel={`Inspect issue ${issue.number}`} onPress={() => select(issue.number)}>
          <Text style={text}>#{issue.number} {issue.title} — {issue.badge ?? 'no lifecycle label'} ({issue.provenance})</Text>
          <Text style={text}>{issue.url}; updated {issue.updatedAt}; labels: {issue.labels.join(', ') || 'none'}; dependencies unknown</Text>
          {issue.warning && <Text style={text}>Evidence warning: conflicting lifecycle labels.</Text>}
        </Pressable>
          <GitHubEvidenceLink key={JSON.stringify([props.hostId, props.deploymentId, props.repo, 'issues', issue.number])}
            repo={props.repo} kind="issues" number={issue.number} url={issue.url} theme={props.theme} />
        </View>)}</View> : null;
      })}
      {data.hasNextPage && page === 10 && <Text style={text}>Safety page limit reached; historical scope is incomplete.</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel="Previous page" disabled={page === 1} onPress={() => { select(null); setPage(page - 1); }}><Text style={text}>Previous page</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Next page" disabled={!data.hasNextPage || page >= 10} onPress={() => { select(null); setPage(page + 1); }}><Text style={text}>Next page</Text></Pressable>
    </View>}</ObservationView>
    {selected !== null && <View>
      <Text style={text}>Issue #{selected} — detail read by number; not a browse-page membership claim.</Text>
      <ObservationView {...detail} theme={props.theme}>{data => <Detail data={data} {...props} />}</ObservationView>
    </View>}
  </View>;
}
