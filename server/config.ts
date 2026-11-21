import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { DeploymentId, type DeploymentCatalog, type Problem } from '../shared/common';
import { absolutePath, boundedDirectory, readBytes, ReadError } from './read-ports';
import { compatible, type SourceProfile } from './compatibility';

const repoPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const identity = z.object({
  id: DeploymentId, label: z.string().min(1).max(80).regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u),
  repo: z.string().regex(repoPattern).refine(v => !['.', '..'].includes(v.split('/')[1])),
  adapter: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  configPath: z.string(), engineSourcePath: z.string(), repoDir: z.string(), deployHome: z.string(),
  trustedPublisherLogins: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/)).max(32),
  // Optional additive descriptor. Any value is parsed by shortcutDescriptor below so a
  // malformed descriptor disables only the shortcut instead of the whole catalog.
  workspaceShortcut: z.unknown().optional(),
}).strict();
const configuration = z.object({ schema: z.literal(1), deployments: z.array(identity) }).strict();
// Display-only association candidate for the host service inventory. A claim is
// recorded only after the unit prefix and capacity are validated; an entry whose
// sole rejection is an unsupported source profile keeps its claim without
// gaining read authority. Read authority still requires resolve().
export type UnitFamilyClaim = Readonly<{
  id: string; unitName: string | null; status: 'available' | 'unsupported_source_profile';
}>;
// One operator-designated shortcut: a canonical absolute parent directory and a
// single leaf basename. The target is never part of this descriptor.
export type ShortcutDescriptor = Readonly<{ directory: string; name: string }>;
export type ValidatedDeployment = Readonly<{
  id: string; repo: string; configPath: string; engineSourcePath: string; repoDir: string; deployHome: string;
  sourceProfile: SourceProfile; unitName: string | null; capacity: number; trustedPublisherLogins: readonly string[];
  worktreeRetainHours: number; keepFailedWorktrees: boolean | null;
  workspaceShortcut: ShortcutDescriptor | null; shortcutProblem: Problem | null;
}>;
const problem = (code: Problem['code'], source: Problem['source'] = 'config'): Problem => ({ source, code });
// Basename bound: 1-128 ASCII characters, alphanumeric first, then alphanumeric/dot/
// underscore/hyphen. No separators, controls, leading dot/dash or dot segment fits.
const shortcutName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIRECTORY_LIMIT = 4096;
const COMPONENT_LIMIT = 64;
// Syntactic validation only: nothing is touched or resolved here. The configured
// directory is a dedicated canonical parent, never '/' and never a dot segment.
export function shortcutDescriptor(value: unknown): ShortcutDescriptor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(',') !== 'directory,name') return null;
  const { directory, name } = raw;
  if (typeof directory !== 'string' || typeof name !== 'string') return null;
  if (!isAbsolute(directory) || normalize(directory) !== directory || directory === '/') return null;
  if (/[\x00-\x1f\x7f]/.test(directory) || Buffer.byteLength(directory, 'utf8') > DIRECTORY_LIMIT) return null;
  const components = directory.slice(1).split('/');
  if (components.length > COMPONENT_LIMIT) return null;
  if (components.some(component => !component || component === '.' || component === '..')) return null;
  if (!shortcutName.test(name)) return null;
  return Object.freeze({ directory, name });
}
function tomlPath(value: unknown, base: string) {
  if (typeof value !== 'string' || !value || /[$~\x00-\x1f\x7f]/.test(value)) throw new Error('config_mismatch');
  return resolve(base, value);
}
export class ConfigRepository {
  private constructor(private readonly view: DeploymentCatalog, private readonly deployments = new Map<string, ValidatedDeployment>(),
    private readonly claims: readonly UnitFamilyClaim[] = []) {}
  static async load(path: string | undefined, signal?: AbortSignal): Promise<ConfigRepository> {
    if (path === undefined) return new ConfigRepository({ state: 'unconfigured', entries: [], problems: [] });
    const invalid = (code: Problem['code']) => new ConfigRepository({ state: 'invalid', entries: [], problems: [problem(code)] });
    let raw: unknown;
    try {
      if (!absolutePath(path)) return invalid('unsafe_path');
      raw = JSON.parse((await readBytes(dirname(path), path, signal)).toString('utf8'));
    } catch (error) { return invalid(error instanceof ReadError ? error.code : 'invalid_config'); }
    const root = z.object({ schema: z.literal(1), deployments: z.array(z.unknown()) }).strict().safeParse(raw);
    if (!root.success) return invalid('invalid_config');
    if (root.data.deployments.length > 16) return invalid('too_many_deployments');
    const parsed = configuration.safeParse(raw);
    if (!parsed.success) return invalid('invalid_identity');
    const ids = new Set<string>(), repos = new Set<string>();
    for (const entry of parsed.data.deployments) {
      if (ids.has(entry.id) || repos.has(entry.repo.toLowerCase())) return invalid('duplicate_deployment');
      ids.add(entry.id); repos.add(entry.repo.toLowerCase());
    }
    const catalog: DeploymentCatalog = { state: 'configured', entries: [], problems: [] };
    const valid = new Map<string, ValidatedDeployment>();
    const claims: UnitFamilyClaim[] = [];
    for (const entry of parsed.data.deployments) {
      const shortcut = shortcutDescriptor(entry.workspaceShortcut);
      const shortcutProblem = entry.workspaceShortcut === undefined || shortcut !== null ? null : problem('shortcut_invalid');
      if (signal?.aborted) return invalid('disposed');
      const safe: DeploymentCatalog['entries'][number] = {
        id: entry.id, label: entry.label, repo: entry.repo, adapter: entry.adapter, status: 'invalid_config', problems: [],
      };
      catalog.entries.push(safe);
      try {
        if (!absolutePath(entry.configPath)) throw new ReadError('unsafe_path');
        await boundedDirectory(entry.repoDir, signal); await boundedDirectory(entry.deployHome, signal); await boundedDirectory(entry.engineSourcePath, signal);
        const toml = parse((await readBytes(dirname(entry.configPath), entry.configPath, signal)).toString('utf8'));
        const base = dirname(entry.configPath);
        const repoDir = tomlPath(toml.repo_dir ?? '.', base);
        const deployHome = tomlPath(toml.deploy_home ?? repoDir, base);
        if (repoDir !== entry.repoDir || deployHome !== entry.deployHome
          || !Array.isArray(toml.source_repos) || toml.source_repos.length !== 1 || toml.source_repos[0] !== entry.repo) throw new Error('config_mismatch');
        const unitName = toml.unit_name ?? null;
        const capacity = toml.max_concurrency ?? 1;
        if ((unitName !== null && (typeof unitName !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(unitName)))
          || typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1 || capacity > 5) throw new Error('config_mismatch');
        if (!await compatible(entry.engineSourcePath, entry.adapter, signal)) {
          safe.status = 'unsupported_source_profile'; safe.problems = [problem('unsupported_source_profile', 'compatibility')];
          claims.push(Object.freeze({ id: entry.id, unitName, status: 'unsupported_source_profile' }));
          continue;
        }
        const worktreeRetainHours = toml.worktree_retain_hours ?? 72;
        const keepFailedWorktrees = (entry.adapter === 'orbi-0.7.41-1a8b2f96' || entry.adapter === 'orbi-0.7.48-release') ? toml.keep_failed_worktrees ?? true : null;
        if (typeof worktreeRetainHours !== 'number' || !Number.isFinite(worktreeRetainHours) || worktreeRetainHours <= 0
          || (keepFailedWorktrees !== null && typeof keepFailedWorktrees !== 'boolean')) throw new Error('config_mismatch');
        safe.status = 'available';
        claims.push(Object.freeze({ id: entry.id, unitName, status: 'available' }));
        if (shortcutProblem) safe.problems = [shortcutProblem];
        valid.set(entry.id, Object.freeze({
          id: entry.id, repo: entry.repo, configPath: entry.configPath, engineSourcePath: entry.engineSourcePath,
          repoDir: entry.repoDir, deployHome: entry.deployHome, sourceProfile: entry.adapter as SourceProfile,
          unitName, capacity, worktreeRetainHours, keepFailedWorktrees, trustedPublisherLogins: Object.freeze([...entry.trustedPublisherLogins]),
          workspaceShortcut: shortcut, shortcutProblem,
        }));
      } catch (error) { safe.problems = [problem(error instanceof ReadError ? error.code : 'config_mismatch')]; }
    }
    return new ConfigRepository(catalog, valid, claims);
  }
  catalog(): DeploymentCatalog { return structuredClone(this.view); }
  // Display-only inventory association claims. This is not a read capability:
  // resolve() remains the only path to deployment reads and still excludes
  // unsupported profiles.
  unitClaims(): readonly UnitFamilyClaim[] { return this.claims; }
  resolve(id: string): ValidatedDeployment {
    const deployment = this.deployments.get(id);
    if (!deployment) throw new Error('deployment_unavailable');
    return deployment;
  }
}
