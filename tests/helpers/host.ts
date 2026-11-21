import { vi } from 'vitest';
const state = vi.hoisted(() => ({
  readBlockers: vi.fn(), readBlocker: vi.fn(), readRuns: vi.fn(), readRun: vi.fn(), openExternalUrl: vi.fn().mockResolvedValue(undefined), readCatalog: vi.fn(), readFleet: vi.fn().mockRejectedValue(new Error('fixture_unavailable')), readIssues: vi.fn(), readIssue: vi.fn(), readShortcut: vi.fn(), readInventory: vi.fn().mockResolvedValue({ state: 'off', observedAt: null, sources: [], groups: [], problems: [] }), hosts: [{ serverId: 'host-a', label: 'Host A', status: 'online' }],
  listeners: new Set<(state: string) => void>(),
}));
export const host = state;
vi.mock('@getpaseo/plugin/client', () => ({ useRpc: (contract: { name: string }) => contract.name === 'blockers.list' ? state.readBlockers : contract.name === 'blockers.read' ? state.readBlocker : contract.name === 'runs.list' ? state.readRuns : contract.name === 'runs.read' ? state.readRun : contract.name === 'fleet.read' ? state.readFleet : contract.name === 'issues.list' ? state.readIssues : contract.name === 'issues.get' ? state.readIssue : contract.name === 'services.inventory' ? state.readInventory : contract.name === 'workspace.shortcut' ? state.readShortcut : state.readCatalog, useHosts: () => state.hosts }));
vi.mock('@getpaseo/plugin/client/ui', async () => {
  const { createElement } = await import('react');
  return {
    SidebarRow: 'SidebarRow',
    // Host component seam: documented link semantics and opener/onError contract.
    ExternalLink: ({ href, children, onError, ...props }: import('@getpaseo/plugin/client/ui').ExternalLinkProps) => createElement('ExternalLink', {
      ...props, href, accessibilityRole: 'link', onPress: async () => {
        try { await state.openExternalUrl(href); }
        catch (error) { if (onError) onError(error); else console.error(error); }
      },
    }, children),
  };
});
vi.mock('react-native', () => ({
  Linking: { openURL: vi.fn().mockResolvedValue(undefined) }, View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', ScrollView: 'ScrollView',
  AppState: { currentState: 'active', addEventListener: (_: string, callback: (state: string) => void) => {
    state.listeners.add(callback); return { remove: () => state.listeners.delete(callback) };
  } },
}));
