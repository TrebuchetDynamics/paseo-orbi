import { vi } from 'vitest';
const state = vi.hoisted(() => ({
  readCatalog: vi.fn(), hosts: [{ serverId: 'host-a', label: 'Host A', status: 'online' }],
  listeners: new Set<(state: string) => void>(),
}));
export const host = state;
vi.mock('@getpaseo/plugin/client', () => ({ useRpc: () => state.readCatalog, useHosts: () => state.hosts }));
vi.mock('@getpaseo/plugin/client/ui', () => ({ SidebarRow: 'SidebarRow' }));
vi.mock('react-native', () => ({
  View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView',
  AppState: { currentState: 'active', addEventListener: (_: string, callback: (state: string) => void) => {
    state.listeners.add(callback); return { remove: () => state.listeners.delete(callback) };
  } },
}));
