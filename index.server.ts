import type { PluginServerContext } from '@getpaseo/plugin/server';
import { deploymentsList } from './shared/common';
import { fleetRead } from './shared/fleet';
import { readFleet } from './server/fleet';
import { ConfigRepository } from './server/config';
import { ReadPorts } from './server/read-ports';
import { GitHubReader } from './server/github';
import { issuesList, issuesGet } from './shared/issues';
import { runsList, runsRead } from './shared/runs';
import { RunsReader } from './server/runs';

export default function contribute(server: PluginServerContext) {
  // Read the environment once, not per RPC or poll. No environment values are logged.
  const lifetime = new AbortController();
  const repository = ConfigRepository.load(process.env.PASEO_ORBI_CONFIG, lifetime.signal);
  const ports = repository.then(config => new ReadPorts(config));
  const github = Promise.all([repository, ports]).then(([config, reads]) => new GitHubReader(config, reads));
  const runs = Promise.all([repository, ports, github]).then(([config, reads, reports]) => new RunsReader(config, reads, reports));
  server.handle(deploymentsList, async () => (await repository).catalog());
  server.handle(issuesList, async input => (await github).listIssues(input.deploymentId, input.page));
  server.handle(issuesGet, async input => (await github).getIssue(input.deploymentId, input.issue));
  server.handle(fleetRead, async input => readFleet(await repository, await ports, input));
  server.handle(runsList, async input => (await runs).list(input));
  server.handle(runsRead, async input => (await runs).read(input));
  return async () => { lifetime.abort(); await (await ports).dispose(); };
}
