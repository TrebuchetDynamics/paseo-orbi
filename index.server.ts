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
import { blockersList, blockersRead } from './shared/blockers';
import { BlockersReader } from './server/blockers';
import { servicesInventory } from './shared/services';
import { servicesControl } from './shared/service-control';
import { createServiceInventory } from './server/service-inventory';
import { createServiceControl, executeControl } from './server/service-control';
import { workspaceShortcutStatus } from './shared/workspace-shortcut';

export default function contribute(server: PluginServerContext) {
  // Read the environment once, not per RPC or poll. No environment values are logged.
  const lifetime = new AbortController();
  const repository = ConfigRepository.load(process.env.PASEO_ORBI_CONFIG, lifetime.signal);
  const ports = repository.then(config => new ReadPorts(config));
  // Startup-only opt-in: a later environment change never enables disclosure.
  const inventoryEnabled = process.env.PASEO_ORBI_HOST_INVENTORY === '1';
  // One host-level snapshot for the plugin process, shared by every caller.
  const inventory = Promise.all([repository, ports]).then(([config, reads]) => createServiceInventory({
    enabled: inventoryEnabled, claims: () => config.unitClaims(), port: reads,
    // Revocation ends the grant: disabling/removing/reloading this plugin or
    // stopping the daemon aborts it, discarding cached and in-flight results.
    signal: lifetime.signal,
  }));
  const github = Promise.all([repository, ports]).then(([config, reads]) => new GitHubReader(config, reads));
  const runs = Promise.all([repository, ports, github]).then(([config, reads, reports]) => new RunsReader(config, reads, reports));
  const blockers = Promise.all([repository, github, ports]).then(([config, reader, reads]) => new BlockersReader(config, reader, reads));
  server.handle(blockersList, async input => (await blockers).list(input));
  server.handle(blockersRead, async input => (await blockers).read(input));
  server.handle(deploymentsList, async () => (await repository).catalog());
  server.handle(servicesInventory, async input => (await inventory)(input));
  // Operator-granted service controls. Authorization is the explicit startup
  // grant in the operator config; the pinned host supplies no authenticated
  // actor, which the result records as null instead of inventing one. The
  // action runs through a separate mutation adapter, and its resulting state is
  // re-read through the existing bounded read port.
  const control = Promise.all([repository, ports]).then(([config, reads]) => createServiceControl({
    repository: config, signal: lifetime.signal, actor: null,
    port: {
      now: () => new Date(),
      run: (argv, timeoutMs) => executeControl(argv, timeoutMs),
      show: async (deploymentId, slot) => reads.process(deploymentId, { kind: 'systemctl-show', slot, unit: 'service' }),
    },
  }));
  server.handle(servicesControl, async input => (await control)(input));
  server.handle(workspaceShortcutStatus, async input => (await ports).shortcut(input.deploymentId));
  server.handle(issuesList, async input => (await github).listIssues(input.deploymentId, input.page, input.state, input.label ?? null));
  server.handle(issuesGet, async input => (await github).getIssue(input.deploymentId, input.issue));
  server.handle(fleetRead, async input => readFleet(await repository, await ports, input));
  server.handle(runsList, async input => (await runs).list(input));
  server.handle(runsRead, async input => (await runs).read(input));
  return async () => { lifetime.abort(); await (await ports).dispose(); };
}
