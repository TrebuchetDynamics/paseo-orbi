import './helpers/host';
import { host } from './helpers/host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { Shell } from '../client/shell';
import { resetHostOverviewState } from '../client/host-overview';
import type { DeploymentCatalog } from '../shared/common';
import { servicesInventory, type InventoryGroup, type InventoryUnit, type ServiceInventory } from '../shared/services';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const stamp = '2026-11-19T18:00:00.000Z';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  host.hosts.splice(1);
  host.hosts[0] = { serverId: 'host-a', label: 'Host A', status: 'online' };
  vi.useRealTimers();
});
const unit = (id: string, kind: InventoryUnit['kind'], activeState: string | null, subState: string | null, loadState = 'loaded'): InventoryUnit =>
  ({ id, kind, runtime: activeState === null ? null : { loadState, activeState, subState }, unitFileState: 'enabled' } as InventoryUnit);
const family = (label: string, association: InventoryGroup['association'], deploymentId: string | null, units: InventoryUnit[]): InventoryGroup =>
  ({ label, kind: 'runner-family', association, deploymentId, units });
const inventory = (value: Pick<ServiceInventory, 'state'> & Partial<ServiceInventory>): ServiceInventory => servicesInventory.output.parse({
  observedAt: stamp, sources: [
    { source: 'runtime', state: 'complete', observedAt: stamp, problems: [] },
    { source: 'installed', state: 'complete', observedAt: stamp, problems: [] },
  ], problems: [], groups: [], ...value,
});
const hostA = inventory({ state: 'complete', groups: [
  family('orbi', 'unmatched', null, [unit('orbi@1.service', 'service', 'failed', 'failed'), unit('orbi@1.timer', 'timer', 'active', 'waiting'), unit('orbi@2.service', 'service', 'active', 'running')]),
  family('orbi-demo', 'matched', 'demo', [unit('orbi-demo@1.service', 'service', 'inactive', 'dead'), unit('orbi-demo@1.timer', 'timer', 'active', 'waiting')]),
  family('orbi-aux', 'unmatched', null, [unit('orbi-aux@.service', 'service', null, null)]),
  family('orbi-core', 'incompatible', null, [unit('orbi-core@1.service', 'service', 'activating', 'start')]),
  family('orbi-clash', 'ambiguous', null, [unit('orbi-clash@1.service', 'service', 'active', 'exited')]),
] });
const hostB = inventory({ state: 'complete', groups: [family('orbi', 'unmatched', null, [unit('orbi@1.service', 'service', 'active', 'running')])] });
const nineGroups = (worker: 'failed' | 'idle' | 'running', timer: 'waiting' | 'failed', extraRunning = true) => inventory({ state: 'complete', groups: [
  family('orbi', 'unmatched', null, [
    unit('orbi@3.service', 'service', worker === 'failed' ? 'failed' : worker === 'idle' ? 'inactive' : 'active', worker === 'failed' ? 'failed' : worker === 'idle' ? 'dead' : 'running'),
    unit('orbi@3.timer', 'timer', timer === 'failed' ? 'failed' : 'active', timer),
    ...(extraRunning ? [unit('orbi@4.service', 'service', 'active', 'running')] : []),
  ]),
  ...Array.from({ length: 8 }, (_, index) => {
    const label = `orbi-g${index + 1}`;
    return family(label, 'unmatched', null, [unit(`${label}@1.service`, 'service', index === 0 ? 'activating' : 'inactive', index === 0 ? 'start' : 'dead')]);
  }),
] });
const demo: DeploymentCatalog['entries'][number] = { id: 'demo', label: 'Demo', repo: 'Example/project', adapter: 'orbi-0.7.41-release', status: 'available', problems: [] };
const second = { ...demo, id: 'second', label: 'Second', repo: 'Other/repository' };
const catalog = (entries: DeploymentCatalog['entries']): DeploymentCatalog => ({ state: 'configured', problems: [], entries });
const props = (id = 'host-a'): PluginScreenProps => ({ theme: { colors: { foreground: '#eee', foregroundMuted: '#aaa', surface0: '#111' } }, host: { id, label: host.hosts.find(item => item.serverId === id)?.label ?? (id === 'host-a' ? 'Host A' : 'Host B') }, layout: { compact: true, platform: 'ios' }, params: {} } as PluginScreenProps);
beforeEach(() => {
  resetHostOverviewState();
  host.readCatalog.mockReset().mockResolvedValue(catalog([demo]));
  host.readInventory.mockReset().mockResolvedValue(inventory({ state: 'off' }));
  host.readFleet.mockReset().mockResolvedValue({ state: 'available', observedAt: stamp, lastSuccessfulAt: stamp, problems: [] });
  for (const read of [host.readIssues, host.readIssue, host.readRuns, host.readRun, host.readBlockers, host.readBlocker]) read.mockClear();
});
const settle = async () => { for (let n = 0; n < 3; n++) await act(async () => { await vi.advanceTimersByTimeAsync(2); }); };
async function render(params: PluginScreenProps['params'] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanups.push(() => client.clear());
  const openScreen = vi.fn();
  const tree = (id = 'host-a', route = 'fleet') => <QueryClientProvider client={client}><Shell {...props(id)} params={params} route={route} openScreen={openScreen} /></QueryClientProvider>;
  let renderer!: ReactTestRenderer;
  vi.useFakeTimers(); vi.setSystemTime(new Date(stamp));
  await act(async () => { renderer = create(tree()); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); });
  await settle();
  const press = async (label: string) => { await act(async () => renderer.root.findByProps({ accessibilityLabel: label }).props.onPress()); await settle(); };
  const switchTo = async (id: string, route = 'fleet') => { await act(async () => renderer.update(tree(id, route))); await settle(); };
  return { renderer, client, press, switchTo, openScreen };
}
const text = (renderer: ReactTestRenderer) => renderer.root.findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
const row = (renderer: ReactTestRenderer, label: string) => renderer.root.findByProps({ testID: `orbi-family-${label}` });
const rowPage = (renderer: ReactTestRenderer, label: string) => row(renderer, label).findAllByType('Text' as any)
  .filter(node => !String(node.props.testID ?? '').startsWith('orbi-chevron-'))
  .map(node => node.children.join('')).join('\n');
const repositoryActions = (renderer: ReactTestRenderer) => renderer.root.findAll(node => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith('View repository'));

describe('compact host overview', () => {
  it('leads with inventory, uses catalog repository titles and keeps default family text short without raw unit IDs', async () => {
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, openScreen, press } = await render();
    const page = text(renderer);
    expect(page.startsWith('Host A · Fleet\nServices: Current')).toBe(true);
    expect(page.indexOf('Host A · Fleet')).toBeLessThan(page.indexOf('Repository setup'));
    expect(page).toContain('1 of 5 groups needs attention');
    const ids = renderer.root.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('orbi-family-')).map(node => node.props.testID);
    expect(ids).toEqual(['orbi', 'orbi-demo', 'orbi-aux', 'orbi-clash', 'orbi-core'].map(id => `orbi-family-${id}`));
    expect(rowPage(renderer, 'orbi')).toBe('orbi\nSlot 1 · Worker failed\nRunning\nTimer waiting\nUnlinked');
    expect(rowPage(renderer, 'orbi-demo')).toBe('Example/project\nIdle\nTimer waiting\nView repository');
    expect(rowPage(renderer, 'orbi-aux')).toContain('Installed');
    for (const id of ['orbi-core', 'orbi-clash']) {
      expect(rowPage(renderer, id)).toContain('Unknown / transitional');
      expect(rowPage(renderer, id)).not.toContain('Idle');
    }
    for (const group of hostA.groups) {
      expect(rowPage(renderer, group.label).length).toBeLessThan(100);
      expect(rowPage(renderer, group.label)).not.toMatch(/@|association|configured deployment/);
    }
    for (const testID of ['orbi-host-services', 'orbi-catalog']) expect(renderer.root.findByProps({ testID }).findAllByProps({ accessibilityRole: 'alert' }).filter(node => !node.props.children)).toHaveLength(0);
    expect(repositoryActions(renderer).map(node => node.props.accessibilityLabel)).toEqual(['View repository Demo']);
    await press('View repository Demo');
    expect(openScreen).toHaveBeenCalledWith({ screenId: 'issues', params: { deploymentId: 'demo' } });
    expect(host.readFleet).not.toHaveBeenCalled();
    expect(page).not.toContain('Fleet — read-only');
    expect(page).not.toContain('@1.service');
    await press('Expand orbi-core'); await press('Unit details for orbi-core');
    expect(rowPage(renderer, 'orbi-core')).toContain('does not mean the runner is broken');
    await press('Expand orbi-clash'); await press('Unit details for orbi-clash');
    expect(rowPage(renderer, 'orbi-clash')).toContain('makes the association unique');
    for (const read of [host.readIssues, host.readIssue, host.readRuns, host.readRun, host.readBlockers, host.readBlocker]) expect(read).not.toHaveBeenCalled();
  });

  it('pairs exact numeric slots, preserves missing/unknown/transitional states and separates unit details', async () => {
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: [family('orbi', 'unmatched', null, [
      unit('orbi@10.timer', 'timer', 'active', 'waiting'), unit('orbi@1.timer', 'timer', 'active', 'waiting'),
      unit('orbi@1.service', 'service', 'inactive', 'dead'), unit('orbi@2.service', 'service', 'active', 'exited'),
      unit('orbi@3.service', 'service', null, null), unit('orbi@01.service', 'service', 'activating', 'start'),
      unit('orbi@4.service', 'service', 'active', 'running'), unit('orbi@4.timer', 'timer', 'failed', 'failed'),
      unit('orbi@.service', 'service', null, null),
    ])] }));
    const { renderer, press } = await render();
    const expand = renderer.root.findByProps({ accessibilityLabel: 'Expand orbi' });
    expect(expand.props).toMatchObject({ accessibilityRole: 'button', accessibilityState: { expanded: false } });
    expect(expand.props.style({ pressed: false })).toMatchObject({ minHeight: 44, opacity: 1 });
    expect(rowPage(renderer, 'orbi')).toContain('Slot 4 · Timer failed');
    expect(rowPage(renderer, 'orbi')).toContain('Running');
    expect(rowPage(renderer, 'orbi')).toContain('Timer waiting');
    await press('Expand orbi');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Collapse orbi' }).props.accessibilityState.expanded).toBe(true);
    const slots = rowPage(renderer, 'orbi');
    expect(slots).toContain('Slot 1 · Idle · Timer waiting');
    expect(slots).toContain('Slot 2 · active/exited · Timer not observed');
    expect(slots).toContain('Slot 3 · Unknown · Timer not observed');
    expect(slots).toContain('Slot 4 · Running · Timer failed');
    expect(slots.indexOf('Slot 4 · Running · Timer failed')).toBeLessThan(slots.indexOf('Slot 1 · Idle · Timer waiting'));
    expect(slots).toContain('Slot 01 · activating/start · Timer not observed');
    expect(slots).toContain('Slot 10 · Service not observed · Timer waiting');
    expect(slots).not.toContain('@');
    expect(slots).not.toContain('Discovery is not authority');
    await press('Unit details for orbi');
    expect(rowPage(renderer, 'orbi')).toContain('orbi@.service: runtime not observed; unit file enabled (template, not a running service)');
    expect(rowPage(renderer, 'orbi')).toContain('Discovery is not authority');
    expect(rowPage(renderer, 'orbi')).toContain('Unit activity does not establish issue delivery');
    await press('Unit details for orbi');
    expect(rowPage(renderer, 'orbi')).not.toContain('@');
  });

  it('does not infer absent counterparts from partial inventory and retains partial evidence as a success', async () => {
    host.readInventory.mockResolvedValue(inventory({ state: 'partial', groups: [family('orbi', 'unmatched', null, [
      unit('orbi@1.service', 'service', 'inactive', 'dead'), unit('orbi@2.timer', 'timer', 'active', 'waiting'),
    ])], problems: [{ source: 'runtime', code: 'row_limit' }] }));
    const { renderer, press, client } = await render();
    await press('Expand orbi');
    expect(rowPage(renderer, 'orbi')).toContain('Slot 1 · Idle · Timer not observed');
    expect(rowPage(renderer, 'orbi')).toContain('Slot 2 · Service not observed · Timer waiting');
    expect(rowPage(renderer, 'orbi')).not.toMatch(/missing|not found/);
    expect(client.getQueryData(['paseo-orbi', 'host-a', 'host', 'services.inventory'])).toMatchObject({ state: 'partial', lastSuccessfulAt: stamp });
    host.readInventory.mockRejectedValue(new Error('failed'));
    await press('Refresh services');
    expect(text(renderer)).toContain(`Last success: ${stamp}`);
    expect(text(renderer)).toContain('Stale · current activity unknown');
    expect(rowPage(renderer, 'orbi')).toContain('Slot 2 · Service not observed · Timer waiting');
  });

  it.each(['not-found', 'error', 'unknown'])('never labels %s load as Idle at family or slot level', async loadState => {
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: [family('orbi', 'unmatched', null, [
      unit('orbi@1.service', 'service', 'inactive', 'dead', loadState), unit('orbi@1.timer', 'timer', 'inactive', 'dead', loadState),
    ])] }));
    const { renderer, press } = await render();
    expect(rowPage(renderer, 'orbi')).toContain('Unknown / transitional');
    expect(rowPage(renderer, 'orbi')).not.toContain('Idle');
    await press('Expand orbi');
    expect(rowPage(renderer, 'orbi')).not.toMatch(/Idle|Timer idle/);
    expect(rowPage(renderer, 'orbi')).toContain(loadState === 'not-found' ? 'Service not found · Timer not found' : `Load ${loadState} · inactive/dead`);
  });

  it('resolves final mixed raw/short display-name collisions to exact family labels', async () => {
    const labels = ['orbi-12345678', 'orbi-orbi-12345678-12345678'];
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: labels.map(label => family(label, 'unmatched', null, [unit(`${label}@1.service`, 'service', 'inactive', 'dead')])) }));
    const { renderer } = await render();
    for (const label of labels) expect(rowPage(renderer, label)).toBe(`${label}\nIdle\nUnlinked`);
    expect(repositoryActions(renderer)).toHaveLength(0);
  });

  it('falls back to the Overview heading when the retained expanded family disappears', async () => {
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press, switchTo } = await render();
    await press('Expand orbi');
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: hostA.groups.filter(group => group.label !== 'orbi') }));
    await press('Refresh services');
    await switchTo('host-a', 'issues');
    await switchTo('host-a');
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Collapse orbi' })).toHaveLength(0);
    expect(renderer.root.findByProps({ accessibilityLabel: 'Expand orbi-demo' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'orbi-overview-heading' }).props.accessibilityRole).toBe('header');
  });

  it('shortens only known prefixes for display, disambiguates slug collisions and never invents repository links', async () => {
    const labels = ['orbi-short-trunc-1234abcd', 'orbi-same-1234abcd', 'orbi-same-9876abcd'];
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: labels.map(label => family(label, 'unmatched', null, [unit(`${label}@1.service`, 'service', 'inactive', 'dead')])) }));
    const { renderer, press } = await render();
    expect(rowPage(renderer, labels[0])).toBe('short-trunc\nIdle\nUnlinked');
    expect(rowPage(renderer, labels[1])).toBe('same · 1234abcd\nIdle\nUnlinked');
    expect(rowPage(renderer, labels[2])).toBe('same · 9876abcd\nIdle\nUnlinked');
    expect(repositoryActions(renderer)).toHaveLength(0);
    expect(text(renderer)).not.toContain(labels[0]);
    await press(`Expand ${labels[0]}`);
    await press(`Unit details for ${labels[0]}`);
    expect(rowPage(renderer, labels[0])).toContain(labels[0]);
  });

  it('retains one expanded family on in-page remount and resets expansion and setup on host switch', async () => {
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press, switchTo } = await render();
    await press('Expand orbi');
    await switchTo('host-a', 'issues');
    await switchTo('host-a');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Collapse orbi' })).toBeDefined();
    await press('Expand orbi-demo');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Expand orbi' })).toBeDefined();
    await press('Repository setup');
    host.hosts.push({ serverId: 'host-b', label: 'Host B', status: 'online' });
    host.readInventory.mockResolvedValue(hostB);
    await switchTo('host-b');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Expand orbi' })).toBeDefined();
    expect(renderer.root.findByProps({ accessibilityLabel: 'Repository setup' }).props.accessibilityState.expanded).toBe(false);
    await switchTo('host-a');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Repository setup' }).props.accessibilityState.expanded).toBe(false);
    expect(renderer.root.findByProps({ testID: 'orbi-overview-heading' }).props.accessibilityRole).toBe('header');
  });

  it('keeps a cancelled pending host-A result out of host B with the same family and slot', async () => {
    let finishA!: (value: ServiceInventory) => void;
    host.readInventory.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve as typeof finishA; })).mockResolvedValue(hostB);
    const { renderer, client, switchTo } = await render();
    expect(text(renderer)).toContain('Reading services…');
    host.hosts.push({ serverId: 'host-b', label: 'Host B', status: 'online' });
    await switchTo('host-b');
    expect(text(renderer)).toContain('Host B · Fleet');
    expect(rowPage(renderer, 'orbi')).toContain('Running');
    await act(async () => finishA(hostA)); await settle();
    expect(text(renderer)).not.toContain('Failed');
    expect(client.getQueryData(['paseo-orbi', 'host-a', 'host', 'services.inventory'])).toBeUndefined();
  });
});

describe('compact first-screen triage', () => {
  it('names the selected host, attention count, first failed slot and remaining failures before any other group', async () => {
    host.hosts[0].label = 'BlueBlack';
    host.readInventory.mockResolvedValue(nineGroups('failed', 'failed'));
    const { renderer, press } = await render();
    const page = text(renderer);
    expect(renderer.root.findByProps({ testID: 'orbi-overview-heading' }).props.children).toBe('BlueBlack · Fleet');
    expect(page).toContain('1 of 9 groups needs attention');
    const refresh = renderer.root.findByProps({ accessibilityLabel: 'Refresh services' });
    expect(refresh.props).toMatchObject({ accessibilityRole: 'button', disabled: false, accessibilityState: { disabled: false, busy: false } });
    expect(refresh.findAllByType('Text' as any).map(node => node.children.join('')).join('')).toBe('Refresh services');
    // Nine distinct groups, failed group first: the first row is the affected one.
    expect(renderer.root.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('orbi-family-'))
      .map(node => node.props.testID)).toEqual(['orbi', 'orbi-g1', 'orbi-g2', 'orbi-g3', 'orbi-g4', 'orbi-g5', 'orbi-g6', 'orbi-g7', 'orbi-g8']
      .map(label => `orbi-family-${label}`));
    const disclosure = renderer.root.findByProps({ accessibilityLabel: 'Expand orbi' });
    expect(disclosure.props).toMatchObject({ accessibilityRole: 'button', accessibilityState: { expanded: false } });
    expect(disclosure.findAllByType('Text' as any).map(node => node.children.join('')).join('\n')).toContain('Slot 3 · Worker failed · +1 more');
    expect(rowPage(renderer, 'orbi')).toContain('Slot 3 · Worker failed · +1 more');
    expect(rowPage(renderer, 'orbi')).toContain('Running');
    // Proxy for "visible before scrolling" in the compact renderer: the first
    // failure is above every later group and below only the header controls.
    const lines = page.split('\n');
    expect(lines.indexOf('BlueBlack · Fleet')).toBe(0);
    expect(lines.indexOf('1 of 9 groups needs attention')).toBeLessThan(lines.indexOf('Refresh services'));
    expect(lines.indexOf('Refresh services')).toBeLessThan(lines.indexOf('Slot 3 · Worker failed · +1 more'));
    expect(lines.indexOf('Slot 3 · Worker failed · +1 more')).toBeLessThan(lines.indexOf('orbi-g1'));
    // The row is one accessibility element, so its visible status is announced too.
    expect(disclosure.props.accessibilityHint).toBe('Slot 3 · Worker failed · +1 more · Running · Unlinked');
    // The full row is one 44-unit disclosure with pressed feedback and a chevron.
    expect(disclosure.props.style({ pressed: false })).toMatchObject({ minHeight: 44, opacity: 1 });
    expect(disclosure.props.style({ pressed: true }).opacity).toBeLessThan(1);
    expect(renderer.root.findByProps({ testID: 'orbi-chevron-orbi' }).props.children).toBe('▸');
    expect(disclosure.findAllByProps({ accessibilityLabel: 'Unit details for orbi' })).toHaveLength(0);
    // One tap expands numeric slot detail; Unit details stays a separate control.
    await press('Expand orbi');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Collapse orbi' }).props.accessibilityState.expanded).toBe(true);
    expect(renderer.root.findByProps({ testID: 'orbi-chevron-orbi' }).props.children).toBe('▾');
    expect(rowPage(renderer, 'orbi')).toContain('Slot 3 · Failed · Timer failed');
    expect(rowPage(renderer, 'orbi')).toContain('Slot 4 · Running · Timer not observed');
    const details = renderer.root.findByProps({ accessibilityLabel: 'Unit details for orbi' });
    expect(details.props).toMatchObject({ accessibilityRole: 'button', accessibilityState: { expanded: false } });
    expect(details.props.style({ pressed: false })).toMatchObject({ minHeight: 44 });
    expect(disclosure.findAllByProps({ accessibilityLabel: 'Unit details for orbi' })).toHaveLength(0);
    await press('Unit details for orbi');
    expect(rowPage(renderer, 'orbi')).toContain('orbi@3.service: failed/failed');
    // Refresh services rereads inventory only, never the repository catalog.
    await press('Refresh services');
    expect(host.readInventory).toHaveBeenCalledTimes(2);
    expect(host.readCatalog).toHaveBeenCalledTimes(1);
  });

  it('keeps worker and timer facts independent with Timer waiting and preserves transitional states', async () => {
    host.readInventory.mockResolvedValue(nineGroups('idle', 'waiting', false));
    const { renderer, press } = await render();
    expect(text(renderer)).toContain('0 of 9 groups need attention');
    expect(rowPage(renderer, 'orbi')).toContain('Idle');
    expect(rowPage(renderer, 'orbi')).toContain('Timer waiting');
    expect(rowPage(renderer, 'orbi')).not.toContain('Scheduled');
    expect(rowPage(renderer, 'orbi')).not.toContain('Running');
    expect(rowPage(renderer, 'orbi-g1')).toContain('Unknown / transitional');
    host.readInventory.mockResolvedValue(nineGroups('running', 'waiting', false));
    await press('Refresh services');
    // Only the worker fact moves; the timer stays waiting.
    expect(rowPage(renderer, 'orbi')).toContain('Running');
    expect(rowPage(renderer, 'orbi')).toContain('Timer waiting');
    expect(rowPage(renderer, 'orbi')).not.toContain('Idle');
    expect(rowPage(renderer, 'orbi-g1')).toContain('Unknown / transitional');
  });

  it('keeps a transitional or not-observed worker out of an Idle summary', async () => {
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: [
      family('orbi', 'unmatched', null, [unit('orbi@1.service', 'service', 'inactive', 'dead'), unit('orbi@2.service', 'service', 'active', 'exited')]),
      family('orbi-unobserved', 'unmatched', null, [unit('orbi-unobserved@1.service', 'service', 'inactive', 'dead'), unit('orbi-unobserved@2.service', 'service', null, null)]),
    ] }));
    const { renderer } = await render();
    // One idle worker does not let the group claim Idle while another worker is
    // transitional or not observed.
    for (const label of ['orbi', 'orbi-unobserved']) {
      expect(rowPage(renderer, label)).toContain('Unknown / transitional');
      expect(rowPage(renderer, label)).not.toContain('Idle');
      expect(renderer.root.findByProps({ accessibilityLabel: `Expand ${label}` }).props.accessibilityHint).toBe('Unknown / transitional · Unlinked');
    }
  });
});

describe('host states and authority', () => {
  it('keeps off undecided, count-free and Refresh-free, with opt-in prose behind a disclosure even offline', async () => {
    const { renderer, press, switchTo } = await render();
    expect(text(renderer)).toContain('Service check off · activity unknown');
    expect(text(renderer)).not.toContain('groups need attention');
    expect(text(renderer)).not.toContain('Not observed in this host service check');
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Refresh services' })).toHaveLength(0);
    expect(text(renderer)).not.toContain('PASEO_ORBI_HOST_INVENTORY=1');
    await press('Set up service access');
    expect(text(renderer)).toContain('PASEO_ORBI_HOST_INVENTORY=1');
    expect(text(renderer)).toContain('Refresh cannot enable access');
    expect(text(renderer)).toContain('Connected clients on this host');
    host.hosts[0].status = 'offline';
    await switchTo('host-a');
    expect(text(renderer)).toContain('Offline · current activity unknown');
    expect(text(renderer)).toContain('Service check off · activity unknown');
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Refresh services' })).toHaveLength(0);
  });

  it('replaces former unit names with the undecided off state when revocation is received', async () => {
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, client } = await render();
    expect(rowPage(renderer, 'orbi')).toContain('Slot 1 · Worker failed');
    expect(rowPage(renderer, 'orbi')).toContain('Running');
    expect(rowPage(renderer, 'orbi-demo')).toContain('Example/project');
    expect(client.getQueryData(['paseo-orbi', 'host-a', 'host', 'services.inventory'])).toMatchObject({ lastSuccessfulAt: stamp });
    // Monitoring is revoked on the host; the next background check receives off.
    host.readInventory.mockResolvedValue(inventory({ state: 'off', observedAt: null, sources: [] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(31000); }); await settle();
    expect(text(renderer)).toContain('Service check off · activity unknown');
    expect(text(renderer)).not.toContain('Stale');
    expect(text(renderer)).not.toContain('Last success:');
    // Former rows are gone rather than retained as stale evidence.
    expect(renderer.root.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('orbi-family-'))).toHaveLength(0);
    expect(text(renderer)).not.toMatch(/orbi-demo|orbi@|Example\/project|Failed|Running/);
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Refresh services' })).toHaveLength(0);
    expect(client.getQueryData(['paseo-orbi', 'host-a', 'host', 'services.inventory'])).toMatchObject({
      state: 'available', lastSuccessfulAt: null, data: { state: 'off', groups: [] },
    });
    // Revocation never turns into a write: no Save/settings control is offered.
    const labels = renderer.root.findAll(node => typeof node.props.accessibilityLabel === 'string').map(node => node.props.accessibilityLabel as string);
    expect(labels.filter(label => /save|settings|enable monitoring/i.test(label))).toEqual([]);
  });

  it('claims empty only for current complete evidence and keeps stale success and safe refresh errors visible', async () => {
    host.readInventory.mockResolvedValue(inventory({ state: 'complete' }));
    const { renderer, press } = await render();
    expect(text(renderer)).toContain('No Orbi units found.');
    expect(renderer.root.findAllByProps({ testID: 'orbi-attention-count' })).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(61000); }); await settle();
    expect(text(renderer)).toContain('Stale · current activity unknown');
    expect(text(renderer)).toContain(`Last success: ${stamp}`);
    expect(text(renderer)).not.toContain('No Orbi units found.');
    expect(renderer.root.findAllByProps({ testID: 'orbi-attention-count' })).toHaveLength(0);
    host.readInventory.mockRejectedValue(new Error('SECRET raw transport error'));
    await press('Refresh services');
    expect(text(renderer)).toContain('filesystem: refresh_failed');
    expect(text(renderer)).not.toContain('SECRET');
  });

  it('retains this host families as stale after failed refresh, without current counts', async () => {
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press } = await render();
    host.readInventory.mockRejectedValue(new Error('SECRET'));
    await press('Refresh services');
    expect(text(renderer)).toContain('Stale · current activity unknown');
    expect(text(renderer)).toContain(`Last success: ${stamp}`);
    expect(rowPage(renderer, 'orbi')).toContain('Slot 1 · Worker failed');
    expect(rowPage(renderer, 'orbi')).toContain('Running');
    expect(renderer.root.findAllByProps({ testID: 'orbi-attention-count' })).toHaveLength(0);
  });

  it.each(['partial', 'unavailable'] as const)('shows %s and problems without zero counts or absence claims', async state => {
    host.readInventory.mockResolvedValue(inventory({ state, sources: [], problems: [{ source: 'runtime', code: 'process_failed' }] }));
    const { renderer } = await render();
    expect(text(renderer)).toContain(`Services: ${state}`);
    expect(text(renderer)).toContain('runtime: process_failed');
    expect(text(renderer)).toContain('Read failed · check systemd/DBus access.');
    expect(renderer.root.findAllByProps({ testID: 'orbi-attention-count' })).toHaveLength(0);
    expect(text(renderer)).not.toContain('No Orbi units found');
    if (state === 'partial') expect(text(renderer)).toContain('units may be missing');
    else {
      expect(text(renderer)).toContain('Unavailable · current activity unknown');
      expect(text(renderer)).not.toContain('Observed in this host service check');
      await act(async () => { await vi.advanceTimersByTimeAsync(61000); }); await settle();
      expect(renderer.root.findByProps({ testID: 'orbi-host-services' }).findAllByType('Text' as any).map(node => node.children.join('')).join('\n')).not.toContain('Last success:');
    }
  });

  it('disables refresh without reading another host when offline', async () => {
    host.hosts[0].status = 'offline';
    const { renderer, press } = await render();
    expect(text(renderer)).toContain('Offline · current activity unknown');
    expect(text(renderer)).toContain('Catalog: offline');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Refresh services' }).props).toMatchObject({ disabled: true, accessibilityState: { disabled: true, busy: false } });
    await press('Refresh services');
    expect(host.readInventory).not.toHaveBeenCalled();
  });

  it.each(['unconfigured', 'invalid'] as const)('keeps %s visible with guidance collapsed below inventory and grants no repository authority', async state => {
    host.readCatalog.mockResolvedValue({ state, entries: [], problems: [] });
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press, switchTo } = await render();
    expect(text(renderer)).toContain(`Catalog: ${state}`);
    expect(text(renderer)).not.toContain('PASEO_ORBI_CONFIG');
    expect(text(renderer).indexOf('Host A · Fleet')).toBeLessThan(text(renderer).indexOf('Repository setup'));
    // A confirmed unconfigured catalog explains the missing repository detail once
    // above the rows instead of repeating the badge on every row.
    if (state === 'unconfigured') {
      expect(rowPage(renderer, 'orbi-demo')).not.toContain('Unlinked');
      expect(renderer.root.findByProps({ accessibilityLabel: 'Expand orbi-demo' }).props.accessibilityHint).not.toContain('Unlinked');
    } else expect(rowPage(renderer, 'orbi-demo')).toContain('Unlinked');
    expect(repositoryActions(renderer)).toHaveLength(0);
    await press('Expand orbi-demo'); await press('Unit details for orbi-demo');
    expect(rowPage(renderer, 'orbi-demo')).toContain('not in the current authorized catalog');
    await press('Repository setup');
    expect(text(renderer)).toContain('PASEO_ORBI_CONFIG');
    await switchTo('host-a', 'issues');
    expect(text(renderer)).toContain('PASEO_ORBI_CONFIG');
    for (const read of [host.readFleet, host.readIssues, host.readIssue, host.readRuns, host.readRun, host.readBlockers, host.readBlocker]) expect(read).not.toHaveBeenCalled();
  });

  it('explains a confirmed unconfigured catalog once above the rows and offers inventory-only refresh', async () => {
    const explanation = "Showing host services. Repository details aren't configured.";
    host.readCatalog.mockResolvedValue({ state: 'unconfigured', entries: [], problems: [] });
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press } = await render();
    const servicesTexts = () => renderer.root.findByProps({ testID: 'orbi-host-services' }).findAllByType('Text' as any).map(node => node.children.join(''));
    // One explanation, above the first host service row.
    expect(servicesTexts().filter(item => item === explanation)).toHaveLength(1);
    expect(servicesTexts().indexOf(explanation)).toBeLessThan(servicesTexts().indexOf('orbi'));
    // The setup action is a real disclosure with a 44-unit target.
    const instructions = () => renderer.root.findByProps({ accessibilityLabel: 'Setup instructions' });
    expect(instructions().props).toMatchObject({ accessibilityRole: 'button', accessibilityState: { expanded: false }, style: { minHeight: 44 } });
    expect(text(renderer)).not.toContain('PASEO_ORBI_CONFIG');
    await press('Setup instructions');
    expect(instructions().props.accessibilityState.expanded).toBe(true);
    expect(text(renderer)).toContain('PASEO_ORBI_CONFIG');
    expect(text(renderer)).toContain('explicitly reload');
    expect(servicesTexts().filter(item => item === explanation)).toHaveLength(1);
    // No repeated Unlinked badge: this catalog state already explains the missing repository details.
    for (const group of hostA.groups) expect(rowPage(renderer, group.label)).not.toContain('Unlinked');
    expect(repositoryActions(renderer)).toHaveLength(0);
    // No catalog refresh in this state, even with the setup panel open.
    expect(renderer.root.findByProps({ testID: 'orbi-catalog' }).findAllByProps({ accessibilityLabel: 'Refresh' })).toHaveLength(0);
    await press('Repository setup');
    expect(text(renderer)).toContain('Catalog: unconfigured');
    expect(renderer.root.findByProps({ testID: 'orbi-catalog' }).findAllByProps({ accessibilityLabel: 'Refresh' })).toHaveLength(0);
    // Separate spies: "Refresh services" reads inventory only and never the repository catalog.
    const catalogReads = host.readCatalog.mock.calls.length;
    const inventoryReads = host.readInventory.mock.calls.length;
    await press('Refresh services');
    expect(host.readInventory.mock.calls.length).toBe(inventoryReads + 1);
    expect(host.readCatalog.mock.calls.length).toBe(catalogReads);
  });

  it('keeps loading, invalid and offline states distinguishable from unconfigured', async () => {
    const explanation = "Showing host services. Repository details aren't configured.";
    let finishCatalog!: (value: DeploymentCatalog) => void;
    host.readCatalog.mockImplementationOnce(() => new Promise(resolve => { finishCatalog = resolve; }));
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, switchTo } = await render();
    expect(text(renderer)).toContain('Catalog: loading');
    expect(text(renderer)).not.toContain(explanation);
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Setup instructions' })).toHaveLength(0);
    await act(async () => finishCatalog({ state: 'invalid', entries: [], problems: [] })); await settle();
    expect(text(renderer)).toContain('Catalog: invalid');
    expect(text(renderer)).not.toContain(explanation);
    host.hosts[0].status = 'offline';
    await switchTo('host-a');
    expect(text(renderer)).toContain('Offline · current activity unknown');
    expect(text(renderer)).not.toContain(explanation);
  });

  it('keeps catalog stale/unavailable visible while setup is collapsed', async () => {
    const { renderer, press } = await render();
    host.readCatalog.mockRejectedValue(new Error('SECRET'));
    await press('Repository setup');
    await act(async () => renderer.root.findByProps({ testID: 'orbi-catalog' }).findByProps({ accessibilityLabel: 'Refresh' }).props.onPress()); await settle();
    await press('Repository setup');
    expect(text(renderer)).toContain('Catalog: stale');
    expect(text(renderer)).toContain('filesystem: refresh_failed');
    expect(text(renderer)).not.toContain('SECRET');
  });

  it('keeps initial catalog failure visible with retry and refuses repository detail', async () => {
    host.readCatalog.mockRejectedValue(new Error('SECRET'));
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press } = await render();
    expect(text(renderer)).toContain('Catalog: unavailable');
    expect(text(renderer)).not.toContain('SECRET');
    // A real read failure keeps the catalog retry and never reads as unconfigured.
    expect(text(renderer)).not.toContain("Showing host services. Repository details aren't configured.");
    await press('Repository setup');
    expect(text(renderer)).toContain('Catalog unavailable. Reconnect the selected host or ask the operator to check the plugin, then Refresh.');
    expect(renderer.root.findByProps({ testID: 'orbi-catalog' }).findAllByProps({ accessibilityLabel: 'Refresh' })).toHaveLength(1);
    expect(repositoryActions(renderer)).toHaveLength(0);
    expect(host.readFleet).not.toHaveBeenCalled();
  });

  it('mounts rich repositories only on expansion, stops collapsed polling and resets on host switch', async () => {
    const { renderer, press, switchTo } = await render();
    const disclosure = () => renderer.root.findByProps({ accessibilityLabel: 'Configured repositories' });
    expect(disclosure().props).toMatchObject({ accessibilityRole: 'button', accessibilityState: { expanded: false }, style: { minHeight: 44 } });
    expect(host.readFleet).not.toHaveBeenCalled();
    await press('Configured repositories');
    expect(disclosure().props.accessibilityState.expanded).toBe(true);
    expect(host.readFleet.mock.calls.map(([input]) => input.deploymentId)).toEqual(['demo']);
    expect(text(renderer)).toContain('Fleet — read-only');
    await press('Configured repositories');
    expect(text(renderer)).not.toContain('Fleet — read-only');
    const calls = host.readFleet.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(61000); }); await settle();
    expect(host.readFleet).toHaveBeenCalledTimes(calls);
    await press('Configured repositories');
    host.hosts.push({ serverId: 'host-b', label: 'Host B', status: 'online' });
    await switchTo('host-b');
    expect(disclosure().props.accessibilityState.expanded).toBe(false);
    await switchTo('host-a');
    expect(disclosure().props.accessibilityState.expanded).toBe(false);
  });

  it('lists unobserved configured deployments, loads only one detail and preserves selected navigation', async () => {
    host.readCatalog.mockResolvedValue(catalog([demo, second]));
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: [family('orbi-second', 'matched', 'second', [unit('orbi-second@1.service', 'service', 'active', 'running')])] }));
    const { renderer, press, openScreen } = await render({ deploymentId: 'demo' });
    expect(text(renderer)).toContain('Not observed in this host service check');
    expect(text(renderer)).toContain('Observed in this host service check');
    expect(host.readFleet.mock.calls.map(([input]) => input.deploymentId)).toEqual(['demo']);
    await press('Show details for Second');
    expect(host.readFleet.mock.calls.map(([input]) => input.deploymentId)).toEqual(['demo', 'second']);
    await press('Open Runs');
    expect(openScreen).toHaveBeenCalledWith({ screenId: 'runs', params: { deploymentId: 'demo' } });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Configured repositories' }).props.accessibilityState.expanded).toBe(true);
    await press('Configured repositories');
    expect(text(renderer)).not.toContain('Fleet — read-only');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Configured repositories' }).props.accessibilityState.expanded).toBe(false);
  });
});
