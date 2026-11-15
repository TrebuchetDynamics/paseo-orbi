import { vi } from 'vitest';
const state = vi.hoisted(() => ({
  readBlockers: vi.fn(), readBlocker: vi.fn(), readRuns: vi.fn(), readRun: vi.fn(), readCatalog: vi.fn(), readFleet: vi.fn().mockRejectedValue(new Error('fixture_unavailable')), readIssues: vi.fn(), readIssue: vi.fn(), hosts: [{ serverId: 'host-a', label: 'Host A', status: 'online' }],
  listeners: new Set<(state: string) => void>(),
}));
export const host = state;
vi.mock('@getpaseo/plugin/client', () => ({ useRpc: (contract: { name: string }) => contract.name === 'blockers.list' ? state.readBlockers : contract.name === 'blockers.read' ? state.readBlocker : contract.name === 'runs.list' ? state.readRuns : contract.name === 'runs.read' ? state.readRun : contract.name === 'fleet.read' ? state.readFleet : contract.name === 'issues.list' ? state.readIssues : contract.name === 'issues.get' ? state.readIssue : state.readCatalog, useHosts: () => state.hosts }));
vi.mock('@getpaseo/plugin/client/ui', () => ({ SidebarRow: 'SidebarRow' }));
vi.mock('react-native', () => ({
  Linking: { openURL: vi.fn().mockResolvedValue(undefined) }, View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', ScrollView: 'ScrollView',
  AppState: { currentState: 'active', addEventListener: (_: string, callback: (state: string) => void) => {
    state.listeners.add(callback); return { remove: () => state.listeners.delete(callback) };
  } },
}));
