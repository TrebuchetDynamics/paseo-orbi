import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const adapters = { release: 'orbi-0.7.41-release', installed: 'orbi-0.7.41-1a8b2f96', v0748: 'orbi-0.7.48-release', v0765: 'orbi-0.7.65-release' } as const;
export type FixtureProfile = keyof typeof adapters;
export async function fixture(profile: FixtureProfile = 'release', parent = tmpdir()) {
  const root = await mkdtemp(join(parent, 'paseo-orbi-'));
  const source = join(root, 'source'), repoDir = join(root, 'repo'), deployHome = join(root, 'home');
  await Promise.all([mkdir(source), mkdir(repoDir), mkdir(deployHome)]);
  const files = JSON.parse(gunzipSync(await readFile(new URL(`./${profile}.json.gz`, import.meta.url))).toString()) as Record<string, string>;
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), text); }
  const configPath = join(root, 'orbi.toml'), authorization = join(root, 'authorized.json');
  const toml = `repo_dir = "${repoDir}"\ndeploy_home = "${deployHome}"\nsource_repos = ["Example/project"]\nunit_name = "demo"\nmax_concurrency = 2\n`;
  await writeFile(configPath, toml);
  const entry = { id: 'demo', label: 'Demo', repo: 'Example/project', adapter: adapters[profile], configPath, engineSourcePath: source, repoDir, deployHome, trustedPublisherLogins: ['publisher-canary'] };
  const save = async (deployments: unknown[] = [entry]) => { await writeFile(authorization, JSON.stringify({ schema: 1, deployments })); return authorization; };
  await save();
  return { root, source, repoDir, deployHome, configPath, authorization, entry, toml, save, cleanup: () => rm(root, { recursive: true, force: true }) };
}
