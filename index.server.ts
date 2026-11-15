import type { PluginServerContext } from '@getpaseo/plugin/server';
import { deploymentsList } from './shared/common';
import { fleetRead } from './shared/fleet';
import { readFleet } from './server/fleet';
import { ConfigRepository } from './server/config';
import { ReadPorts } from './server/read-ports';
import { GitHubReader } from './server/github';
import { issuesList, issuesGet } from './shared/issues';
import { blockersList, blockersRead } from './shared/blockers';
import { BlockersReader } from './server/blockers';

export default function contribute(server: PluginServerContext) {
  // Read the environment once, not per RPC or poll. No environment values are logged.
  const lifetime = new AbortController();
  const repository = ConfigRepository.load(process.env.PASEO_ORBI_CONFIG, lifetime.signal);
  const ports = repository.then(config => new ReadPorts(config));
  const github = Promise.all([repository, ports]).then(([config, reads]) => new GitHubReader(config, reads));
  const blockers = Promise.all([repository, github, ports]).then(([config, reader, reads]) => new BlockersReader(config, reader, reads));
  server.handle(blockersList, async input => (await blockers).list(input));
  server.handle(blockersRead, async input => (await blockers).read(input));
  server.handle(deploymentsList, async () => (await repository).catalog());
  server.handle(issuesList, async input => (await github).listIssues(input.deploymentId, input.page));
  server.handle(issuesGet, async input => (await github).getIssue(input.deploymentId, input.issue));
  server.handle(fleetRead, async input => readFleet(await repository, await ports, input));
  return async () => { lifetime.abort(); await (await ports).dispose(); };
}
