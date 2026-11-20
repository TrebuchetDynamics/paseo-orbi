import './helpers/host';
import { host } from './helpers/host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PluginClientContext, PluginScreenProps } from '@getpaseo/plugin/client';
import { Shell } from '../client/shell';
import { resetHostOverviewState } from '../client/host-overview';
import type { DeploymentCatalog } from '../shared/common';
import { servicesInventory, type InventoryGroup, type InventoryUnit, type ServiceInventory } from '../shared/services';

// Host-first Overview evidence. Every inventory value below is parsed by the
// real services.inventory contract, so a display guess cannot pass as a
// transported fact. Both hosts reuse the same family label and slot numbers.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const stamp = '2026-11-19T18:00:00.000Z';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  host.hosts.splice(1);
  host.hosts[0] = { serverId: 'host-a', label: 'Host A', status: 'online' };
  vi.useRealTimers();
});

const unit = (id: string, kind: InventoryUnit['kind'], activeState: string | null, subState: string | null, unitFileState: string | null = 'enabled'): InventoryUnit =>
  ({ id, kind, runtime: activeState === null ? null : { loadState: 'loaded', activeState, subState }, unitFileState } as InventoryUnit);
const family = (label: string, kind: InventoryGroup['kind'], association: InventoryGroup['association'], deploymentId: string | null, units: InventoryUnit[]): InventoryGroup =>
  ({ label, kind, association, deploymentId, units } as InventoryGroup);
const inventory = (value: Pick<ServiceInventory, 'state'> & Partial<ServiceInventory>): ServiceInventory => servicesInventory.output.parse({
  observedAt: stamp,
  sources: [
    { source: 'runtime', state: 'complete', observedAt: stamp, problems: [] },
    { source: 'installed', state: 'complete', observedAt: stamp, problems: [] },
  ],
  problems: [], groups: [], ...value,
});

// Host A: one family with several simultaneous facts, scheduled-only, installed-only,
// template-only installed names, an unsupported profile and a duplicate claim.
const hostA = inventory({ state: 'complete', groups: [
  family('orbi', 'runner-family', 'unmatched', null, [
    unit('orbi@1.service', 'service', 'failed', 'failed'),
    unit('orbi@1.timer', 'timer', 'active', 'waiting'),
    unit('orbi@2.service', 'service', 'active', 'running'),
    unit('orbi@2.timer', 'timer', 'active', 'waiting'),
  ]),
  family('orbi-aux', 'auxiliary', 'unmatched', null, [unit('orbi-aux@.service', 'service', null, null)]),
  family('orbi-demo', 'runner-family', 'matched', 'demo', [
    unit('orbi-demo@1.service', 'service', 'inactive', 'dead', 'disabled'),
    unit('orbi-demo@1.timer', 'timer', 'active', 'waiting', 'disabled'),
  ]),
  family('orbi-core', 'runner-family', 'incompatible', null, [unit('orbi-core@1.service', 'service', 'activating', 'start')]),
  family('orbi-clash', 'runner-family', 'ambiguous', null, [unit('orbi-clash@1.service', 'service', 'active', 'exited')]),
] });
// Host B repeats the same family label and slot with different states.
const hostB = inventory({ state: 'complete', groups: [
  family('orbi', 'runner-family', 'unmatched', null, [
    unit('orbi@1.service', 'service', 'active', 'running'),
    unit('orbi@1.timer', 'timer', 'active', 'waiting'),
  ]),
] });

const catalog = (entries: DeploymentCatalog['entries']): DeploymentCatalog => ({ state: 'configured', problems: [], entries });
const demo: DeploymentCatalog['entries'][number] = { id: 'demo', label: 'Demo', repo: 'Example/project', adapter: 'orbi-0.7.41-release', status: 'available', problems: [] };
const second: DeploymentCatalog['entries'][number] = { id: 'second', label: 'Second', repo: 'Other/repository', adapter: 'orbi-0.7.41-release', status: 'available', problems: [] };
const rejected: DeploymentCatalog['entries'][number] = { id: 'core', label: 'Core', repo: 'Other/core', adapter: 'orbi-0.7.41-release', status: 'unsupported_source_profile', problems: [{ source: 'compatibility', code: 'unsupported_source_profile' }] };

type ScreenProps = PluginScreenProps & { openScreen?: PluginClientContext['openScreen'] };
const props = (overrides: Partial<ScreenProps> = {}): ScreenProps => ({
  theme: { colors: { foreground: '#eee', foregroundMuted: '#aaa', surface0: '#111' } },
  host: { id: 'host-a', label: 'Host A' }, layout: { compact: true, platform: 'ios' }, params: {}, ...overrides,
} as ScreenProps);

beforeEach(() => {
  resetHostOverviewState();
  host.readCatalog.mockReset().mockResolvedValue(catalog([demo, rejected]));
  host.readInventory.mockReset().mockResolvedValue(inventory({ state: 'off' }));
  host.readFleet.mockReset().mockResolvedValue({ state: 'available', observedAt: stamp, lastSuccessfulAt: stamp, problems: [] });
  for (const read of [host.readIssues, host.readIssue, host.readRuns, host.readRun, host.readBlockers, host.readBlocker]) read.mockClear();
});

const settle = async () => { for (let index = 0; index < 3; index++) await act(async () => { await vi.advanceTimersByTimeAsync(2); }); };
async function render(screenProps: ScreenProps, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  cleanups.push(() => client.clear());
  let renderer!: ReactTestRenderer;
  vi.useFakeTimers(); vi.setSystemTime(new Date(stamp));
  await act(async () => { renderer = create(<QueryClientProvider client={client}><Shell {...screenProps} route="fleet" openScreen={screenProps.openScreen ?? vi.fn()} /></QueryClientProvider>); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); });
  await settle();
  return renderer;
}
const texts = (renderer: ReactTestRenderer) => renderer.root.findAllByType('Text' as any).map(node => node.children.join(''));
const text = (renderer: ReactTestRenderer) => texts(renderer).join('\n');
const row = (renderer: ReactTestRenderer, label: string) => renderer.root.findByProps({ testID: `orbi-family-${label}` });
const rowText = (renderer: ReactTestRenderer, label: string) => row(renderer, label).findAllByType('Text' as any).map(node => node.children.join(''));
const rowPage = (renderer: ReactTestRenderer, label: string) => rowText(renderer, label).join('\n');
const repositoryActions = (renderer: ReactTestRenderer) => renderer.root.findAll(node => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith('View repository'));

describe('host_first_overview', () => {
  it('leads with this host, its observed families and their text facts before any configured repository', async () => {
    host.readCatalog.mockResolvedValue(catalog([demo, rejected]));
    host.readInventory.mockResolvedValue(hostA);
    const openScreen = vi.fn();
    const renderer = await render(props({ openScreen }));
    const page = text(renderer);

    expect(page).toContain('Your Linux user services — Host A');
    expect(page).toContain('Host service check: complete');
    expect(page).toContain(`Last check: ${stamp}`);
    expect(page).toContain('Observed unit activity is not an active delivery.');
    // Host services sit above the configured-repository section.
    expect(page.indexOf('Your Linux user services')).toBeLessThan(page.indexOf('Demo (Example/project)'));

    // Failed first, then running, then scheduled, then other/not loaded with label ties.
    const order = ['orbi', 'orbi-demo', 'orbi-aux', 'orbi-clash', 'orbi-core'];
    const at = order.map(label => texts(renderer).findIndex(value => value === label));
    expect(at.every(index => index >= 0)).toBe(true);
    expect(new Set(at).size).toBe(order.length);
    expect(at).toEqual([...at].sort((left, right) => left - right));

    // Text badges, not colour alone: several simultaneous facts stay visible.
    expect(rowPage(renderer, 'orbi')).toContain('Failed');
    expect(rowPage(renderer, 'orbi')).toContain('Running · Issue unknown');
    expect(rowPage(renderer, 'orbi-demo')).toContain('Scheduled · no runner observed running');
    expect(rowPage(renderer, 'orbi-aux')).toContain('Installed');
    // active/exited and activating/start are observed but never counted as running.
    expect(rowPage(renderer, 'orbi-clash')).toContain('Not running · Issue unknown');
    expect(rowPage(renderer, 'orbi-core')).toContain('Not running · Issue unknown');
    expect(rowPage(renderer, 'orbi')).not.toContain('Scheduled');

    // Association copy: unit-name association is display-only; discovery is not authority.
    expect(rowPage(renderer, 'orbi-demo')).toContain('Unit origin is not verified');
    expect(rowPage(renderer, 'orbi')).toContain('no configured deployment claims this unit name');
    expect(rowPage(renderer, 'orbi-core')).toContain('does not mean the runner is broken');
    expect(rowPage(renderer, 'orbi-clash')).toContain('makes the association unique');

    // One rich Fleet detail load for the default selected deployment, never every repository.
    expect(host.readFleet.mock.calls.map(([input]) => input.deploymentId)).toEqual(['demo']);
    for (const read of [host.readIssues, host.readIssue, host.readRuns, host.readRun, host.readBlockers, host.readBlocker]) expect(read).not.toHaveBeenCalled();

    // Only the current unique authorized mapping offers the repository action.
    const actions = repositoryActions(renderer);
    expect(actions.map(node => node.props.accessibilityLabel)).toEqual(['View repository Demo']);
    expect(actions[0].props.accessibilityRole).toBe('button');
    await act(async () => actions[0].props.onPress());
    expect(openScreen).toHaveBeenCalledWith({ screenId: 'issues', params: { deploymentId: 'demo' } });
  });

  it('expands one family in place to per-slot service and timer state with an expanded state', async () => {
    host.readInventory.mockResolvedValue(hostA);
    const renderer = await render(props());
    expect(rowPage(renderer, 'orbi')).not.toContain('orbi@1.service');
    const expand = renderer.root.findByProps({ accessibilityLabel: 'Expand orbi' });
    expect(expand.props.accessibilityRole).toBe('button');
    expect(expand.props.accessibilityState).toEqual({ expanded: false });
    await act(async () => expand.props.onPress()); await settle();
    const slots = rowPage(renderer, 'orbi');
    expect(slots).toContain('orbi@1.service: failed/failed, load loaded; unit file enabled');
    expect(slots).toContain('orbi@1.timer: active/waiting, load loaded; unit file enabled');
    expect(slots).toContain('orbi@2.service: active/running, load loaded; unit file enabled');
    const collapse = renderer.root.findByProps({ accessibilityLabel: 'Collapse orbi' });
    expect(collapse.props.accessibilityState).toEqual({ expanded: true });
    // One family is expanded in place at a time.
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Expand orbi-aux' }).props.onPress()); await settle();
    expect(rowPage(renderer, 'orbi')).not.toContain('orbi@1.service');
    // A template declaration is an installed name, not a running service.
    expect(rowPage(renderer, 'orbi-aux')).toContain('Installed');
    expect(rowPage(renderer, 'orbi-aux')).toContain('orbi-aux@.service: runtime not observed; unit file enabled (template, not a running service)');
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Collapse orbi-aux' }).props.onPress()); await settle();
    expect(rowPage(renderer, 'orbi-aux')).not.toContain('orbi-aux@.service');
  });

  it('separates a waiting timer from an inactive runner and keeps a running runner visible beside a failed timer', async () => {
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: [
      family('orbi-waiting', 'runner-family', 'matched', 'demo', [
        unit('orbi-waiting@1.service', 'service', 'inactive', 'dead', 'disabled'),
        unit('orbi-waiting@1.timer', 'timer', 'active', 'waiting'),
      ]),
      family('orbi-mixed', 'runner-family', 'unmatched', null, [
        unit('orbi-mixed@1.service', 'service', 'active', 'running'),
        unit('orbi-mixed@1.timer', 'timer', 'failed', 'failed'),
      ]),
    ] }));
    const renderer = await render(props());
    expect(rowPage(renderer, 'orbi-waiting')).toContain('Scheduled · no runner observed running');
    expect(rowPage(renderer, 'orbi-waiting')).not.toContain('Running · Issue unknown');
    expect(rowPage(renderer, 'orbi-mixed')).toContain('Failed');
    expect(rowPage(renderer, 'orbi-mixed')).toContain('Running · Issue unknown');
    // A row never invents an issue number or a timer trigger from the schedule.
    for (const label of ['orbi-waiting', 'orbi-mixed']) expect(rowPage(renderer, label)).not.toMatch(/Last trigger|Next trigger|issue \d/i);
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Expand orbi-mixed' }).props.onPress()); await settle();
    expect(rowPage(renderer, 'orbi-mixed')).toContain('orbi-mixed@1.service: active/running, load loaded; unit file enabled');
    expect(rowPage(renderer, 'orbi-mixed')).toContain('orbi-mixed@1.timer: failed/failed, load loaded; unit file enabled');
  });

  it('retains the host-scoped expanded family across an in-page remount and falls back to the Overview heading', async () => {
    host.readInventory.mockResolvedValue(hostA);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    cleanups.push(() => client.clear());
    vi.useFakeTimers(); vi.setSystemTime(new Date(stamp));
    const tree = () => <QueryClientProvider client={client}><Shell {...props()} route="fleet" openScreen={vi.fn()} /></QueryClientProvider>;
    let renderer!: ReactTestRenderer;
    const mount = async () => { await act(async () => { renderer = create(tree()); }); await settle(); return renderer; };
    await mount();
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Expand orbi' }).props.onPress()); await settle();
    await act(async () => renderer.unmount());
    // Same host/repository after in-page navigation: the family is still expanded.
    const returned = await mount();
    expect(returned.root.findByProps({ accessibilityLabel: 'Collapse orbi' })).toBeDefined();
    await act(async () => renderer.unmount());
    // Same surface but the retained family is gone: the Overview heading is the fallback target.
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: [
      family('orbi-demo', 'runner-family', 'matched', 'demo', [unit('orbi-demo@1.service', 'service', 'active', 'running')]),
    ] }));
    const fresh = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    cleanups.push(() => fresh.clear());
    const fallbackTree = () => <QueryClientProvider client={fresh}><Shell {...props()} route="fleet" openScreen={vi.fn()} /></QueryClientProvider>;
    await act(async () => { renderer = create(fallbackTree()); }); await settle();
    const fallback = renderer;
    expect(fallback.root.findByProps({ accessibilityLabel: 'Expand orbi-demo' })).toBeDefined();
    expect(fallback.root.findAllByProps({ accessibilityLabel: 'Collapse orbi' })).toHaveLength(0);
    expect(fallback.root.findByProps({ testID: 'orbi-overview-heading' }).props.accessibilityRole).toBe('header');
    await act(async () => renderer.unmount());
  });

  it('keeps a pending host-A observation out of host B with the same label and slot, and resets host UI state', async () => {
    let finishA!: (value: ServiceInventory) => void;
    host.readInventory.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve as (value: ServiceInventory) => void; }));
    host.readInventory.mockResolvedValue(hostB);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    cleanups.push(() => client.clear());
    let renderer!: ReactTestRenderer;
    vi.useFakeTimers(); vi.setSystemTime(new Date(stamp));
    const tree = (screenProps: ScreenProps) => <QueryClientProvider client={client}><Shell {...screenProps} route="fleet" openScreen={vi.fn()} /></QueryClientProvider>;
    await act(async () => { renderer = create(tree(props())); });
    cleanups.push(async () => { await act(async () => renderer.unmount()); });
    await settle();
    expect(text(renderer)).toContain("Reading the selected host's user services.");

    host.hosts.push({ serverId: 'host-b', label: 'Host B', status: 'online' });
    await act(async () => renderer.update(tree(props({ host: { id: 'host-b', label: 'Host B' } })))); await settle();
    expect(text(renderer)).toContain('Your Linux user services — Host B');
    expect(rowPage(renderer, 'orbi')).toContain('Running · Issue unknown');
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Expand orbi' }).props.onPress()); await settle();
    expect(rowPage(renderer, 'orbi')).toContain('orbi@1.service: active/running, load loaded; unit file enabled');

    // The cancelled host-A generation may never publish into host B or its cache key.
    await act(async () => { finishA(hostA); }); await settle();
    expect(text(renderer)).toContain('Your Linux user services — Host B');
    expect(text(renderer)).not.toContain('Failed');
    expect(client.getQueryData(['paseo-orbi', 'host-a', 'host', 'services.inventory'])).toBeUndefined();

    // A host switch discards the previous host's expansion state.
    host.readInventory.mockResolvedValue(hostA);
    await act(async () => renderer.update(tree(props()))); await settle();
    expect(text(renderer)).toContain('Your Linux user services — Host A');
    expect(renderer.root.findByProps({ accessibilityLabel: 'Expand orbi' })).toBeDefined();
  });
});

describe('host_services_states', () => {
  const renderWith = async (value: ServiceInventory, overrides: Partial<ScreenProps> = {}) => {
    host.readInventory.mockResolvedValue(value);
    return render(props(overrides));
  };

  it('shows the selected host, an undecided state and one reachable setup disclosure when inventory is off', async () => {
    const renderer = await renderWith(inventory({ state: 'off', observedAt: null }));
    const page = text(renderer);
    expect(page).toContain('Your Linux user services — Host A');
    expect(page).toContain('Host service check: off');
    expect(page).toContain('undecided');
    // Off is not an observation: no zero count, failure count or never timestamp.
    expect(page).not.toContain('Observed unit families');
    expect(page).not.toContain('families with failed units');
    expect(page).not.toContain('Last check');
    expect(page).not.toContain('last successful check');
    expect(page).not.toContain('never');
    // No deployment claims "not observed" and no Refresh implies it can enable access.
    expect(page).not.toContain('Not observed in this host service check');
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Refresh host services' })).toHaveLength(0);
    // One reachable disclosure carries the existing operator instructions and audience.
    const disclosure = renderer.root.findByProps({ accessibilityLabel: 'Set up service access' });
    expect(disclosure.props.accessibilityRole).toBe('button');
    expect(disclosure.props.accessibilityState).toEqual({ expanded: false });
    expect(page).not.toContain('PASEO_ORBI_HOST_INVENTORY=1');
    await act(async () => disclosure.props.onPress()); await settle();
    expect(renderer.root.findByProps({ accessibilityLabel: 'Set up service access' }).props.accessibilityState).toEqual({ expanded: true });
    const setup = text(renderer);
    expect(setup).toContain('PASEO_ORBI_HOST_INVENTORY=1');
    expect(setup).toContain('explicitly authorize a reload');
    expect(setup).toContain('Connected clients on this host can then see Orbi unit names');
    expect(setup).toContain('Refresh cannot enable access');
    expect(setup).not.toContain('Observed unit families');
    expect(host.readInventory).toHaveBeenCalledTimes(1);
  });

  it('reports no matching units only for a fresh complete empty observation', async () => {
    const complete = await renderWith(inventory({ state: 'complete' }));
    expect(text(complete)).toContain("No matching Orbi user units found in the selected host's user services");
    await act(async () => { await vi.advanceTimersByTimeAsync(61000); }); await settle();
    expect(text(complete)).toContain("Showing this host's last successful observation");
    expect(text(complete)).not.toContain('No matching Orbi user units found');
    expect(text(complete)).not.toContain('Observed unit families');
  });

  it('reports partial results as possibly missing units with a repair step', async () => {
    const partial = await renderWith(inventory({ state: 'partial', sources: [
      { source: 'runtime', state: 'complete', observedAt: stamp, problems: [] },
      { source: 'installed', state: 'unavailable', observedAt: stamp, problems: [{ source: 'installed', code: 'process_failed' }] },
    ], problems: [{ source: 'installed', code: 'process_failed' }] }));
    expect(text(partial)).toContain('Other units may be missing');
    expect(text(partial)).toContain('do not treat this as empty');
    expect(text(partial)).toContain('installed: process_failed');
    expect(text(partial)).toContain('Ask the operator to check user systemd/DBus access on this host, then Refresh.');
    expect(text(partial)).not.toContain('No matching Orbi user units found');
    expect(text(partial)).not.toContain('Observed unit families');
    // Partial host evidence is still evidence: it may be retained as a success.
    expect(text(partial)).toContain('last successful check: ' + stamp);
  });

  it('reports denied or unavailable reads as unknown activity with a safe alert', async () => {
    const unavailable = await renderWith(inventory({ state: 'unavailable', sources: [], problems: [{ source: 'runtime', code: 'process_failed' }, { source: 'installed', code: 'process_failed' }] }));
    expect(text(unavailable)).toContain('Current activity on this host is unknown');
    expect(text(unavailable)).toContain('runtime: process_failed; installed: process_failed');
    expect(unavailable.root.findByProps({ testID: 'orbi-host-services' }).findByProps({ accessibilityRole: 'alert' }).props.children).toBe('runtime: process_failed; installed: process_failed');
    // A denied check is never retained as this host's success, at any age.
    expect(text(unavailable)).toContain('last successful check: never');
    expect(text(unavailable)).not.toContain('last successful observation');
    // ...and it never becomes per-deployment "not observed" evidence or a zero count.
    expect(text(unavailable)).not.toContain('Not observed in this host service check');
    expect(text(unavailable)).not.toContain('Observed in this host service check');
    expect(text(unavailable)).not.toContain('Observed unit families');
    await act(async () => { await vi.advanceTimersByTimeAsync(61000); }); await settle();
    expect(text(unavailable)).toContain('Current activity on this host is unknown');
    expect(text(unavailable)).not.toContain("Showing this host's last successful observation");
    expect(text(unavailable)).toContain('last successful check: never');
  });

  it('shows only this host last successful observation, distinctly labelled, after a failed refresh', async () => {
    host.readInventory.mockReset().mockResolvedValueOnce(hostA);
    const renderer = await render(props());
    expect(text(renderer)).toContain(`Last check: ${stamp}`);
    host.readInventory.mockRejectedValue(new Error('SECRET raw transport error'));
    await act(async () => { await renderer.root.findByProps({ accessibilityLabel: 'Refresh host services' }).props.onPress(); }); await settle();
    expect(text(renderer)).toContain(`Showing this host's last successful observation from ${stamp}; current activity is unknown.`);
    expect(text(renderer)).toContain('filesystem: refresh_failed');
    expect(rowPage(renderer, 'orbi')).toContain('Running · Issue unknown');
    expect(text(renderer)).not.toContain('SECRET');
  });

  it('disables Refresh and reads nothing while the selected host is offline', async () => {
    host.hosts[0] = { serverId: 'host-a', label: 'Host A', status: 'offline' };
    const renderer = await renderWith(hostA);
    expect(text(renderer)).toContain('Selected host is offline');
    expect(text(renderer)).toContain('current activity is unknown');
    const refresh = renderer.root.findByProps({ accessibilityLabel: 'Refresh host services' });
    expect(refresh.props).toMatchObject({ disabled: true, accessibilityState: { disabled: true, busy: false } });
    await act(async () => refresh.props.onPress()); await settle();
    expect(host.readInventory).not.toHaveBeenCalled();
  });
});

describe('host_overview_and_repository_authority', () => {
  it.each([
    ['unconfigured', { state: 'unconfigured', entries: [], problems: [] } as DeploymentCatalog],
    ['invalid', { state: 'invalid', entries: [], problems: [{ source: 'config', code: 'invalid_config' }] } as DeploymentCatalog],
  ])('keeps opted-in host inventory with a %s catalog and grants no repository detail', async (_state, catalogValue) => {
    host.readCatalog.mockResolvedValue(catalogValue);
    host.readInventory.mockResolvedValue(hostA);
    const renderer = await render(props());
    expect(text(renderer)).toContain('Your Linux user services — Host A');
    expect(rowPage(renderer, 'orbi-demo')).toContain('Scheduled · no runner observed running');
    // Missing/invalid authorization still blocks every privileged read and action.
    expect(rowPage(renderer, 'orbi-demo')).toContain('not in the current authorized catalog');
    expect(repositoryActions(renderer)).toHaveLength(0);
    for (const read of [host.readFleet, host.readIssues, host.readIssue, host.readRuns, host.readRun, host.readBlockers, host.readBlocker]) expect(read).not.toHaveBeenCalled();
  });

  it('lists configured deployments that were not observed and loads detail only for the selected or expanded one', async () => {
    host.readCatalog.mockResolvedValue(catalog([demo, second]));
    host.readInventory.mockResolvedValue(inventory({ state: 'complete', groups: [
      family('orbi-second', 'runner-family', 'matched', 'second', [unit('orbi-second@1.service', 'service', 'active', 'running')]),
    ] }));
    const openScreen = vi.fn();
    const renderer = await render(props({ openScreen, params: { deploymentId: 'demo' } }));
    expect(text(renderer)).toContain('Demo (Example/project)');
    expect(text(renderer)).toContain('Second (Other/repository)');
    expect(text(renderer)).toContain('Not observed in this host service check');
    expect(text(renderer)).toContain('Observed in this host service check');
    expect(host.readFleet.mock.calls.map(([input]) => input.deploymentId)).toEqual(['demo']);
    expect(renderer.root.findByProps({ accessibilityLabel: 'Hide details for Demo' })).toBeDefined();
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Show details for Second' }).props.onPress()); await settle();
    expect(host.readFleet.mock.calls.map(([input]) => input.deploymentId)).toEqual(['demo', 'second']);
    // Selected deployment parameters survive Overview -> Runs on the same host/repo.
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Open Runs' }).props.onPress());
    expect(openScreen).toHaveBeenCalledWith({ screenId: 'runs', params: { deploymentId: 'demo' } });
  });
});
