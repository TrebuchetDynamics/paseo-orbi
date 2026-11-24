import './helpers/host';
import { host } from './helpers/host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { Shell } from '../client/shell';
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
const demo: DeploymentCatalog['entries'][number] = { id: 'demo', label: 'Demo', repo: 'Example/project', adapter: 'orbi-0.7.41-release', status: 'available', problems: [], controls: null };
const second = { ...demo, id: 'second', label: 'Second', repo: 'Other/repository' };
const catalog = (entries: DeploymentCatalog['entries']): DeploymentCatalog => ({ state: 'configured', problems: [], entries });
const props = (id = 'host-a'): PluginScreenProps => ({ theme: { colors: { surface0: '#111', surface1: '#222', surface2: '#2a2a2a', border: '#555', foreground: '#eee', foregroundMuted: '#aaa', accent: '#abc', accentForeground: '#000', statusSuccess: '#0f0', statusWarning: '#ff0', statusDanger: '#f00' } }, host: { id, label: host.hosts.find(item => item.serverId === id)?.label ?? (id === 'host-a' ? 'Host A' : 'Host B') }, layout: { compact: true, platform: 'ios' }, params: {} } as PluginScreenProps);
beforeEach(() => {
  host.readControl.mockReset();
  host.readCatalog.mockReset().mockResolvedValue(catalog([demo]));
  host.readInventory.mockReset().mockResolvedValue(inventory({ state: 'off' }));
  host.readFleet.mockReset().mockResolvedValue({ state: 'available', observedAt: stamp, lastSuccessfulAt: stamp, problems: [] });
  for (const read of [host.readIssues, host.readIssue, host.readRuns, host.readRun, host.readBlockers, host.readBlocker]) read.mockClear();
});
const settle = async () => { for (let n = 0; n < 3; n++) await act(async () => { await vi.advanceTimersByTimeAsync(2); }); };
// The Services screen is its own route: no Work, no Configured repositories.
async function render(params: PluginScreenProps['params'] = {}, route = 'services') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanups.push(() => client.clear());
  const openScreen = vi.fn();
  const tree = (id = 'host-a', nextRoute = route, next = params) => <QueryClientProvider client={client}><Shell {...props(id)} params={next} route={nextRoute} openScreen={openScreen} /></QueryClientProvider>;
  let renderer!: ReactTestRenderer;
  vi.useFakeTimers(); vi.setSystemTime(new Date(stamp));
  await act(async () => { renderer = create(tree()); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); });
  await settle();
  const press = async (label: string) => { await act(async () => renderer.root.findByProps({ accessibilityLabel: label }).props.onPress()); await settle(); };
  const switchTo = async (id: string, nextRoute = route, next = params) => { await act(async () => renderer.update(tree(id, nextRoute, next))); await settle(); };
  return { renderer, client, press, switchTo, openScreen };
}
const text = (renderer: ReactTestRenderer) => renderer.root.findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
const row = (renderer: ReactTestRenderer, label: string) => renderer.root.findByProps({ testID: `orbi-family-${label}` });
const rowPage = (renderer: ReactTestRenderer, label: string) => row(renderer, label).findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
const repositoryActions = (renderer: ReactTestRenderer) => renderer.root.findAll(node => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith('View repository'));
// The host service inventory only; nothing else on this screen is service evidence.
const servicesText = (renderer: ReactTestRenderer) => renderer.root.findByProps({ testID: 'orbi-host-services' })
  .findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
const detailRows = (renderer: ReactTestRenderer) => renderer.root.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('orbi-family-'));
const detailsName = (label: string) => `Details for ${label}`;
const rowName = (renderer: ReactTestRenderer, label: string) => row(renderer, label).findAllByType('Text' as any)[0].children.join('');

describe('Services screen without accordions', () => {
  it('lists every observed group failures first with repository titles, worker/timer facts and no raw unit data', async () => {
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, openScreen, press } = await render();
    const page = text(renderer);
    // One Services heading, no duplicated Fleet/page title, no Work surface.
    expect(renderer.root.findAllByProps({ testID: 'orbi-work' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'orbi-services-heading' }).props.children).toBe('Services · Host A');
    expect(renderer.root.findByProps({ testID: 'orbi-services-heading' }).props.accessibilityRole).toBe('header');
    expect(page).not.toContain('· Fleet');
    expect(page).toContain('1 of 5 groups needs attention');
    const ids = detailRows(renderer).map(node => node.props.testID);
    expect(ids).toEqual(['orbi', 'orbi-demo', 'orbi-aux', 'orbi-clash', 'orbi-core'].map(id => `orbi-family-${id}`));
    // Verified repository name for the unique authorized match, display names otherwise.
    expect(rowName(renderer, 'orbi-demo')).toBe('Example/project');
    expect(rowName(renderer, 'orbi')).toBe('orbi');
    // Every row is fully visible without a tap: no chevron, no expansion control.
    for (const label of ['orbi', 'orbi-demo', 'orbi-aux', 'orbi-clash', 'orbi-core']) {
      const content = rowPage(renderer, label);
      expect(content).not.toMatch(/▸|▾|@|load |runtime/i);
      expect(content).not.toMatch(/^(Expand|Collapse) /m);
      expect(row(renderer, label).findAllByProps({ accessibilityLabel: `Expand ${label}` })).toHaveLength(0);
    }
    expect(rowPage(renderer, 'orbi')).toContain('Slot 1 · Worker failed');
    expect(rowPage(renderer, 'orbi')).toContain('Running');
    expect(rowPage(renderer, 'orbi')).toContain('Timer waiting');
    expect(rowPage(renderer, 'orbi')).toContain('Unlinked');
    expect(rowPage(renderer, 'orbi-demo')).toContain('Idle');
    expect(rowPage(renderer, 'orbi-demo')).toContain('Timer waiting');
    expect(rowPage(renderer, 'orbi-aux')).toContain('Installed');
    for (const id of ['orbi-core', 'orbi-clash']) {
      expect(rowPage(renderer, id)).toContain('Unknown / transitional');
      expect(rowPage(renderer, id)).not.toContain('Idle');
    }
    for (const group of hostA.groups) expect(rowPage(renderer, group.label).length).toBeLessThan(160);
    expect(repositoryActions(renderer).map(node => node.props.accessibilityLabel)).toEqual(['View repository Demo']);
    await press('View repository Demo');
    expect(openScreen).toHaveBeenCalledWith({ screenId: 'issues', params: { deploymentId: 'demo' } });
    // Services reads this host's inventory only: no repository detail or GitHub read.
    expect(host.readFleet).not.toHaveBeenCalled();
    expect(host.readIssues).not.toHaveBeenCalled();
    expect(host.readCatalog).toHaveBeenCalledTimes(1);
    expect(host.readInventory).toHaveBeenCalledTimes(1);
    for (const testID of ['orbi-host-services', 'orbi-catalog']) {
      expect(renderer.root.findByProps({ testID }).findAllByProps({ accessibilityRole: 'alert' }).filter(node => !node.props.children)).toHaveLength(0);
    }
  });

  it('pairs exact numeric slots and separates raw unit data and states on the diagnostic view', async () => {
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: [family('orbi', 'unmatched', null, [
      unit('orbi@10.timer', 'timer', 'active', 'waiting'), unit('orbi@1.timer', 'timer', 'active', 'waiting'),
      unit('orbi@1.service', 'service', 'inactive', 'dead'), unit('orbi@2.service', 'service', 'active', 'exited'),
      unit('orbi@3.service', 'service', null, null), unit('orbi@01.service', 'service', 'activating', 'start'),
      unit('orbi@4.service', 'service', 'active', 'running'), unit('orbi@4.timer', 'timer', 'failed', 'failed'),
      unit('orbi@.service', 'service', null, null),
    ])] }));
    const { renderer, press } = await render();
    expect(rowPage(renderer, 'orbi')).toContain('Slot 4 · Timer failed');
    expect(rowPage(renderer, 'orbi')).toContain('Running');
    expect(rowPage(renderer, 'orbi')).toContain('Timer waiting');
    const reads = host.readInventory.mock.calls.length;
    await press('Details for orbi');
    // The row's list is replaced by the separate host-scoped diagnostic view.
    expect(renderer.root.findAllByProps({ testID: 'orbi-host-services' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'orbi-service-details-heading' }).props.children).toBe('Service details · Host A');
    expect(renderer.root.findByProps({ testID: 'orbi-service-details-heading' }).props.accessibilityRole).toBe('header');
    // Opening details performs no read and no control action.
    expect(host.readInventory.mock.calls.length).toBe(reads);
    expect(host.readControl).not.toHaveBeenCalled();
    const details = text(renderer);
    expect(details).toContain('Slot 1 · Worker idle · Timer waiting');
    expect(details).toContain('Slot 2 · Worker active/exited · Timer not observed');
    expect(details).toContain('Slot 3 · Worker unknown · Timer not observed');
    expect(details).toContain('Slot 4 · Worker running · Timer failed');
    expect(details.indexOf('Slot 4 · Worker running · Timer failed')).toBeLessThan(details.indexOf('Slot 1 · Worker idle · Timer waiting'));
    expect(details).toContain('Slot 01 · Worker activating/start · Timer not observed');
    expect(details).toContain('Slot 10 · Worker not observed · Timer waiting');
    expect(details).toContain('Unit activity does not establish issue delivery');
    // Raw unit records and the full association context need the disclosure.
    expect(details).not.toContain('orbi@.service');
    expect(details).not.toContain('Discovery is not authority');
    expect(renderer.root.findAllByProps({ testID: 'orbi-service-units' })).toHaveLength(0);
    await press('View diagnostics');
    expect(host.readInventory.mock.calls.length).toBe(reads);
    const raw = text(renderer);
    expect(raw).toContain('orbi@.service: runtime not observed; unit file enabled (template, not a running service)');
    expect(raw).toContain('Discovery is not authority');
    // Back returns to the same list, with the same rows and order.
    await press('Back to services');
    expect(renderer.root.findAllByProps({ testID: 'orbi-host-services' })).toHaveLength(1);
    expect(detailRows(renderer).map(node => node.props.testID)).toEqual(['orbi-family-orbi']);
    expect(rowPage(renderer, 'orbi')).not.toContain('orbi@');
  });

  it('names the worker and the timer in each slot and explains both once behind the diagnostics disclosure', async () => {
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: [family('orbi', 'unmatched', null, [
      unit('orbi@3.service', 'service', 'failed', 'failed'),
      unit('orbi@1.service', 'service', 'inactive', 'dead'), unit('orbi@1.timer', 'timer', 'active', 'waiting'),
    ])] }));
    const { renderer, press } = await render();
    await press('Details for orbi');
    const details = text(renderer);
    expect(details).toContain('Slot 3 · Worker failed · Timer not observed');
    expect(details).toContain('Slot 1 · Worker idle · Timer waiting');
    expect(details.indexOf('Slot 3 · Worker failed · Timer not observed')).toBeLessThan(details.indexOf('Slot 1 · Worker idle · Timer waiting'));
    // The slot explanation is not part of the default detail view.
    expect(details).not.toContain('The timer schedules a check.');
    expect(renderer.root.findAllByProps({ testID: 'orbi-service-slot-explanation' })).toHaveLength(0);
    await press('View diagnostics');
    // One explanation for the list, never once per slot summary.
    const explanation = renderer.root.findAllByProps({ testID: 'orbi-service-slot-explanation' });
    expect(explanation).toHaveLength(1);
    expect(explanation[0].props.children).toBe('The timer schedules a check. The worker runs it. They are two parts of the same slot, not two workers.');
    expect(text(renderer).match(/The timer schedules a check\./g)).toHaveLength(1);
    // Waiting is a timer fact only: it never claims a queued issue or a second worker.
    expect(text(renderer)).toContain('Unit activity does not establish issue delivery');
    expect(text(renderer)).not.toMatch(/queued|two workers run/i);
  });

  it('changes only the worker fact when an idle worker starts and the timer keeps waiting', async () => {
    const group = (worker: [string, string]) => inventory({ state: 'complete', groups: [family('orbi', 'unmatched', null, [
      unit('orbi@1.service', 'service', ...worker), unit('orbi@1.timer', 'timer', 'active', 'waiting'),
    ])] });
    host.readInventory.mockResolvedValue(group(['inactive', 'dead']));
    const { renderer, press } = await render();
    await press('Details for orbi');
    expect(text(renderer)).toContain('Slot 1 · Worker idle · Timer waiting');
    host.readInventory.mockResolvedValue(group(['active', 'running']));
    await act(async () => { await vi.advanceTimersByTimeAsync(31000); }); await settle();
    const details = text(renderer);
    expect(details).toContain('Slot 1 · Worker running · Timer waiting');
    expect(details).not.toContain('Worker idle');
    expect(details).toContain('Timer waiting');
  });

  it('keeps an unobserved, transitional or unreadable worker named as the worker instead of claiming it stopped', async () => {
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: [family('orbi', 'unmatched', null, [
      unit('orbi@1.service', 'service', null, null),
      unit('orbi@2.service', 'service', 'active', 'exited'),
      unit('orbi@3.service', 'service', 'inactive', 'dead', 'error'),
      unit('orbi@4.timer', 'timer', 'active', 'waiting'),
    ])] }));
    const { renderer, press } = await render();
    await press('Details for orbi');
    const details = text(renderer);
    expect(details).toContain('Slot 1 · Worker unknown · Timer not observed');
    expect(details).toContain('Slot 2 · Worker active/exited · Timer not observed');
    expect(details).toContain('Slot 3 · Worker load error · inactive/dead · Timer not observed');
    expect(details).toContain('Slot 4 · Worker not observed · Timer waiting');
    expect(details).not.toMatch(/Worker (?:stopped|not running)/i);
    expect(details).not.toMatch(/Idle/);
  });

  it('adds no slot explanation when the group has no numeric slot', async () => {
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: [family('orbi', 'unmatched', null, [
      unit('orbi@.service', 'service', null, null),
    ])] }));
    const { renderer, press } = await render();
    await press('Details for orbi');
    await press('View diagnostics');
    expect(renderer.root.findAllByProps({ testID: 'orbi-service-slot-explanation' })).toHaveLength(0);
    expect(text(renderer)).not.toContain('The timer schedules a check.');
    expect(text(renderer)).toContain('orbi@.service: runtime not observed');
  });

  it('does not infer absent counterparts from partial inventory and retains partial evidence as a success', async () => {
    host.readInventory.mockResolvedValue(inventory({ state: 'partial', groups: [family('orbi', 'unmatched', null, [
      unit('orbi@1.service', 'service', 'inactive', 'dead'), unit('orbi@2.timer', 'timer', 'active', 'waiting'),
    ])], problems: [{ source: 'runtime', code: 'row_limit' }] }));
    const { renderer, press, client } = await render();
    expect(text(renderer)).toContain('Partial · units may be missing.');
    expect(text(renderer)).toContain('0 of 1 observed groups need attention');
    await press('Details for orbi');
    const details = text(renderer);
    expect(details).toContain('Slot 1 · Worker idle · Timer not observed');
    expect(details).toContain('Slot 2 · Worker not observed · Timer waiting');
    expect(details).not.toMatch(/missing|not found/);
    expect(client.getQueryData(['paseo-orbi', 'host-a', 'host', 'services.inventory'])).toMatchObject({ state: 'partial', lastSuccessfulAt: stamp });
    await press('Back to services');
    host.readInventory.mockRejectedValue(new Error('failed'));
    await press('Refresh services');
    expect(text(renderer)).toContain(`Last success: ${stamp}`);
    expect(text(renderer)).toContain('Stale · current activity unknown');
    expect(rowPage(renderer, 'orbi')).toContain('Last seen ' + stamp);
    await press('Details for orbi');
    expect(text(renderer)).toContain('Slot 2 · Worker not observed · Timer waiting');
    // The diagnostic view labels retained raw data with its last successful time.
    expect(text(renderer)).toContain(`Last seen ${stamp}. Current activity unknown.`);
  });

  it.each(['not-found', 'error', 'unknown'])('never labels %s load as Idle at row or slot level', async loadState => {
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: [family('orbi', 'unmatched', null, [
      unit('orbi@1.service', 'service', 'inactive', 'dead', loadState), unit('orbi@1.timer', 'timer', 'inactive', 'dead', loadState),
    ])] }));
    const { renderer, press } = await render();
    expect(rowPage(renderer, 'orbi')).toContain('Unknown / transitional');
    expect(rowPage(renderer, 'orbi')).not.toContain('Idle');
    await press('Details for orbi');
    expect(text(renderer)).not.toMatch(/Idle|Timer idle/);
    expect(text(renderer)).toContain(loadState === 'not-found' ? 'Worker not found · Timer not found' : `Worker load ${loadState} · inactive/dead`);
  });

  it('resolves final mixed raw/short display-name collisions to exact family labels', async () => {
    const labels = ['orbi-12345678', 'orbi-orbi-12345678-12345678'];
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: labels.map(label => family(label, 'unmatched', null, [unit(`${label}@1.service`, 'service', 'inactive', 'dead')])) }));
    const { renderer } = await render();
    for (const label of labels) {
      expect(rowName(renderer, label)).toBe(label);
      expect(rowPage(renderer, label)).toContain('Idle');
      expect(rowPage(renderer, label)).toContain('Unlinked');
    }
    expect(repositoryActions(renderer)).toHaveLength(0);
  });

  it('resolves a details label that left the evidence honestly instead of trusting it', async () => {
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press } = await render();
    await press('Details for Example/project');
    expect(text(renderer)).toContain('Example/project');
    // The selected host's next observation no longer contains that family.
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: hostA.groups.filter(group => group.label !== 'orbi-demo') }));
    await act(async () => { await vi.advanceTimersByTimeAsync(31000); }); await settle();
    const missing = renderer.root.findByProps({ testID: 'orbi-service-details-missing' });
    expect(missing.props.children).toContain('not in the current host evidence');
    expect(renderer.root.findAllByProps({ testID: 'orbi-service-units' })).toHaveLength(0);
    expect(text(renderer)).not.toContain('orbi-demo@1.service');
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Actions for orbi-demo' })).toHaveLength(0);
    // Back returns to the surviving list without the removed family.
    await press('Back to services');
    expect(detailRows(renderer).map(node => node.props.testID)).toEqual(['orbi-family-orbi', 'orbi-family-orbi-aux', 'orbi-family-orbi-clash', 'orbi-family-orbi-core']);
  });

  it('shortens only known prefixes for display, disambiguates slug collisions and never invents repository links', async () => {
    const labels = ['orbi-short-trunc-1234abcd', 'orbi-same-1234abcd', 'orbi-same-9876abcd'];
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: labels.map(label => family(label, 'unmatched', null, [unit(`${label}@1.service`, 'service', 'inactive', 'dead')])) }));
    const { renderer, press } = await render();
    expect(rowName(renderer, labels[0])).toBe('short-trunc');
    expect(rowName(renderer, labels[1])).toBe('same · 1234abcd');
    expect(rowName(renderer, labels[2])).toBe('same · 9876abcd');
    expect(repositoryActions(renderer)).toHaveLength(0);
    expect(text(renderer)).not.toContain(labels[0]);
    await press('Details for short-trunc');
    expect(text(renderer)).toContain('short-trunc');
    expect(text(renderer)).not.toContain(labels[0]);
    await press('View diagnostics');
    expect(text(renderer)).toContain(labels[0]);
  });

  it('keeps the selected details host-scoped and resets selection and setup on host switch', async () => {
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press, switchTo } = await render();
    await press('Details for Example/project');
    await press('View diagnostics');
    expect(text(renderer)).toContain('orbi-demo@1.service');
    host.hosts.push({ serverId: 'host-b', label: 'Host B', status: 'online' });
    host.readInventory.mockResolvedValue(hostB);
    await switchTo('host-b');
    // A host switch shows the new host's list, never the previous host's detail.
    expect(renderer.root.findAllByProps({ testID: 'orbi-service-details' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'orbi-services-heading' }).props.children).toBe('Services · Host B');
    expect(rowPage(renderer, 'orbi')).toContain('Running');
    expect(text(renderer)).not.toContain('Example/project');
    expect(text(renderer)).not.toContain('orbi-demo@1.service');
    await switchTo('host-a');
    expect(renderer.root.findAllByProps({ testID: 'orbi-service-details' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'orbi-services-heading' }).props.children).toBe('Services · Host A');
  });

  it('keeps a cancelled pending host-A result out of host B with the same family and slot', async () => {
    let finishA!: (value: ServiceInventory) => void;
    host.readInventory.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve as typeof finishA; })).mockResolvedValue(hostB);
    const { renderer, client, switchTo } = await render();
    expect(text(renderer)).toContain('Reading services…');
    host.hosts.push({ serverId: 'host-b', label: 'Host B', status: 'online' });
    await switchTo('host-b');
    expect(text(renderer)).toContain('Services · Host B');
    expect(rowPage(renderer, 'orbi')).toContain('Running');
    await act(async () => finishA(hostA)); await settle();
    expect(text(renderer)).not.toContain('Failed');
    expect(client.getQueryData(['paseo-orbi', 'host-a', 'host', 'services.inventory'])).toBeUndefined();
  });
});

describe('service details lead with the service and slot status', () => {
  // The phone-sized (compact) detail view the issue describes: one unlinked
  // synthetic family with an idle worker and a waiting timer.
  const unlinked = inventory({ state: 'complete', groups: [family('orbi-unclaimed', 'unmatched', null, [
    unit('orbi-unclaimed@1.service', 'service', 'inactive', 'dead'),
    unit('orbi-unclaimed@1.timer', 'timer', 'active', 'waiting'),
  ])] });
  const explanationCopy = 'The timer schedules a check. The worker runs it. They are two parts of the same slot, not two workers.';
  const association = (renderer: ReactTestRenderer) => renderer.root.findByProps({ testID: 'orbi-service-association' });
  const diagnosticsToggle = (renderer: ReactTestRenderer) => renderer.root.findByProps({ accessibilityLabel: 'View diagnostics' });

  it('leads with the service name and slot status, keeps setup and raw units out, and reveals diagnostics on request', async () => {
    host.readInventory.mockResolvedValue(unlinked);
    const { renderer, press } = await render();
    const catalogReads = host.readCatalog.mock.calls.length;
    const inventoryReads = host.readInventory.mock.calls.length;
    await press('Details for orbi-unclaimed');
    const page = text(renderer);
    // Name and the failed-first slot facts come before the association note.
    expect(page.indexOf('orbi-unclaimed')).toBeLessThan(page.indexOf('Slot 1 · Worker idle · Timer waiting'));
    expect(page.indexOf('Slot 1 · Worker idle · Timer waiting')).toBeLessThan(page.indexOf('Not linked to a repository.'));
    expect(association(renderer).props.children).toBe('Not linked to a repository.');
    expect(page).toContain('Unit activity does not establish issue delivery');
    // Neither the shared repository notice and guide nor raw unit records occupy
    // the default detail view.
    expect(renderer.root.findAllByProps({ testID: 'orbi-setup' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Setup guide' })).toHaveLength(0);
    expect(page).not.toContain('Repositories aren’t linked.');
    expect(page).not.toContain('PASEO_ORBI_CONFIG');
    expect(page).not.toContain('orbi-unclaimed@1.service');
    expect(page).not.toContain('load loaded');
    expect(renderer.root.findAllByProps({ testID: 'orbi-service-units' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'orbi-service-diagnostics' })).toHaveLength(0);
    // Back stays a button above the facts.
    expect(renderer.root.findByProps({ accessibilityLabel: 'Back to services' }).props)
      .toMatchObject({ accessibilityRole: 'button', accessibilityState: { disabled: false } });
    expect(diagnosticsToggle(renderer).props)
      .toMatchObject({ accessibilityRole: 'button', accessibilityState: { expanded: false } });
    expect(diagnosticsToggle(renderer).props.style({ pressed: false })).toMatchObject({ minHeight: 44 });
    // One activation reveals the existing #94 explanation, the full association
    // context and the raw records, with no additional read and no mutation.
    await press('View diagnostics');
    const expanded = text(renderer);
    expect(diagnosticsToggle(renderer).props.accessibilityState.expanded).toBe(true);
    expect(expanded).toContain(explanationCopy);
    expect(expanded).toContain('Discovered on this host only; no configured deployment claims this unit name');
    expect(expanded).toContain('Raw unit data follows.');
    expect(expanded).toContain('orbi-unclaimed@1.service: inactive/dead, load loaded');
    expect(expanded).toContain('orbi-unclaimed@1.timer: active/waiting, load loaded');
    expect(host.readInventory.mock.calls.length).toBe(inventoryReads);
    expect(host.readCatalog.mock.calls.length).toBe(catalogReads);
    expect(host.readControl).not.toHaveBeenCalled();
    // Closing it returns to the leading facts only.
    await press('View diagnostics');
    expect(diagnosticsToggle(renderer).props.accessibilityState.expanded).toBe(false);
    expect(renderer.root.findAllByProps({ testID: 'orbi-service-units' })).toHaveLength(0);
    expect(text(renderer)).not.toContain(explanationCopy);
  });

  it('publishes Not linked to a repository only when this host catalog was read', async () => {
    host.readInventory.mockResolvedValue(unlinked);
    host.readCatalog.mockResolvedValue({ state: 'invalid', entries: [], problems: [] });
    const { renderer, press } = await render();
    await press('Details for orbi-unclaimed');
    expect(text(renderer)).not.toContain('Not linked to a repository.');
    expect(association(renderer).props.children).toBe('Repository link not confirmed: this host’s repository catalog could not be read.');
    // Neither the setup notice nor the guide follows the service onto this view.
    expect(renderer.root.findAllByProps({ testID: 'orbi-setup' })).toHaveLength(0);
    await press('View diagnostics');
    expect(text(renderer)).toContain('could not be read, so no repository link is confirmed');
    expect(text(renderer)).not.toContain('Discovered on this host only');
  });

  it('reports a still-pending catalog read as not yet confirmed instead of failed or unauthorized', async () => {
    host.readInventory.mockResolvedValue(hostA);
    let finishCatalog!: (value: DeploymentCatalog) => void;
    host.readCatalog.mockImplementation(() => new Promise(resolve => { finishCatalog = resolve as typeof finishCatalog; }));
    const { renderer, press } = await render();
    // Inventory arrived first: the matched family has no catalog entry yet and the
    // unmatched family has no confirmed absence. Neither is a catalog failure, and
    // pending evidence unlocks no repository action on the list either.
    expect(repositoryActions(renderer)).toHaveLength(0);
    await press('Details for orbi-demo');
    expect(association(renderer).props.children).toBe('Repository link not yet confirmed: this host’s repository catalog has not been read yet.');
    const page = text(renderer);
    expect(page).not.toContain('not in the current authorized catalog');
    expect(page).not.toContain('restore authorization');
    expect(page).not.toContain('could not be read');
    expect(page).not.toContain('Not linked to a repository.');
    await press('View diagnostics');
    expect(text(renderer)).toContain('Repository link not yet confirmed: this host’s repository catalog has not been read yet, so no repository link is confirmed');
    await press('Back to services');
    await press('Details for orbi');
    expect(association(renderer).props.children).toBe('Repository link not yet confirmed: this host’s repository catalog has not been read yet.');
    await press('Back to services');
    // The same view shows the supported result once the read settles.
    await act(async () => finishCatalog(catalog([demo]))); await settle();
    // Settled positive evidence is the only evidence that offers the action.
    expect(repositoryActions(renderer)).toHaveLength(1);
    await press('Details for Example/project');
    expect(association(renderer).props.children).toBe('Matches configured deployment Demo (Example/project) by unit name.');
    await press('Back to services');
    await press('Details for orbi');
    expect(association(renderer).props.children).toBe('Not linked to a repository.');
  });

  it('settles a failed catalog read as unavailable for a matched family, never absent', async () => {
    host.readInventory.mockResolvedValue(hostA);
    host.readCatalog.mockRejectedValue(new Error('SECRET'));
    const { renderer, press } = await render();
    // A settled read that confirmed nothing offers no repository action.
    expect(repositoryActions(renderer)).toHaveLength(0);
    await press('Details for orbi-demo');
    expect(association(renderer).props.children).toBe('Repository link not confirmed: this host’s repository catalog could not be read.');
    const page = text(renderer);
    expect(page).not.toContain('not in the current authorized catalog');
    expect(page).not.toContain('Repository link not yet confirmed');
    expect(page).not.toContain('SECRET');
  });

  it('keeps an unlinked claim confirmed only while the catalog read succeeds', async () => {
    host.readInventory.mockResolvedValue(unlinked);
    host.readCatalog.mockResolvedValue({ state: 'unconfigured', entries: [], problems: [] });
    const { renderer, press } = await render();
    await press('Details for orbi-unclaimed');
    expect(association(renderer).props.children).toBe('Not linked to a repository.');
    await press('Back to services');
    host.readCatalog.mockRejectedValue(new Error('SECRET'));
    await act(async () => { await vi.advanceTimersByTimeAsync(31000); }); await settle();
    // The shared notice keeps its failed read and retry on the list.
    expect(text(renderer)).toContain('Catalog read failed');
    await press('Details for orbi-unclaimed');
    expect(text(renderer)).not.toContain('Not linked to a repository.');
    expect(text(renderer)).not.toContain('SECRET');
    expect(renderer.root.findAllByProps({ testID: 'orbi-setup' })).toHaveLength(0);
  });

  it('opens diagnostics closed for every new selection and carries no previous service facts', async () => {
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: [
      family('orbi-a', 'unmatched', null, [unit('orbi-a@1.service', 'service', 'inactive', 'dead')]),
      family('orbi-b', 'unmatched', null, [unit('orbi-b@1.service', 'service', 'active', 'running')]),
    ] }));
    const { renderer, press } = await render();
    await press('Details for orbi-a');
    await press('View diagnostics');
    expect(diagnosticsToggle(renderer).props.accessibilityState.expanded).toBe(true);
    expect(text(renderer)).toContain('orbi-a@1.service: inactive/dead, load loaded');
    await press('Back to services');
    await press('Details for orbi-b');
    expect(diagnosticsToggle(renderer).props.accessibilityState.expanded).toBe(false);
    expect(renderer.root.findAllByProps({ testID: 'orbi-service-units' })).toHaveLength(0);
    expect(text(renderer)).not.toContain('orbi-a@1.service');
    expect(text(renderer)).toContain('Slot 1 · Worker running · Timer not observed');
  });

  it('keeps granted actions and their confirmation beside the leading facts', async () => {
    host.readCatalog.mockResolvedValue(catalog([{ ...demo, controls: { actions: ['start', 'stop'], slots: 2 } }]));
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press } = await render();
    await press('Details for Example/project');
    expect(text(renderer).indexOf('Slot 1 · Worker idle · Timer waiting'))
      .toBeLessThan(text(renderer).indexOf('Matches configured deployment Demo (Example/project) by unit name.'));
    await press('Actions for orbi-demo');
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Start slot 1' })).toHaveLength(1);
    await press('View diagnostics');
    expect(host.readControl).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Start slot 1' })).toHaveLength(1);
    expect(text(renderer)).toContain('orbi-demo@1.service: inactive/dead, load loaded');
  });
});

describe('service details without numbered slots', () => {
  // The known auxiliary exporter has no @N instance: one observed unit carries
  // the whole group's state, so no slot line can name it.
  const exporter = (activeState: string, subState: string) => inventory({ state: 'complete', groups: [
    { label: 'orbi-exporter', kind: 'auxiliary', association: 'unmatched', deploymentId: null,
      units: [unit('orbi-exporter.service', 'service', activeState, subState)] } as InventoryGroup,
  ] });
  const slotted = inventory({ state: 'complete', groups: [family('orbi-unclaimed', 'unmatched', null, [
    unit('orbi-unclaimed@1.service', 'service', 'inactive', 'dead'),
    unit('orbi-unclaimed@1.timer', 'timer', 'active', 'waiting'),
  ])] });

  it('keeps a failed service without a numbered slot visible when Details opens with diagnostics closed', async () => {
    host.readInventory.mockResolvedValue(exporter('failed', 'failed'));
    const { renderer, press } = await render();
    expect(rowPage(renderer, 'orbi-exporter')).toContain('Worker failed');
    await press('Details for orbi-exporter');
    const page = text(renderer);
    expect(page).toContain('orbi-exporter');
    expect(page).toContain('Worker failed');
    expect(page).toContain('Unit activity does not establish issue delivery');
    // The status is the list's own derivation: no slot or timer is synthesized
    // and no raw unit record appears before the disclosure.
    expect(page).not.toMatch(/Slot \d/);
    expect(page).not.toContain('orbi-exporter.service');
    expect(renderer.root.findAllByProps({ testID: 'orbi-service-units' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'orbi-service-slot-explanation' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'orbi-service-status' })).toHaveLength(1);
  });

  it('keeps retained-evidence freshness explicit beside that status', async () => {
    host.readInventory.mockResolvedValue(exporter('failed', 'failed'));
    const { renderer, press } = await render();
    host.readInventory.mockRejectedValue(new Error('failed'));
    await press('Refresh services');
    expect(text(renderer)).toContain('Stale · current activity unknown');
    await press('Details for orbi-exporter');
    const page = text(renderer);
    expect(page).toContain('Worker failed');
    expect(page).toContain(`Last seen ${stamp}. Current activity unknown.`);
  });

  it('shows no fallback status when the group has numbered slot lines', async () => {
    host.readInventory.mockResolvedValue(slotted);
    const { renderer, press } = await render();
    await press('Details for orbi-unclaimed');
    expect(text(renderer)).toContain('Slot 1 · Worker idle · Timer waiting');
    expect(renderer.root.findAllByProps({ testID: 'orbi-service-status' })).toHaveLength(0);
  });
});

describe('compact first-screen triage', () => {
  it('names the selected host, attention count, first failed slot and remaining failures before any other group', async () => {
    host.hosts[0].label = 'BlueBlack';
    host.readInventory.mockResolvedValue(nineGroups('failed', 'failed'));
    const { renderer, press } = await render();
    const page = text(renderer);
    expect(renderer.root.findByProps({ testID: 'orbi-services-heading' }).props.children).toBe('Services · BlueBlack');
    expect(page).toContain('1 of 9 groups needs attention');
    const refresh = renderer.root.findByProps({ accessibilityLabel: 'Refresh services' });
    expect(refresh.props).toMatchObject({ accessibilityRole: 'button', disabled: false, accessibilityState: { disabled: false, busy: false } });
    // Nine distinct groups, failed group first: the first row is the affected one.
    expect(detailRows(renderer).map(node => node.props.testID)).toEqual(['orbi', 'orbi-g1', 'orbi-g2', 'orbi-g3', 'orbi-g4', 'orbi-g5', 'orbi-g6', 'orbi-g7', 'orbi-g8']
      .map(label => `orbi-family-${label}`));
    const failedRow = row(renderer, 'orbi');
    expect(rowPage(renderer, 'orbi')).toContain('Slot 3 · Worker failed · +1 more');
    expect(rowPage(renderer, 'orbi')).toContain('Running');
    // "Visible before scrolling" in the compact renderer: the failed row is above
    // every later group, with no tap or disclosure in between.
    const lines = page.split('\n');
    expect(lines.indexOf('Services · BlueBlack')).toBeLessThan(lines.indexOf('1 of 9 groups needs attention'));
    expect(lines.indexOf('1 of 9 groups needs attention')).toBeLessThan(lines.indexOf('Refresh services'));
    expect(lines.indexOf('Slot 3 · Worker failed · +1 more')).toBeLessThan(lines.indexOf('orbi-g1'));
    expect(failedRow.findAllByProps({ accessibilityLabel: 'Details for orbi' })).toHaveLength(1);
    expect(failedRow.findAll(node => node.type === ('Pressable' as any)).map(node => node.props.accessibilityLabel)).toEqual(['Details for orbi']);
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
    for (const label of ['orbi', 'orbi-unobserved']) {
      expect(rowPage(renderer, label)).toContain('Unknown / transitional');
      expect(rowPage(renderer, label)).not.toContain('Idle');
    }
  });
});

describe('host states and authority', () => {
  it('keeps off undecided, count-free and Refresh-free, with opt-in prose behind a disclosure even offline', async () => {
    const { renderer, press, switchTo } = await render();
    expect(text(renderer)).toContain('Service check off · activity unknown');
    expect(text(renderer)).not.toContain('groups need attention');
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
    expect(rowPage(renderer, 'orbi-demo')).toContain('Example/project');
    expect(client.getQueryData(['paseo-orbi', 'host-a', 'host', 'services.inventory'])).toMatchObject({ lastSuccessfulAt: stamp });
    host.readInventory.mockResolvedValue(inventory({ state: 'off', observedAt: null, sources: [] }));
    await act(async () => { await vi.advanceTimersByTimeAsync(31000); }); await settle();
    expect(text(renderer)).toContain('Service check off · activity unknown');
    expect(text(renderer)).not.toContain('Stale');
    expect(text(renderer)).not.toContain('Last success:');
    expect(detailRows(renderer)).toHaveLength(0);
    expect(servicesText(renderer)).not.toMatch(/orbi-demo|orbi@|Example\/project|Failed|Running/);
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

  it('retains this host rows as stale after a failed refresh, without current counts', async () => {
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press } = await render();
    host.readInventory.mockRejectedValue(new Error('SECRET'));
    await press('Refresh services');
    expect(text(renderer)).toContain('Stale · current activity unknown');
    expect(text(renderer)).toContain(`Last success: ${stamp}`);
    expect(rowPage(renderer, 'orbi')).toContain('Slot 1 · Worker failed');
    expect(renderer.root.findAllByProps({ testID: 'orbi-attention-count' })).toHaveLength(0);
    // Every retained row is marked inside the row itself, so the marker survives
    // the header scrolling offscreen; the retained facts read as last seen, not current.
    for (const group of hostA.groups) {
      expect(rowPage(renderer, group.label)).toContain(`Last seen ${stamp}`);
      expect(row(renderer, group.label).findByProps({ testID: `orbi-last-seen-${group.label}` })).toBeDefined();
    }
    host.readInventory.mockResolvedValue(hostA);
    await press('Refresh services');
    for (const group of hostA.groups) expect(rowPage(renderer, group.label)).not.toContain('Last seen');
    expect(text(renderer)).not.toContain(`Last success: ${stamp}`);
    expect(text(renderer)).toContain('1 of 5 groups needs attention');
  });

  it('marks each retained row Last seen on disconnect and borrows no rows or markers from another host', async () => {
    host.hosts.push({ serverId: 'host-b', label: 'Host B', status: 'online' });
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, switchTo } = await render();
    expect(rowPage(renderer, 'orbi')).not.toContain('Last seen');
    host.hosts[0].status = 'offline';
    await switchTo('host-a');
    expect(text(renderer)).toContain('Offline · current activity unknown');
    expect(renderer.root.findAllByProps({ testID: 'orbi-attention-count' })).toHaveLength(0);
    expect(text(renderer)).not.toMatch(/\d+ of \d+ (?:observed )?groups? needs? attention/);
    for (const group of hostA.groups) expect(rowPage(renderer, group.label)).toContain(`Last seen ${stamp}`);
    expect(row(renderer, 'orbi-demo').findByProps({ testID: 'orbi-last-seen-orbi-demo' })).toBeDefined();
    host.readInventory.mockResolvedValue(hostB);
    await switchTo('host-b');
    expect(text(renderer)).toContain('Services · Host B');
    expect(rowPage(renderer, 'orbi')).toContain('Running');
    expect(rowPage(renderer, 'orbi')).not.toContain('Last seen');
    expect(renderer.root.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('orbi-last-seen-'))).toHaveLength(0);
    expect(text(renderer)).not.toContain('Slot 1 · Worker failed');
  });

  it('qualifies partial attention counts as observed and separates partial absence from complete absence', async () => {
    const groups = [
      family('orbi', 'unmatched', null, [unit('orbi@1.service', 'service', 'failed', 'failed')]),
      family('orbi-b', 'unmatched', null, [unit('orbi-b@1.service', 'service', 'inactive', 'dead')]),
    ];
    host.readInventory.mockResolvedValue(inventory({ state: 'partial', groups, problems: [{ source: 'installed', code: 'process_failed' }] }));
    const { renderer, press } = await render();
    expect(text(renderer)).toContain('1 of 2 observed groups needs attention');
    expect(text(renderer)).toContain('Partial · units may be missing.');
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups }));
    await press('Refresh services');
    expect(text(renderer)).toContain('1 of 2 groups needs attention');
    expect(text(renderer)).not.toContain('observed groups');
    host.readInventory.mockResolvedValue(inventory({ state: 'partial', groups: [], problems: [{ source: 'runtime', code: 'process_failed' }] }));
    await press('Refresh services');
    expect(text(renderer)).toContain('Partial · no units confirmed; units may be missing.');
    expect(text(renderer)).not.toContain('No Orbi units found.');
    expect(renderer.root.findAllByProps({ testID: 'orbi-attention-count' })).toHaveLength(0);
    host.readInventory.mockResolvedValue(inventory({ state: 'complete' }));
    await press('Refresh services');
    expect(text(renderer)).toContain('No Orbi units found.');
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
      await act(async () => { await vi.advanceTimersByTimeAsync(61000); }); await settle();
      expect(servicesText(renderer)).not.toContain('Last success:');
    }
  });

  it('settles a failed first inventory read as unavailable instead of still reading', async () => {
    host.readInventory.mockRejectedValue(new Error('SECRET raw transport error'));
    const { renderer, switchTo } = await render();
    const page = text(renderer);
    // The read already failed, so the screen reports the failure, not progress.
    expect(page).toContain('Services: unavailable');
    expect(page).toContain('Unavailable · current activity unknown.');
    expect(page).toContain('filesystem: refresh_failed');
    expect(page).not.toContain('Reading services…');
    expect(page).not.toContain('Services: loading');
    expect(page).not.toContain('SECRET');
    // A real read failure keeps its retry.
    expect(renderer.root.findByProps({ accessibilityLabel: 'Refresh services' }).props).toMatchObject({ disabled: false });
    // Offline with no snapshot still owns one undecided line and never repeats it.
    host.hosts[0].status = 'offline';
    await switchTo('host-a');
    expect(text(renderer)).toContain('Offline · current activity unknown');
    expect(text(renderer)).not.toContain('Unavailable · current activity unknown.');
    expect(text(renderer)).not.toContain('Reading services…');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Refresh services' }).props).toMatchObject({ disabled: true });
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

  it.each(['unconfigured', 'invalid'] as const)('keeps %s visible with the guide collapsed and grants no repository authority', async state => {
    host.readCatalog.mockResolvedValue({ state, entries: [], problems: [] });
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press } = await render();
    if (state === 'unconfigured') {
      // One notice above the rows; a confirmed unconfigured catalog explains the
      // missing repository detail once instead of repeating the badge on every row.
      expect(text(renderer)).toContain('Repositories aren’t linked. Link repositories to see GitHub issues.');
      expect(rowPage(renderer, 'orbi-demo')).not.toContain('Unlinked');
    } else expect(rowPage(renderer, 'orbi-demo')).toContain('Unlinked');
    if (state === 'unconfigured') expect(text(renderer)).not.toContain('PASEO_ORBI_CONFIG');
    expect(repositoryActions(renderer)).toHaveLength(0);
    await press('Details for orbi-demo');
    // Only a confirmed read may call the deployment absent; an invalid catalog is
    // settled evidence that could not confirm the link.
    expect(text(renderer)).toContain(state === 'unconfigured'
      ? 'not in the current authorized catalog'
      : 'Repository link not confirmed: this host’s repository catalog could not be read.');
    await press('Back to services');
    await press('Setup guide');
    expect(text(renderer)).toContain('PASEO_ORBI_CONFIG');
    for (const read of [host.readFleet, host.readIssues, host.readIssue, host.readRuns, host.readRun, host.readBlockers, host.readBlocker]) expect(read).not.toHaveBeenCalled();
  });

  it('explains a confirmed unconfigured catalog once above the rows and offers inventory-only refresh', async () => {
    const explanation = 'Repositories aren’t linked. Link repositories to see GitHub issues.';
    host.readCatalog.mockResolvedValue({ state: 'unconfigured', entries: [], problems: [] });
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press } = await render();
    const servicesTexts = () => renderer.root.findByProps({ testID: 'orbi-host-services' }).findAllByType('Text' as any).map(node => node.children.join(''));
    // The host identity and service status lead; the one repository notice stays
    // above the first host service row.
    const page = () => text(renderer);
    expect(page().split(explanation)).toHaveLength(2);
    const heading = page().indexOf('Services · Host A');
    const status = page().indexOf('Services: Current');
    const notice = page().indexOf(explanation);
    const firstRow = page().indexOf('orbi');
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(status).toBeGreaterThan(heading);
    expect(notice).toBeGreaterThan(status);
    expect(firstRow).toBeGreaterThan(notice);
    // The one shared repository block lives inside the service panel on this route.
    expect(renderer.root.findByProps({ testID: 'orbi-host-services' }).findByProps({ testID: 'orbi-catalog' })).toBeDefined();
    const instructions = () => renderer.root.findByProps({ accessibilityLabel: 'Setup guide' });
    expect(instructions().props).toMatchObject({ accessibilityRole: 'button', accessibilityState: { expanded: false } });
    expect(instructions().props.style({ pressed: false })).toMatchObject({ minHeight: 44 });
    await press('Setup guide');
    expect(instructions().props.accessibilityState.expanded).toBe(true);
    expect(text(renderer)).toContain('PASEO_ORBI_CONFIG');
    expect(text(renderer)).toContain('explicitly reload');
    expect(text(renderer).split(explanation)).toHaveLength(2);
    for (const group of hostA.groups) expect(rowPage(renderer, group.label)).not.toContain('Unlinked');
    expect(repositoryActions(renderer)).toHaveLength(0);
    // The guide applies no settings: no catalog Refresh and no extra catalog read.
    expect(renderer.root.findAllByProps({ testID: 'orbi-catalog' }).flatMap(node => node.findAllByProps({ accessibilityLabel: 'Refresh' }))).toHaveLength(0);
    const catalogReads = host.readCatalog.mock.calls.length;
    const inventoryReads = host.readInventory.mock.calls.length;
    await press('Refresh services');
    expect(host.readInventory.mock.calls.length).toBe(inventoryReads + 1);
    expect(host.readCatalog.mock.calls.length).toBe(catalogReads);
  });

  it('keeps loading, invalid and offline catalog states distinguishable from unconfigured', async () => {
    const explanation = 'Repositories aren’t linked. Link repositories to see GitHub issues.';
    let finishCatalog!: (value: DeploymentCatalog) => void;
    host.readCatalog.mockImplementationOnce(() => new Promise(resolve => { finishCatalog = resolve; }));
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, switchTo } = await render();
    expect(text(renderer)).toContain('Catalog: loading');
    expect(text(renderer)).not.toContain(explanation);
    expect(text(renderer)).toContain('Loading the selected host catalog.');
    await act(async () => finishCatalog({ state: 'invalid', entries: [], problems: [] })); await settle();
    expect(text(renderer)).toContain('the configured repository catalog is invalid');
    expect(text(renderer)).not.toContain('Catalog: loading');
    expect(text(renderer)).not.toContain(explanation);
    host.hosts[0].status = 'offline';
    await switchTo('host-a');
    expect(text(renderer)).toContain('Offline · current activity unknown');
    expect(text(renderer)).not.toContain(explanation);
  });

  it('keeps a failed catalog read visible with its retry and never as unconfigured', async () => {
    const { renderer } = await render();
    host.readCatalog.mockRejectedValue(new Error('SECRET'));
    await act(async () => { await vi.advanceTimersByTimeAsync(31000); }); await settle();
    expect(text(renderer)).toContain('Catalog: stale');
    expect(text(renderer)).toContain('filesystem: refresh_failed');
    expect(text(renderer)).toContain('Catalog read failed');
    expect(text(renderer)).not.toContain('Repositories aren’t linked.');
    expect(text(renderer)).not.toContain('SECRET');
    const refresh = renderer.root.findByProps({ testID: 'orbi-catalog' }).findByProps({ accessibilityLabel: 'Refresh' });
    expect(refresh.props).toMatchObject({ disabled: false, accessibilityState: { disabled: false, busy: false } });
    host.readCatalog.mockResolvedValue(catalog([demo]));
    await act(async () => refresh.props.onPress()); await settle();
    expect(text(renderer)).not.toContain('Catalog read failed');
    expect(text(renderer)).not.toContain('Catalog: stale');
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Orbi setup' })).toHaveLength(0);
  });

  it('keeps initial catalog failure visible with retry and refuses repository detail', async () => {
    host.readCatalog.mockRejectedValue(new Error('SECRET'));
    host.readInventory.mockResolvedValue(hostA);
    const { renderer } = await render();
    expect(text(renderer)).toContain('Catalog: unavailable');
    expect(text(renderer)).not.toContain('SECRET');
    expect(text(renderer)).not.toContain('Repositories aren’t linked.');
    expect(renderer.root.findByProps({ testID: 'orbi-catalog' }).findAllByProps({ accessibilityLabel: 'Refresh' })).toHaveLength(1);
    expect(repositoryActions(renderer)).toHaveLength(0);
    expect(host.readFleet).not.toHaveBeenCalled();
  });

  it('mounts rich repositories only on expansion from Work, stops collapsed polling and resets on host switch', async () => {
    const { renderer, press, switchTo } = await render({}, 'fleet');
    const disclosure = () => renderer.root.findByProps({ accessibilityLabel: 'Configured repositories' });
    expect(disclosure().props).toMatchObject({ accessibilityRole: 'button', accessibilityState: { expanded: false } });
    expect(disclosure().props.style({ pressed: false })).toMatchObject({ minHeight: 44 });
    expect(host.readFleet).not.toHaveBeenCalled();
    await press('Configured repositories');
    expect(disclosure().props.accessibilityState.expanded).toBe(true);
    expect(host.readFleet.mock.calls.map(([input]) => input.deploymentId)).toEqual(['demo']);
    await press('Configured repositories');
    const calls = host.readFleet.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(61000); }); await settle();
    expect(host.readFleet).toHaveBeenCalledTimes(calls);
    await press('Configured repositories');
    host.hosts.push({ serverId: 'host-b', label: 'Host B', status: 'online' });
    await switchTo('host-b', 'fleet');
    expect(disclosure().props.accessibilityState.expanded).toBe(false);
    await switchTo('host-a', 'fleet');
    expect(disclosure().props.accessibilityState.expanded).toBe(false);
  });

  it('lists unobserved configured deployments, loads only one detail and preserves selected navigation', async () => {
    host.readCatalog.mockResolvedValue(catalog([demo, second]));
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: [family('orbi-second', 'matched', 'second', [unit('orbi-second@1.service', 'service', 'active', 'running')])] }));
    const { renderer, press, openScreen } = await render({ deploymentId: 'demo' }, 'fleet');
    // An explicit deployment deep link opens the configured-repository detail.
    expect(renderer.root.findByProps({ accessibilityLabel: 'Configured repositories' }).props.accessibilityState.expanded).toBe(true);
    expect(text(renderer)).toContain('Not observed in this host service check');
    expect(text(renderer)).toContain('Observed in this host service check');
    expect(host.readFleet.mock.calls.map(([input]) => input.deploymentId)).toEqual(['demo']);
    await press('Show details for Second');
    expect(host.readFleet.mock.calls.map(([input]) => input.deploymentId)).toEqual(['demo', 'second']);
    await press('Open Runs');
    expect(openScreen).toHaveBeenCalledWith({ screenId: 'runs', params: { deploymentId: 'demo' } });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Configured repositories' }).props.accessibilityState.expanded).toBe(true);
    await press('Configured repositories');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Configured repositories' }).props.accessibilityState.expanded).toBe(false);
  });
});

describe('operator-authorized service controls on the diagnostic view', () => {
  const controlled: DeploymentCatalog['entries'][number] = { ...demo, controls: { actions: ['start', 'stop', 'restart'], slots: 2 } };
  const answer = (overrides: Record<string, unknown> = {}) => ({
    operationId: 'ctl-1', deploymentId: 'demo', slot: 1, action: 'start', outcome: 'succeeded', reason: null,
    actor: null, submittedAt: stamp, finishedAt: stamp,
    observed: { loadState: 'loaded', activeState: 'active', subState: 'running' }, ...overrides,
  });
  const openActions = async (press: (label: string) => Promise<void>) => { await press('Details for Example/project'); await press('Actions for orbi-demo'); };

  it('offers actions only for a linked repository the operator granted, bounded to approved slots', async () => {
    host.readCatalog.mockResolvedValue(catalog([controlled]));
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press } = await render();
    // Unlinked, ambiguous and incompatible rows never gain control actions.
    for (const [label, name] of [['orbi', 'orbi'], ['orbi-clash', 'orbi-clash'], ['orbi-core', 'orbi-core'], ['orbi-aux', 'orbi-aux']] as const) {
      await press(`Details for ${name}`);
      expect(renderer.root.findAllByProps({ accessibilityLabel: 'Actions for ' + label })).toHaveLength(0);
      await press('Back to services');
    }
    await press('Details for Example/project');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Actions for orbi-demo' }).props)
      .toMatchObject({ accessibilityRole: 'button', accessibilityState: { expanded: false } });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Actions for orbi-demo' }).props.style({ pressed: false }))
      .toMatchObject({ minHeight: 44 });
    await press('Actions for orbi-demo');
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Start slot 1' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Start slot 2' })).toHaveLength(0);
    expect(text(renderer)).toContain('Slot 1 · Worker idle');
    expect(host.readControl).not.toHaveBeenCalled();
  });

  it('confirms host, repository, exact target and effect without treating confirmation as authorization', async () => {
    host.readCatalog.mockResolvedValue(catalog([controlled]));
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press } = await render();
    await openActions(press);
    await press('Start slot 1');
    expect(host.readControl).not.toHaveBeenCalled();
    const lines = renderer.root.findByProps({ testID: 'orbi-confirm-orbi-demo-1' }).findAllByType('Text' as any).map(node => node.children.join(''));
    expect(lines).toContain('Host: Host A');
    expect(lines).toContain('Repository: Example/project');
    expect(lines).toContain('Target: orbi-demo@1.service');
    expect(lines.some(line => line.startsWith('Effect: start this runner slot'))).toBe(true);
    expect(lines).toContain('Confirmation is not authorization. The daemon rechecks the operator grant before it runs anything.');
    await press('Cancel start slot 1');
    expect(host.readControl).not.toHaveBeenCalled();
    host.readControl.mockResolvedValue(answer());
    await press('Start slot 1');
    await press('Confirm start slot 1');
    expect(host.readControl).toHaveBeenCalledTimes(1);
    expect(host.readControl.mock.calls[0][0]).toEqual({ deploymentId: 'demo', slot: 1, action: 'start' });
    expect(text(renderer)).toContain('Start succeeded · Slot 1 · Running');
  });

  it('sends one action for repeated clicks and reports only the re-observed state', async () => {
    host.readCatalog.mockResolvedValue(catalog([controlled]));
    host.readInventory.mockResolvedValue(hostA);
    let finish!: (value: unknown) => void;
    host.readControl.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { renderer, press } = await render();
    await openActions(press);
    await press('Start slot 1');
    await press('Confirm start slot 1');
    expect(host.readControl).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ accessibilityLabel: 'Confirm start slot 1' }).props)
      .toMatchObject({ disabled: true, accessibilityState: { disabled: true, busy: true } });
    expect(renderer.root.findByProps({ accessibilityLabel: 'Start slot 1' }).props.disabled).toBe(true);
    await press('Confirm start slot 1');
    expect(host.readControl).toHaveBeenCalledTimes(1);
    await act(async () => finish(answer())); await settle();
    expect(text(renderer)).toContain('Start succeeded · Slot 1 · Running');
    expect(host.readControl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['denied active delivery', { outcome: 'denied', reason: 'active_delivery', observed: null, finishedAt: null }, 'Refused: this slot is running or transitional'],
    ['denied unapproved action', { outcome: 'denied', reason: 'action_not_approved', observed: null, finishedAt: null }, 'Not approved: the operator has not granted this action'],
    ['unknown timeout', { outcome: 'unknown', reason: 'process_timeout' }, 'Outcome unknown: the lifecycle command did not finish in time'],
    ['failed command', { outcome: 'failed', reason: 'process_failed', observed: { loadState: 'loaded', activeState: 'failed', subState: 'failed' } }, 'Start failed · Slot 1 · Failed.'],
    ['pending duplicate', { outcome: 'pending', reason: 'busy', observed: null, finishedAt: null }, 'Another action for this repository is still in progress'],
  ])('reports %s without claiming unobserved success', async (_name, overrides, copy) => {
    host.readCatalog.mockResolvedValue(catalog([controlled]));
    host.readInventory.mockResolvedValue(hostA);
    host.readControl.mockResolvedValue(answer(overrides as Record<string, unknown>));
    const { renderer, press } = await render();
    await openActions(press);
    await press('Start slot 1');
    await press('Confirm start slot 1');
    expect(text(renderer)).toContain(copy);
    expect(host.readControl).toHaveBeenCalledTimes(1);
  });

  it('treats a failed transport as unknown and never retries it automatically', async () => {
    host.readCatalog.mockResolvedValue(catalog([controlled]));
    host.readInventory.mockResolvedValue(hostA);
    host.readControl.mockRejectedValue(new Error('SECRET raw transport error'));
    const { renderer, press } = await render();
    await openActions(press);
    await press('Start slot 1');
    await press('Confirm start slot 1');
    const page = text(renderer);
    expect(page).toContain('Start outcome unknown');
    expect(page).toContain('did not complete');
    expect(page).not.toContain('SECRET');
    expect(page).not.toContain('succeeded');
    expect(host.readControl).toHaveBeenCalledTimes(1);
  });

  it('never publishes a pending result or action into another host', async () => {
    host.readCatalog.mockResolvedValue(catalog([controlled]));
    host.readInventory.mockResolvedValue(hostA);
    let finish!: (value: unknown) => void;
    host.readControl.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { renderer, press, switchTo } = await render();
    await openActions(press);
    await press('Start slot 1');
    await press('Confirm start slot 1');
    host.hosts.push({ serverId: 'host-b', label: 'Host B', status: 'online' });
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: [family('orbi-demo', 'matched', 'demo', [unit('orbi-demo@1.service', 'service', 'inactive', 'dead')])] }));
    await switchTo('host-b');
    await act(async () => finish(answer())); await settle();
    expect(text(renderer)).not.toContain('Start succeeded');
    expect(rowPage(renderer, 'orbi-demo')).toContain('Example/project');
    host.readInventory.mockResolvedValue(hostA);
    await switchTo('host-a');
    expect(text(renderer)).not.toContain('Start succeeded');
  });

  it('keeps a repository read-only when the operator granted no actions', async () => {
    host.readCatalog.mockResolvedValue(catalog([demo]));
    host.readInventory.mockResolvedValue(hostA);
    const { renderer, press } = await render();
    await press('Details for Example/project');
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Actions for orbi-demo' })).toHaveLength(0);
    expect(host.readControl).not.toHaveBeenCalled();
  });

  it('styles granted actions as buttons and keeps a busy confirm from submitting twice', async () => {
    host.readCatalog.mockResolvedValue(catalog([controlled]));
    host.readInventory.mockResolvedValue(hostA);
    let finish!: (value: unknown) => void;
    host.readControl.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { renderer, press } = await render();
    const colors = props().theme.colors;
    await openActions(press);
    const control = (name: string) => renderer.root.findByProps({ accessibilityLabel: name });
    const controlStyle = (name: string) => control(name).props.style({ pressed: false });
    expect(control('Start slot 1').findAllByType('Text' as any).map(node => node.children.join(''))).toEqual(['Start']);
    expect(controlStyle('Start slot 1')).toMatchObject({ backgroundColor: colors.accent, borderColor: colors.accent });
    expect(control('Start slot 1').findByType('Text' as any).props.style.color).toBe(colors.accentForeground);
    expect(controlStyle('Stop slot 1')).toMatchObject({ backgroundColor: colors.surface1, borderColor: colors.statusDanger });
    expect(control('Stop slot 1').findByType('Text' as any).props.style.color).toBe(colors.statusDanger);
    expect(controlStyle('Restart slot 1')).toMatchObject({ backgroundColor: colors.surface1, borderColor: colors.border });
    expect(control('Restart slot 1').findByType('Text' as any).props.style.color).toBe(colors.foreground);
    const danger = renderer.root.findAll(node => node.type === ('Pressable' as any))
      .filter(node => typeof node.props.style === 'function' && node.props.style({ pressed: false }).borderColor === colors.statusDanger);
    expect(danger.map(node => node.props.accessibilityLabel)).toEqual(['Stop slot 1']);
    await press('Start slot 1');
    expect(controlStyle('Confirm start slot 1')).toMatchObject({ backgroundColor: colors.accent, borderColor: colors.accent });
    expect(controlStyle('Cancel start slot 1')).toMatchObject({ backgroundColor: colors.surface1, borderColor: colors.border });
    await act(async () => { control('Confirm start slot 1').props.onPress(); await vi.advanceTimersByTimeAsync(2); });
    expect(host.readControl).toHaveBeenCalledTimes(1);
    const busy = control('Confirm start slot 1');
    expect(busy.props.disabled).toBe(true);
    expect(busy.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(busy.findByType('Text' as any).children.join('')).toBe('Submitting…');
    expect(busy.props.style({ pressed: false }).opacity).toBeLessThan(0.7);
    await act(async () => { busy.props.onPress(); await vi.advanceTimersByTimeAsync(2); });
    expect(host.readControl).toHaveBeenCalledTimes(1);
    expect(control('Cancel start slot 1').props.disabled).toBe(true);
    await act(async () => { finish(answer()); }); await settle();
    expect(text(renderer)).toContain('Start succeeded · Slot 1 · Running');
    await press('Stop slot 1');
    expect(controlStyle('Confirm stop slot 1')).toMatchObject({ borderColor: colors.statusDanger, backgroundColor: colors.surface1 });
    await press('Cancel stop slot 1');
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Confirm stop slot 1' })).toHaveLength(0);
    expect(host.readControl).toHaveBeenCalledTimes(1);
  });
});
