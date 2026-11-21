import { useState } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import type { PluginHostProps } from '@getpaseo/plugin/client';
import { Text, View } from 'react-native';
import { workspaceShortcutStatus, type ShortcutState, type WorkspaceShortcutStatus } from '../shared/workspace-shortcut';
import { ActionButton } from './action-button';

// Plain-language labels only. Nothing here names, resolves or shows the target, and a
// present shortcut never claims that a checkout exists or opens.
const labels: Record<ShortcutState, string> = {
  symlink: 'Symlink present',
  not_symlink: 'Present, not a symlink',
  absent: 'Not present',
  cannot_inspect: 'Cannot inspect',
  not_configured: 'Not configured',
};

// Explicit inspection only: mounting this block reads nothing. One Inspect press is
// one request and one further Refresh press is one more; there is no polling, and an
// observation is kept only for the host/deployment/repository that produced it.
export function WorkspaceShortcut({ hostId, deploymentId, repo, connected, foreground, theme }: {
  hostId: string; deploymentId: string; repo: string; connected: boolean; foreground: boolean; theme: PluginHostProps['theme'];
}) {
  const read = useRpc(workspaceShortcutStatus);
  const identity = `${hostId}:${deploymentId}:${repo}`;
  const [observation, setObservation] = useState<{ identity: string; value: WorkspaceShortcutStatus } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const current = observation?.identity === identity ? observation.value : null;
  const busy = pending === identity;
  const canInspect = connected && foreground && !busy;
  const inspect = async () => {
    if (!canInspect) return;
    setPending(identity);
    try {
      const value = await read({ deploymentId });
      // A late result for a replaced selection is stored under its own identity and
      // never rendered for the current one.
      setObservation({ identity, value });
    } catch {
      // A transport failure establishes neither presence nor type.
      setObservation({ identity, value: { deploymentId, state: 'cannot_inspect', observedAt: new Date().toISOString(),
        problem: { source: 'filesystem', code: 'refresh_failed' } } });
    } finally { setPending(value => value === identity ? null : value); }
  };
  const text = { color: theme.colors.foreground };
  const action = current ? 'Refresh shortcut' : 'Inspect shortcut';
  return <View testID={`orbi-shortcut-${deploymentId}`} accessibilityLabel="Workspace shortcut" style={{ gap: 4 }}>
    <Text style={text}>Workspace shortcut: {current ? labels[current.state] : 'Not inspected'}</Text>
    {current && <Text style={text}>Shortcut observed: {current.observedAt}{current.problem ? ` · ${current.problem.source}: ${current.problem.code}` : ''}</Text>}
    <Text style={text}>Explicit inspection only. This reports whether the designated name is present and whether it is a symbolic link. It does not read, follow, compare or display the target, and it does not prove that a checkout exists or opens. A shortcut is a possible convenience for terminal, editor and file-manager users, not a Paseo workspace registration.</Text>
    {!connected && <Text style={text}>Host offline: no shortcut inspection.</Text>}
    {connected && !foreground && <Text style={text}>App is in the background: no shortcut inspection.</Text>}
    <ActionButton label={busy ? 'Inspecting' : action} accessibilityName={action} disabled={!canInspect} busy={busy}
      theme={theme} onPress={() => { void inspect(); }} />
  </View>;
}
