import { useEffect, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import type { Observation, Problem } from '../shared/common';
import { ActionButton } from './action-button';

// One repair sentence per reported problem code. The bare "source: code" evidence
// stays the observation's own claim; only a reported code earns the operator action
// printed next to it, so a read that succeeded never suggests a failure.
const unavailableAccess = 'Repair access externally, then Refresh. Missing evidence never means none exist.';
export const repairGuidance: Partial<Record<Problem['code'], string>> = {
  auth_denied: "Ask the operator to repair the daemon user's existing gh authentication or permissions, then Refresh.",
  rate_limited: "Wait for GitHub's retry/reset time, then Refresh.",
  incomplete: unavailableAccess,
  network_failed: unavailableAccess,
};
// Runs prints this next to its own unavailable-activity evidence, never on a clean read.
export const sessionWriterGuidance = 'Check the session writer externally and Refresh; do not infer idle.';

// Cancelled RPC transports may still be running. Serialize replacement generations
// as well as QueryClient's ordinary same-key coalescing; never reuse a cancelled result.
const pendingReads = new WeakMap<QueryClient, Map<string, Promise<unknown>>>();

// Every screen decides what it may claim about a host reading here, once. The
// observation envelope owns freshness; a screen keeps its own sentence, word
// mapping and testIDs, but never re-derives what the evidence may publish.
export type Reach = { connected: boolean; foreground: boolean };
// The reading words a payload can answer with. A catalog, a page or a detail
// payload carries none of them, so it never outranks its envelope's word.
export type PayloadReading = 'complete' | 'partial' | 'off' | 'unavailable';
export type ClaimState = Observation<unknown>['state'] | PayloadReading | 'loading';
export type Claim = Readonly<{
  // The envelope's own word, or null before a read settles.
  envelope: Observation<unknown>['state'] | null;
  // The payload's reading word, or null when it carries none.
  payload: PayloadReading | null;
  // The one decided word: an off answer, retained stale evidence, the payload's
  // word, the envelope's word, then loading/unavailable.
  state: ClaimState;
  // Whether a read is possible at all (connected and foreground).
  reach: boolean;
  // Whether retained observation evidence outranks the payload word.
  stale: boolean;
  // Whether a first read is in progress.
  reading: boolean;
  // Whether a count may publish: only current reading evidence may.
  count: boolean;
  // Whether an absence claim may publish: only a current complete reading may.
  absence: boolean;
}>;
const readingWord = (data: unknown): PayloadReading | null => {
  const state = data !== null && typeof data === 'object' ? (data as { state?: unknown }).state : null;
  return state === 'complete' || state === 'partial' || state === 'off' || state === 'unavailable' ? state : null;
};
// The one evidence predicate: only a complete or partial check produced rows, so
// only it may publish a count, and only a complete one may publish absence.
export const readingEvidence = (state: unknown) => state === 'complete' || state === 'partial';

export function claimOf(observation: Observation<unknown> | undefined, reach: Reach): Claim {
  const envelope = observation?.state ?? null;
  const payload = readingWord(observation?.data);
  const reachable = reach.connected && reach.foreground;
  // A stale envelope outranks the payload word only when retained observations are
  // what it qualifies: an off or unavailable answer has no last success, so its own
  // word stays visible instead of reading as stale (same rule on every screen).
  const stale = envelope === 'stale' && observation !== undefined && observation.lastSuccessfulAt !== null;
  const count = reachable && readingEvidence(payload) && (envelope === 'available' || envelope === 'partial');
  return {
    envelope, payload, reach: reachable, stale, count,
    // One branch order for every screen: an off answer, retained stale evidence,
    // the payload's word, the envelope's word, then no settled read at all.
    state: payload === 'off' ? 'off' : stale ? 'stale' : payload ?? envelope ?? (reachable ? 'loading' : 'unavailable'),
    reading: reachable && envelope === null,
    // Off, denied, unavailable, stale, loading and offline evidence publish no
    // count; a partial reading never claims absence.
    absence: count && payload === 'complete',
  };
}

export function useForeground() {
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);
  return foreground;
}
export function useObservationQuery<T>(options: {
  hostId: string; deploymentId: string; selector: string; connected: boolean; foreground: boolean;
  read: () => Promise<Observation<T>>; poll?: boolean;
}) {
  const client = useQueryClient();
  const key = ['paseo-orbi', options.hostId, options.deploymentId, options.selector] as const;
  const enabled = options.connected && options.foreground;
  const query = useQuery({
    // Detail evidence is selection/manual-only: becoming enabled again must not
    // silently reload it. A fresh mount is an explicit selection, even if cached.
    queryKey: key, enabled, retry: false, staleTime: options.poll === false ? Infinity : 30000, gcTime: 60000,
    refetchOnMount: options.poll === false ? 'always' : true,
    refetchInterval: enabled && options.poll !== false ? 30000 : false, refetchIntervalInBackground: false,
    refetchOnWindowFocus: false, refetchOnReconnect: false,
    queryFn: async ({ signal }): Promise<Observation<T>> => {
      const previous = client.getQueryData<Observation<T>>(key);
      let next: Observation<T>;
      try {
        let pending = pendingReads.get(client);
        if (!pending) { pending = new Map(); pendingReads.set(client, pending); }
        const identity = JSON.stringify(key);
        while (pending.has(identity)) {
          await pending.get(identity)!.catch(() => undefined);
          if (signal.aborted) throw new Error('disposed');
        }
        if (signal.aborted) throw new Error('disposed');
        const read = Promise.resolve().then(options.read);
        pending.set(identity, read);
        try { next = await read; }
        finally { if (pending.get(identity) === read) pending.delete(identity); }
      } catch {
        next = { state: previous?.data != null ? 'stale' : 'unavailable', observedAt: new Date().toISOString(),
          lastSuccessfulAt: previous?.lastSuccessfulAt ?? null, data: previous?.data ?? null,
          problems: [{ source: 'filesystem', code: 'refresh_failed' }] };
      }
      // The QueryClient aborts consumed signals on teardown/key changes. A late RPC
      // cannot publish into a new host/deployment generation, even if transport cannot abort.
      if (signal.aborted) throw new Error('disposed');
      // Collectors can return an unavailable diagnostic snapshot instead of
      // throwing. It must not replace previously successful data with blanks.
      if ((next.data === null || (next.state === 'unavailable' && previous?.lastSuccessfulAt != null)) && previous?.data != null) return { ...next, state: 'stale', data: previous.data, lastSuccessfulAt: previous.lastSuccessfulAt };
      return next;
    },
  });
  useEffect(() => {
    if (!enabled) void client.cancelQueries({ queryKey: key, exact: true });
  }, [client, enabled, options.hostId, options.deploymentId, options.selector]);
  const [now, setNow] = useState(Date.now());
  const success = query.data?.lastSuccessfulAt;
  useEffect(() => {
    setNow(Date.now());
    if (!success) return;
    const delay = Math.max(0, Date.parse(success) + 60000 - Date.now());
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [success]);
  let observation = query.data;
  if (observation?.data != null && (!options.connected || (success && now >= Date.parse(success) + 60000))) observation = { ...observation, state: 'stale' };
  return { observation, refreshing: query.isFetching, canRefresh: enabled && !query.isFetching,
    refresh: () => enabled ? query.refetch({ cancelRefetch: false }) : Promise.resolve(undefined) };
}

export function ObservationView<T>({ observation, refreshing, canRefresh, refresh, theme, refreshLabel = 'Refresh', repair = false, children }: {
  observation?: Observation<T>; refreshing: boolean; canRefresh: boolean; refresh: () => unknown;
  theme: PluginHostProps['theme']; refreshLabel?: string;
  // Opt in only where a reported problem has an operator repair step to show.
  repair?: boolean; children: (data: T) => React.ReactNode;
}) {
  const text = { color: theme.colors.foreground };
  const status = observation?.state ?? 'Loading';
  const problems = observation?.problems.map(p => `${p.source}: ${p.code}`).join('; ') ?? '';
  const repairs = repair ? [...new Set((observation?.problems ?? []).flatMap(({ code }) => repairGuidance[code] ?? []))] : [];
  return <View>
    <Text accessibilityLabel={`Observation status: ${status}`} style={text}>{status}</Text>
    {observation && <Text style={text}>Observed: {observation.observedAt}; Last success: {observation.lastSuccessfulAt ?? 'never'}</Text>}
    <Text accessibilityRole="alert" style={text}>{problems}</Text>
    {repairs.map((sentence, index) => <Text key={index} style={text}>{sentence}</Text>)}
    {observation?.data != null && children(observation.data)}
    <ActionButton label={refreshing ? 'Refreshing' : 'Refresh'} accessibilityName={refreshLabel}
      disabled={!canRefresh} busy={refreshing} theme={theme} onPress={() => { void refresh(); }} />
  </View>;
}
