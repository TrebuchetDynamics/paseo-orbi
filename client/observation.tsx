import { useEffect, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import type { Observation } from '../shared/common';

// Cancelled RPC transports may still be running. Serialize replacement generations
// as well as QueryClient's ordinary same-key coalescing; never reuse a cancelled result.
const pendingReads = new WeakMap<QueryClient, Map<string, Promise<unknown>>>();

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
  read: () => Promise<Observation<T>>;
}) {
  const client = useQueryClient();
  const key = ['paseo-orbi', options.hostId, options.deploymentId, options.selector] as const;
  const enabled = options.connected && options.foreground;
  const query = useQuery({
    queryKey: key, enabled, retry: false, staleTime: 30000, gcTime: 60000,
    refetchInterval: enabled ? 30000 : false, refetchIntervalInBackground: false,
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
      if (next.data === null && previous?.data != null) return { ...next, state: 'stale', data: previous.data, lastSuccessfulAt: previous.lastSuccessfulAt };
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
  return { observation, refreshing: query.isFetching, refresh: () => enabled ? query.refetch({ cancelRefetch: false }) : Promise.resolve(undefined) };
}

export function ObservationView<T>({ observation, refreshing, refresh, theme, children }: {
  observation?: Observation<T>; refreshing: boolean; refresh: () => unknown;
  theme: PluginHostProps['theme']; children: (data: T) => React.ReactNode;
}) {
  const text = { color: theme.colors.foreground };
  return <View>
    <Text style={text}>{observation?.state ?? 'Loading'}</Text>
    {observation && <Text style={text}>Observed: {observation.observedAt}; Last success: {observation.lastSuccessfulAt ?? 'never'}</Text>}
    {observation?.problems.map((p, i) => <Text key={i} style={text}>{p.source}: {p.code}</Text>)}
    {observation?.data != null && children(observation.data)}
    <Pressable accessibilityRole="button" accessibilityLabel="Refresh" disabled={refreshing} onPress={refresh}><Text style={text}>{refreshing ? 'Refreshing' : 'Refresh'}</Text></Pressable>
  </View>;
}
