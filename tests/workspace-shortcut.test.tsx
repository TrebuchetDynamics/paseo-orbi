import './helpers/host';
import { host } from './helpers/host';
import { afterEach, expect, it, vi } from 'vitest';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ConfigRepository } from '../server/config';
import { ReadPorts } from '../server/read-ports';
import { workspaceShortcutStatus, type ShortcutState } from '../shared/workspace-shortcut';
import contribute from '../index.server';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { fixture } from './helpers/fixtures';
import { WorkspaceShortcut } from '../client/workspace-shortcut';

// Pass-through host filesystem spies record the real calls the adapter makes.
vi.mock('node:fs/promises', { spy: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const stamp = '2026-11-21T06:00:00.000Z';
const cleanups: (() => unknown)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Paths = { root: string; parent: string; leaf: string; repoDir: string };
// Real temporary deployment plus a dedicated alias parent. No live workspace is touched.
async function owned(prepare?: (paths: Paths) => Promise<void>) {
  const f = await fixture(); cleanups.push(f.cleanup);
  const parent = join(f.root, 'aliases'), leaf = join(parent, 'checkout');
  await mkdir(parent);
  await prepare?.({ root: f.root, parent, leaf, repoDir: f.repoDir });
  return { f, parent, leaf, descriptor: { directory: parent, name: 'checkout' } };
}
async function portsFor(base: Awaited<ReturnType<typeof owned>>, descriptor: unknown | 'default' = 'default') {
  const value = descriptor === 'default' ? base.descriptor : descriptor;
  await base.f.save([value === null ? base.f.entry : { ...base.f.entry, workspaceShortcut: value }]);
  const repository = await ConfigRepository.load(base.f.authorization);
  const ports = new ReadPorts(repository); cleanups.push(() => ports.dispose());
  return { repository, ports };
}
// The configured shortcut of a deployment that otherwise uses the real fixture.
async function configured(prepare?: (paths: Paths) => Promise<void>) {
  const base = await owned(prepare);
  const { repository, ports } = await portsFor(base);
  return { ...base, repository, ports, state: async () => workspaceShortcutStatus.output.parse(await ports.shortcut('demo')) };
}
type Raw = {
  lstat: (path: string, options?: unknown) => Promise<unknown>;
  stat: (path: string, options?: unknown) => Promise<unknown>;
  open: (path: string, flags?: unknown) => Promise<import('node:fs/promises').FileHandle>;
  readlink: (path: string) => Promise<string>;
};
async function raw(): Promise<Raw> {
  const module = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    lstat: module.lstat as unknown as Raw['lstat'], stat: module.stat as unknown as Raw['stat'],
    open: module.open as unknown as Raw['open'], readlink: module.readlink as unknown as Raw['readlink'],
  };
}
async function snapshot(root: string): Promise<unknown[]> {
  const calls = await raw();
  return Promise.all((await readdir(root)).sort().map(async name => {
    const path = join(root, name), info = await calls.lstat(path) as import('node:fs').Stats;
    // A fixture symlink is recorded as its link text, never followed to its target.
    return [name, info.mode, info.size, info.mtimeMs, info.ino,
      info.isSymbolicLink() ? ['link', await calls.readlink(path)]
        : info.isDirectory() ? await snapshot(path) : createHash('sha256').update(await readFile(path)).digest('hex')];
  }));
}

it('distinguishes a symlink (including a dangling one), a non-link and an absent leaf', async () => {
  const { f, leaf, state } = await configured();
  await symlink(f.repoDir, leaf);
  expect(await state()).toMatchObject({ deploymentId: 'demo', state: 'symlink', problem: null });
  // A dangling link is still a symlink; the target is never read to find out.
  await rm(leaf, { force: true });
  const readlink = vi.spyOn(filesystem, 'readlink');
  const opened = vi.spyOn(filesystem, 'open');
  await symlink('/SECRET_TARGET_CANARY', leaf);
  expect(await state()).toMatchObject({ state: 'symlink', problem: null });
  expect(readlink).not.toHaveBeenCalled();
  expect(opened.mock.calls.map(([path]) => String(path)).some(path => path.includes('checkout'))).toBe(false);
  await rm(leaf, { force: true });
  await writeFile(leaf, 'TARGET_SECRET_CANARY');
  expect((await state()).state).toBe('not_symlink');
  await rm(leaf, { force: true });
  const absent = await state();
  expect(absent).toMatchObject({ state: 'absent', problem: null });
  expect(Number.isNaN(Date.parse(absent.observedAt))).toBe(false);
  // Neither the observed time nor any state carries a path, a name or a target.
  expect(JSON.stringify(absent)).not.toMatch(/SECRET|aliases|checkout|\/proc\//);
});

it('reports Cannot inspect for an unsafe parent instead of absence', async () => {
  const base = await owned(async ({ root, parent }) => {
    const foreign = join(root, 'foreign'); await mkdir(foreign);
    await writeFile(join(foreign, 'checkout'), 'FOREIGN_TARGET_CANARY');
    await symlink(foreign, join(parent, 'aliased'));
  });
  const inspect = async (directory: string) => {
    await base.f.save([{ ...base.f.entry, workspaceShortcut: { directory, name: 'checkout' } }]);
    const repository = await ConfigRepository.load(base.f.authorization);
    const ports = new ReadPorts(repository);
    try { return workspaceShortcutStatus.output.parse(await ports.shortcut('demo')); } finally { await ports.dispose(); }
  };
  // A configured parent that became a symlink is refused, never followed to a foreign leaf.
  expect(await inspect(join(base.parent, 'aliased'))).toMatchObject({ state: 'cannot_inspect', problem: { source: 'filesystem', code: 'unsafe_path' } });
  // A missing parent is indeterminate, not absence of the named leaf.
  expect(await inspect(join(base.f.root, 'missing'))).toMatchObject({ state: 'cannot_inspect', problem: { code: 'not_found' } });
  // A non-directory parent cannot anchor the lookup (ENOTDIR).
  await writeFile(join(base.f.root, 'file'), 'not a directory');
  expect(await inspect(join(base.f.root, 'file'))).toMatchObject({ state: 'cannot_inspect', problem: { code: 'unsafe_path' } });
  // Denied access is indeterminate; an execute-only or denied parent is never weakened.
  if (process.getuid?.() !== 0) {
    const denied = join(base.f.root, 'denied'); await mkdir(denied); await chmod(denied, 0o000);
    cleanups.push(() => chmod(denied, 0o755));
    expect(await inspect(denied)).toMatchObject({ state: 'cannot_inspect', problem: { code: 'read_failed' } });
  }
});

it('requires genuine procfs routing and never falls back to a pathname lookup', async () => {
  const { state } = await configured(async ({ parent, repoDir }) => { await symlink(repoDir, join(parent, 'checkout')); });
  const opened = vi.spyOn(filesystem, 'open');
  const statfs = vi.spyOn(filesystem, 'statfs');
  cleanups.push(() => statfs.mockRestore()); // an injected /proc failure must not leak
  // Control: the descriptor-bound route works on this Linux/Node runtime.
  expect((await state()).state).toBe('symlink');
  opened.mockClear();
  // A foreign filesystem at /proc is not a trusted descriptor route.
  statfs.mockResolvedValue({ type: 0x1234n } as never);
  expect(await state()).toMatchObject({ state: 'cannot_inspect', problem: { code: 'runtime_unsupported' } });
  expect(opened).not.toHaveBeenCalled();
  // Missing procfs is equally unsupported, and no pathname lookup replaces it.
  statfs.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as never);
  expect(await state()).toMatchObject({ state: 'cannot_inspect', problem: { code: 'runtime_unsupported' } });
  expect(opened).not.toHaveBeenCalled();
  statfs.mockRestore();
});

it('observes only fd-relative metadata without reading a target, enumerating or writing', async () => {
  const base = await owned(async ({ root, parent }) => {
    const foreign = join(root, 'foreign'); await mkdir(foreign);
    await writeFile(join(foreign, 'secret'), 'FOREIGN_TARGET_CANARY');
    await symlink(foreign, join(parent, 'checkout'));
  });
  await base.f.save([{ ...base.f.entry, workspaceShortcut: base.descriptor }]);
  const repository = await ConfigRepository.load(base.f.authorization);
  const ports = new ReadPorts(repository); cleanups.push(() => ports.dispose());
  const before = await snapshot(base.f.root);
  const opened = vi.spyOn(filesystem, 'open');
  const lstat = vi.spyOn(filesystem, 'lstat');
  const stat = vi.spyOn(filesystem, 'stat');
  const forbidden = {
    readlink: vi.spyOn(filesystem, 'readlink'), readdir: vi.spyOn(filesystem, 'readdir'),
    opendir: vi.spyOn(filesystem, 'opendir'), readFile: vi.spyOn(filesystem, 'readFile'),
    realpath: vi.spyOn(filesystem, 'realpath'), writeFile: vi.spyOn(filesystem, 'writeFile'),
    appendFile: vi.spyOn(filesystem, 'appendFile'), mkdir: vi.spyOn(filesystem, 'mkdir'),
    unlink: vi.spyOn(filesystem, 'unlink'), rename: vi.spyOn(filesystem, 'rename'),
  };
  for (const spy of [opened, lstat, stat, ...Object.values(forbidden)]) spy.mockClear();
  expect((await ports.shortcut('demo')).state).toBe('symlink');
  const opens = opened.mock.calls.map(([path]) => String(path));
  expect(opens[0]).toBe('/');
  for (const path of opens.slice(1)) expect(path).toMatch(/^\/proc\/self\/fd\/\d+\/[^/]+$/);
  for (const path of lstat.mock.calls.map(([path]) => String(path))) {
    expect(path === '/proc/self/fd' || /^\/proc\/self\/fd\/\d+\/[^/]+$/.test(path)).toBe(true);
  }
  for (const path of stat.mock.calls.map(([path]) => String(path))) expect(path).toMatch(/^\/proc\/self\/fd\/\d+$/);
  for (const spy of Object.values(forbidden)) expect(spy).not.toHaveBeenCalled();
  expect(await snapshot(base.f.root)).toEqual(before);
});

it('discards a changed anchor or redirected fd route around the leaf observation', async () => {
  const { state } = await configured(async ({ parent, repoDir }) => { await symlink(repoDir, join(parent, 'checkout')); });
  const calls = await raw();
  let leafObserved = false;
  const lstat = vi.spyOn(filesystem, 'lstat').mockImplementation((async (path: string, options?: unknown) => {
    const info = await calls.lstat(path, options);
    if (/^\/proc\/self\/fd\/\d+\//.test(path)) leafObserved = true;
    return info;
  }) as never);
  const stat = vi.spyOn(filesystem, 'stat').mockImplementation((async (path: string, options?: unknown) =>
    leafObserved ? { dev: 1n, ino: 1n } : await calls.stat(path, options)) as never);
  const changed = await state();
  expect(changed).toMatchObject({ state: 'cannot_inspect', problem: { code: 'unsafe_path' } });
  lstat.mockRestore(); stat.mockRestore();
  expect((await state()).state).toBe('symlink');
});

it('bounds a stalled observation, keeps the capacity hold and never admits a queue', async () => {
  const { state } = await configured(async ({ parent, repoDir }) => { await symlink(repoDir, join(parent, 'checkout')); });
  const calls = await raw();
  let pending = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lstat = vi.spyOn(filesystem, 'lstat').mockImplementation((async (path: string, options?: unknown) => {
    // The leaf lookup stalls past the budget, then settles: no descriptor is closed
    // while it is still unsettled, and no late result is published.
    if (path.endsWith('/checkout')) { pending++; await gate; }
    return await calls.lstat(path, options);
  }) as never);
  cleanups.push(() => lstat.mockRestore());
  const started = performance.now();
  const timedOut = await state();
  const elapsed = performance.now() - started;
  expect(timedOut).toMatchObject({ state: 'cannot_inspect', problem: { code: 'deadline' } });
  expect(elapsed).toBeGreaterThanOrEqual(950); expect(elapsed).toBeLessThan(2000);
  // The unsettled call keeps the single reservation: no waiting queue and no reuse.
  expect((await state()).problem?.code).toBe('read_limit');
  expect((await state()).problem?.code).toBe('read_limit');
  expect(pending).toBe(1);
  release();
  await new Promise(resolve => setTimeout(resolve, 200));
  lstat.mockRestore();
  // Cleanup completed, so the single reservation becomes available again.
  expect((await state()).state).toBe('symlink');
});

it('closes a handle returned by a late successful open without continuing the walk', async () => {
  const { state } = await configured(async ({ parent, repoDir }) => { await symlink(repoDir, join(parent, 'checkout')); });
  const calls = await raw();
  let late: { fd: number } | null = null;
  let delayed = false;
  const opened = vi.spyOn(filesystem, 'open').mockImplementation((async (path: string, flags?: unknown) => {
    const handle = await calls.open(path, flags);
    if (!delayed && path.startsWith('/proc/self/fd/')) {
      delayed = true; late = handle; await new Promise(resolve => setTimeout(resolve, 1200));
    }
    return handle;
  }) as never);
  expect((await state()).problem?.code).toBe('deadline');
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(late).not.toBeNull();
  expect((late as unknown as { fd: number }).fd).toBe(-1);
  opened.mockRestore();
  // Cleanup released the capacity: the same configured shortcut is observable again.
  expect((await state()).state).toBe('symlink');
});

it('disables only a malformed shortcut descriptor and never touches the designated leaf', async () => {
  const base = await owned(async ({ parent, repoDir }) => { await symlink(repoDir, join(parent, 'checkout')); });
  const parent = base.parent;
  const long = '/' + Array.from({ length: 65 }, (_, i) => `c${i}`).join('/');
  const cases: unknown[] = [
    null, [], 'checkout', { directory: parent }, { directory: parent, name: 'checkout', target: base.f.repoDir },
    { directory: 'aliases', name: 'checkout' }, { directory: '/', name: 'checkout' },
    { directory: `${parent}/./`, name: 'checkout' }, { directory: `${parent}/`, name: 'checkout' },
    { directory: `${parent}//leaf`, name: 'checkout' }, { directory: '/a/../b', name: 'checkout' },
    { directory: long, name: 'checkout' }, { directory: '/' + 'x'.repeat(4096), name: 'checkout' },
    { directory: parent, name: '.hidden' }, { directory: parent, name: '-flag' }, { directory: parent, name: 'a/b' },
    { directory: parent, name: '' }, { directory: parent, name: 'a'.repeat(129) }, { directory: parent, name: 'check\u0000out' },
    { directory: parent, name: 'check\nout' }, { directory: parent, name: '..' },
  ];
  const opened = vi.spyOn(filesystem, 'open');
  for (const descriptor of cases) {
    await base.f.save([{ ...base.f.entry, workspaceShortcut: descriptor }]);
    const repository = await ConfigRepository.load(base.f.authorization);
    const catalog = repository.catalog();
    expect(catalog.state).toBe('configured');
    expect(catalog.entries[0]).toMatchObject({ status: 'available', problems: [{ source: 'config', code: 'shortcut_invalid' }] });
    expect(Object.keys(catalog.entries[0]).sort()).toEqual(['adapter', 'id', 'label', 'problems', 'repo', 'status']);
    expect(repository.resolve('demo')).toMatchObject({ workspaceShortcut: null, shortcutProblem: { code: 'shortcut_invalid' } });
    opened.mockClear();
    const ports = new ReadPorts(repository);
    expect(await ports.shortcut('demo')).toMatchObject({ state: 'not_configured', problem: { source: 'config', code: 'shortcut_invalid' } });
    await ports.dispose();
    expect(opened).not.toHaveBeenCalled();
  }
});

it('reads nothing for an unconfigured shortcut and rejects client paths or unknown deployments', async () => {
  const f = await fixture(); cleanups.push(f.cleanup);
  await f.save([f.entry]);
  const repository = await ConfigRepository.load(f.authorization);
  expect(repository.catalog().entries[0].problems).toEqual([]);
  const ports = new ReadPorts(repository); cleanups.push(() => ports.dispose());
  const opened = vi.spyOn(filesystem, 'open'); opened.mockClear();
  expect(workspaceShortcutStatus.output.parse(await ports.shortcut('demo'))).toMatchObject({ state: 'not_configured', problem: null });
  expect(opened).not.toHaveBeenCalled();
  await expect(ports.shortcut('other')).rejects.toThrow('deployment_unavailable');
  for (const input of [{ deploymentId: 'demo', path: '/etc/passwd' }, { deploymentId: 'demo', directory: '/etc' },
    { deploymentId: '../demo' }, {}, { deploymentId: 'demo', name: 'checkout' }]) {
    expect(() => workspaceShortcutStatus.input.parse(input)).toThrow();
  }
  expect(workspaceShortcutStatus.input.parse({ deploymentId: 'demo' })).toEqual({ deploymentId: 'demo' });
  // Registered at the real server entry: only the authorized catalog ID resolves.
  vi.stubEnv('PASEO_ORBI_CONFIG', f.authorization);
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  cleanups.push(contribute({ handle: (contract: { name: string }, handler: (input: unknown) => Promise<unknown>) => { handlers.set(contract.name, handler); } } as unknown as PluginServerContext));
  const call = async (input: unknown) => workspaceShortcutStatus.output.parse(
    await handlers.get('workspace.shortcut')!(workspaceShortcutStatus.input.parse(input)));
  expect(await call({ deploymentId: 'demo' })).toMatchObject({ deploymentId: 'demo', state: 'not_configured' });
  await expect(call({ deploymentId: 'other' })).rejects.toThrow('deployment_unavailable');
  await expect(call({ deploymentId: 'demo', path: '/etc/passwd' })).rejects.toThrow();
  vi.unstubAllEnvs();
});

const theme = {
  colors: {
    foreground: '#eee', foregroundMuted: '#aaa', surface0: '#111', surface1: '#222', surface2: '#333',
    border: '#555', accent: '#abc', accentForeground: '#000', statusSuccess: '#0f0', statusWarning: '#ff0', statusDanger: '#f00',
  },
};
const props = {
  hostId: 'host-a', deploymentId: 'demo', repo: 'Example/project', connected: true, foreground: true, theme,
};
const status = (state: ShortcutState, deploymentId = 'demo', problem: { source: string; code: string } | null = null) =>
  workspaceShortcutStatus.output.parse({ deploymentId, state, observedAt: stamp, problem });
const text = (renderer: ReactTestRenderer) => renderer.root.findAllByType('Text' as any).map(node => node.children.join('')).join('\n');
async function renderShortcut(overrides: Partial<typeof props> = {}) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<WorkspaceShortcut {...props} {...overrides} />); });
  cleanups.push(async () => { await act(async () => renderer.unmount()); });
  return renderer;
}
const press = async (renderer: ReactTestRenderer, label: string) => {
  await act(async () => { await renderer.root.findByProps({ accessibilityLabel: label }).props.onPress(); });
};

it('reports exactly the five presence/type labels and inspects only on an explicit press', async () => {
  const rows: [ShortcutState, string][] = [['symlink', 'Symlink present'], ['not_symlink', 'Present, not a symlink'],
    ['absent', 'Not present'], ['cannot_inspect', 'Cannot inspect'], ['not_configured', 'Not configured']];
  for (const [state, label] of rows) {
    host.readShortcut.mockReset().mockResolvedValue(status(state));
    const renderer = await renderShortcut();
    expect(host.readShortcut).not.toHaveBeenCalled();
    expect(text(renderer)).toContain('Workspace shortcut: Not inspected');
    await press(renderer, 'Inspect shortcut');
    expect(host.readShortcut).toHaveBeenCalledTimes(1);
    expect(host.readShortcut).toHaveBeenCalledWith({ deploymentId: 'demo' });
    expect(text(renderer)).toContain(`Workspace shortcut: ${label}`);
    await press(renderer, 'Refresh shortcut');
    expect(host.readShortcut).toHaveBeenCalledTimes(2);
  }
});

it('shows a safe failure instead of raw transport text and discloses no path', async () => {
  host.readShortcut.mockReset().mockRejectedValue(new Error('SECRET raw transport /home/operator/aliases'));
  const renderer = await renderShortcut();
  await press(renderer, 'Inspect shortcut');
  const page = text(renderer);
  expect(page).toContain('Workspace shortcut: Cannot inspect');
  expect(page).toContain('filesystem: refresh_failed');
  expect(page).not.toContain('SECRET');
  expect(page).not.toContain('/home/operator');
  expect(page).toContain('does not read, follow, compare or display the target');
});

it('keeps no stale result across a replaced selection or an offline host', async () => {
  let resolve!: (value: unknown) => void;
  host.readShortcut.mockReset().mockImplementationOnce(() => new Promise(done => { resolve = done as never; }));
  const renderer = await renderShortcut();
  // The pending read must not block the replacement selection.
  await act(async () => { void renderer.root.findByProps({ accessibilityLabel: 'Inspect shortcut' }).props.onPress(); });
  expect(host.readShortcut).toHaveBeenCalledTimes(1);
  await act(async () => { renderer.update(<WorkspaceShortcut {...props} deploymentId="other" />); });
  await act(async () => { resolve(status('symlink', 'demo')); });
  await act(async () => { await Promise.resolve(); });
  const page = text(renderer);
  expect(page).toContain('Workspace shortcut: Not inspected');
  expect(page).not.toContain('Symlink present');
  // A disconnected host never inspects and cannot look like a successful observation.
  host.readShortcut.mockClear();
  const offline = await renderShortcut({ connected: false });
  expect(text(offline)).toContain('Host offline: no shortcut inspection.');
  await press(offline, 'Inspect shortcut');
  expect(host.readShortcut).not.toHaveBeenCalled();
  // Backgrounded apps do not inspect either.
  const background = await renderShortcut({ foreground: false });
  expect(text(background)).toContain('App is in the background: no shortcut inspection.');
  await press(background, 'Inspect shortcut');
  expect(host.readShortcut).not.toHaveBeenCalled();
});
