import type { PluginServerContext } from '@getpaseo/plugin/server';
import { deploymentsList } from './shared/common';
import { ConfigRepository } from './server/config';
import { ReadPorts } from './server/read-ports';

export default function contribute(server: PluginServerContext) {
  // Read the environment once, not per RPC or poll. No environment values are logged.
  const repository = ConfigRepository.load(process.env.PASEO_ORBI_CONFIG);
  const ports = repository.then(config => new ReadPorts(config));
  server.handle(deploymentsList, async () => (await repository).catalog());
  return async () => { await (await ports).dispose(); };
}
