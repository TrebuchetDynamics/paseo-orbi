import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lease, start } from '../harness';
import { verifyFixtureRefusal } from './proof';

// Opt-in host-first lane. Approval is the issue-32 expanded-inventory receipt,
// never the #12/#13 receipt, and both synthetic hosts get the startup inventory
// flag. Playwright invokes global setup only for execution, never for --list.
export default async function globalSetup() {
  const running = await start(process.env, 'available', 'host-first');
  try {
    // Safe-fixture proof is observed here, before journeys, and retained beside
    // the evidence: the original bytes answer both list forms and refuse other argv.
    await writeFile(join(running.input.output, 'fixture-proof.json'), JSON.stringify(await verifyFixtureRefusal(), null, 2));
    const path = join(running.root, 'lease.json');
    await writeFile(path, JSON.stringify(lease(running)));
    process.env.PASEO_E2E_LEASE = path;
  } catch (error) {
    // A setup failure must not leak the owned hosts a returning teardown never sees.
    try { await running.cleanup(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Host-first setup failed and cleanup also failed'); }
    throw error;
  }
  return running.cleanup;
}
