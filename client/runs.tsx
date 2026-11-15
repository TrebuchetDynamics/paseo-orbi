import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useRpc, type PluginHostProps } from '@getpaseo/plugin/client';
import { runsList, runsRead, type RunSummary, type RunDetails } from '../shared/runs';
import { ObservationView, useObservationQuery } from './observation';

type Props = { deploymentId: string; repo: string; hostId: string; connected: boolean; foreground: boolean; theme: PluginHostProps['theme'] };
function Summary({ row, theme }: { row: RunSummary; theme: PluginHostProps['theme'] }) {
  const text = { color: theme.colors.foreground };
  return <View>
    <Text style={text}>{row.deploymentId} · {row.repo}#{row.issue} · run {row.runId} ({row.membership})</Text>
    <Text style={text}>Lifecycle: {row.lifecycle ?? 'history, not active membership'}; Reported stage: {row.stage ?? 'unavailable'}</Text>
    <Text style={text}>Branch: {row.branch ?? 'unavailable'}; created_at (recorded, not guaranteed start): {row.createdAt ?? 'unavailable'}</Text>
    <Text style={text}>Pushed SHA: {row.pushedHead ?? 'unknown'}; Reviewed SHA: {row.reviewedHead ?? 'unknown'}</Text>
    {row.failure && <Text style={text}>Reported failure: {row.failure.reason_code}; repair: {row.failure.action_code}</Text>}
    {!row.sessions.length && <Text style={text}>Activity unavailable — no attributed session evidence, not idle.</Text>}
    {row.sessions.map((session, index) => <Text key={index} style={text}>Session {session.sessionId ?? 'identity unavailable'}: {session.state}; activity {session.at ?? 'unknown'} {session.kind ?? 'unknown'}</Text>)}
    {row.problems.map((p, index) => <Text key={index} style={text}>{p.source}: {p.code}</Text>)}
  </View>;
}
function Detail({ input, ...props }: Props & { input: { issue: number; runId: string } }) {
  const read = useRpc(runsRead);
  const query = useObservationQuery<RunDetails>({ ...props, poll: false, selector: `runs.read:${props.repo}:${input.issue}:${input.runId}`,
    read: () => read({ deploymentId: props.deploymentId, ...input }) });
  const text = { color: props.theme.colors.foreground };
  return <ObservationView {...query} theme={props.theme}>{data => <View>
    <Text style={text}>Detail evidence — loaded only on selection or manual Refresh. Bounded journal window; gaps/rotation may omit events.</Text>
    <Summary row={data.summary} theme={props.theme} />
    <Text style={text}>PR identity: {data.prIdentity.status}</Text>
    {data.pr ? <View>
      <Text style={text}>PR #{data.pr.number} {data.pr.url}; {data.pr.state}; merged_at: {data.pr.merged_at ?? 'not merged'}; head.sha: {data.pr.head.sha}</Text>
      <Text style={text}>Head checks: {data.pr.checksState}</Text>
      {data.pr.checks.map((check, index) => <Text key={index} style={text}>{check.name}: {check.status} / {check.conclusion ?? 'unknown'} {check.url ?? ''}</Text>)}
    </View> : <Text style={text}>PR/check evidence unavailable. No guessed PR lookup; no passed checks inferred.</Text>}
    {!data.events.length && <Text style={text}>No matching events in this bounded observation (not proof no events occurred).</Text>}
    {data.events.map((event, index) => <Text key={index} style={text}>{event.at} {event.event} run {event.runId} issue {event.issue}</Text>)}
  </View>}</ObservationView>;
}
export function Runs(props: Props) {
  const read = useRpc(runsList);
  const [issueText, setIssueText] = useState('');
  const [issue, setIssue] = useState<number | undefined>();
  const [selected, select] = useState<{ issue: number; runId: string } | null>(null);
  const query = useObservationQuery<RunSummary[]>({ ...props, selector: `runs.list:${props.repo}:${issue ?? 'scope'}`, read: () => read({ deploymentId: props.deploymentId, ...(issue ? { issue } : {}) }) });
  const text = { color: props.theme.colors.foreground };
  const valid = /^[1-9][0-9]*$/.test(issueText) && Number.isSafeInteger(Number(issueText));
  return <View style={{ gap: 12 }}>
    <Text style={text}>Read-only observations, not proof a process is alive. Stage checks is not test success. External Pi sessions are not Paseo agents: no interactive attachment or steering.</Text>
    <Text style={text}>Summary refresh: 30 seconds while foreground/connected. Active scope requires complete GitHub membership; selected issue history is separate.</Text>
    <Text style={text}>auth_denied: ask the operator to repair the daemon user's existing gh authentication, then Refresh. rate_limited: wait for the retry/reset gate. Unavailable activity: check the session writer externally and Refresh; do not infer idle.</Text>
    <TextInput accessibilityLabel="Issue number for history" value={issueText} onChangeText={setIssueText} keyboardType="number-pad" style={{ ...text, borderColor: props.theme.colors.foreground, borderWidth: 1 }} />
    <Pressable accessibilityRole="button" accessibilityLabel="Inspect issue history" disabled={!valid} onPress={() => { select(null); setIssue(Number(issueText)); }}><Text style={text}>Inspect issue history</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="Show active scope" onPress={() => { select(null); setIssue(undefined); }}><Text style={text}>Show active scope</Text></Pressable>
    <Text style={text}>{issue ? `Issue #${issue} history — not active membership` : 'Observed active issue scope — no current/live run inferred'}</Text>
    <ObservationView {...query} theme={props.theme}>{rows => <View>
      {!rows.length && <Text style={text}>No attributed runs in this observed scope.</Text>}
      {rows.map(row => <Pressable key={JSON.stringify([row.deploymentId, row.repo, row.issue, row.runId])} accessibilityRole="button" accessibilityLabel={`Inspect run ${row.issue} ${row.runId}`} onPress={() => select({ issue: row.issue, runId: row.runId })}><Summary row={row} theme={props.theme} /></Pressable>)}
    </View>}</ObservationView>
    {selected && <Detail key={`${props.hostId}:${props.deploymentId}:${props.repo}:${selected.issue}:${selected.runId}`} {...props} input={selected} />}
  </View>;
}
