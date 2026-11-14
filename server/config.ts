import { dirname, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { DeploymentId, type DeploymentCatalog, type Problem } from '../shared/common';
import { absolutePath, readBytes, ReadError } from './read-ports';
import { compatible, type SourceProfile } from './compatibility';

const repoPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const identity = z.object({
  id: DeploymentId, label: z.string().min(1).max(80).regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u),
  repo: z.string().regex(repoPattern).refine(v => !['.', '..'].includes(v.split('/')[1])),
  adapter: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  configPath: z.string(), engineSourcePath: z.string(), repoDir: z.string(), deployHome: z.string(),
  trustedPublisherLogins: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/)).max(32),
}).strict();
const configuration = z.object({ schema: z.literal(1), deployments: z.array(identity) }).strict();
export type ValidatedDeployment = Readonly<{
  id: string; repo: string; configPath: string; engineSourcePath: string; repoDir: string; deployHome: string;
  sourceProfile: SourceProfile; unitName: string | null; capacity: number; trustedPublisherLogins: readonly string[];
}>;
const problem = (code: Problem['code'], source: Problem['source'] = 'config'): Problem => ({ source, code });
async function authorizedDirectory(path: string) {
  if (!absolutePath(path) || await realpath(path) !== path || !(await stat(path)).isDirectory()) throw new ReadError('unsafe_path');
}
function tomlPath(value: unknown, base: string) {
  if (typeof value !== 'string' || !value || /[$~\x00-\x1f\x7f]/.test(value)) throw new Error('config_mismatch');
  return resolve(base, value);
}
export class ConfigRepository {
  private constructor(private readonly view: DeploymentCatalog, private readonly deployments = new Map<string, ValidatedDeployment>()) {}
  static async load(path: string | undefined): Promise<ConfigRepository> {
    if (path === undefined) return new ConfigRepository({ state: 'unconfigured', entries: [], problems: [] });
    const invalid = (code: Problem['code']) => new ConfigRepository({ state: 'invalid', entries: [], problems: [problem(code)] });
    let raw: unknown;
    try {
      if (!absolutePath(path)) return invalid('unsafe_path');
      raw = JSON.parse((await readBytes(dirname(path), path)).toString('utf8'));
    } catch { return invalid('invalid_config'); }
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
    for (const entry of parsed.data.deployments) {
      const safe: DeploymentCatalog['entries'][number] = {
        id: entry.id, label: entry.label, repo: entry.repo, adapter: entry.adapter, status: 'invalid_config', problems: [],
      };
      catalog.entries.push(safe);
      try {
        if (!absolutePath(entry.configPath)) throw new ReadError('unsafe_path');
        await authorizedDirectory(entry.repoDir); await authorizedDirectory(entry.deployHome); await authorizedDirectory(entry.engineSourcePath);
        const toml = parse((await readBytes(dirname(entry.configPath), entry.configPath)).toString('utf8'));
        const base = dirname(entry.configPath);
        const repoDir = tomlPath(toml.repo_dir ?? '.', base);
        const deployHome = tomlPath(toml.deploy_home ?? repoDir, base);
        if (repoDir !== entry.repoDir || deployHome !== entry.deployHome
          || !Array.isArray(toml.source_repos) || toml.source_repos.length !== 1 || toml.source_repos[0] !== entry.repo) throw new Error('config_mismatch');
        const unitName = toml.unit_name ?? null;
        const capacity = toml.max_concurrency ?? 1;
        if ((unitName !== null && (typeof unitName !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(unitName)))
          || typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1 || capacity > 5) throw new Error('config_mismatch');
        if (!await compatible(entry.engineSourcePath, entry.adapter)) {
          safe.status = 'unsupported_source_profile'; safe.problems = [problem('unsupported_source_profile', 'compatibility')]; continue;
        }
        safe.status = 'available';
        valid.set(entry.id, Object.freeze({
          id: entry.id, repo: entry.repo, configPath: entry.configPath, engineSourcePath: entry.engineSourcePath,
          repoDir: entry.repoDir, deployHome: entry.deployHome, sourceProfile: entry.adapter as SourceProfile,
          unitName, capacity, trustedPublisherLogins: Object.freeze([...entry.trustedPublisherLogins]),
        }));
      } catch (error) { safe.problems = [problem(error instanceof ReadError && error.code === 'unsafe_path' ? 'unsafe_path' : 'config_mismatch')]; }
    }
    return new ConfigRepository(catalog, valid);
  }
  catalog(): DeploymentCatalog { return structuredClone(this.view); }
  resolve(id: string): ValidatedDeployment {
    const deployment = this.deployments.get(id);
    if (!deployment) throw new Error('deployment_unavailable');
    return deployment;
  }
}
