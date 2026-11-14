import type { PluginServerContext } from '@getpaseo/plugin/server';
import { deploymentsList } from './shared/common';
import { fleetRead } from './shared/fleet';
import { readFleet } from './server/fleet';
import { ConfigRepository } from './server/config';
import { ReadPorts } from './server/read-ports';

export default function contribute(server: PluginServerContext) {
  // Read the environment once, not per RPC or poll. No environment values are logged.
  const lifetime = new AbortController();
  const repository = ConfigRepository.load(process.env.PASEO_ORBI_CONFIG, lifetime.signal);
  const ports = repository.then(config => new ReadPorts(config));
  server.handle(deploymentsList, async () => (await repository).catalog());
  server.handle(fleetRead, async input => readFleet(await repository, await ports, input));
  return async () => { lifetime.abort(); await (await ports).dispose(); };
}
