import { readFile, writeFile, rm, mkdtemp, mkdir, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

// Executed by the run's global setup, before any daemon: prove the redesign
// stand-in answers both fixed list argv forms and refuses every other argv with
// exit 64, without ever resolving a real tool. Node-only imports keep this
// module out of the browser fixture graph.
export async function verifyFixtureRefusal() {
  const source = await readFile(new URL('./fixture.mjs', import.meta.url), 'utf8');
  if (/node:child_process|execFile|spawn\(|execSync|\/usr\/bin\/systemctl/.test(source)) throw new Error('Host-first fixture must not fall back to a real tool');
  const root = await mkdtemp(join(tmpdir(), 'orbi-host-first-proof-'));
  const run = async (args: string[]) => {
    try { return { code: 0, stdout: (await promisify(execFile)(process.execPath, [join(root, 'host-first', 'systemctl'), ...args], {
      env: { PATH: dirname(process.execPath), ORBI_E2E_STATE: join(root, 'state.json'), ORBI_E2E_CALLS: join(root, 'calls.jsonl') }, timeout: 15000, maxBuffer: 65536 })).stdout, stderr: '' }; }
    catch (error) { const detail = error as { code?: number; stdout?: string; stderr?: string }; return { code: typeof detail.code === 'number' ? detail.code : 1, stdout: detail.stdout ?? '', stderr: detail.stderr ?? '' }; }
  };
  try {
    await mkdir(join(root, 'host-first')); await mkdir(join(root, 'fixtures'));
    await writeFile(join(root, 'fixtures', 'tool.mjs'), await readFile(new URL('../fixtures/tool.mjs', import.meta.url)));
    await writeFile(join(root, 'host-first', 'systemctl'), source); await chmod(join(root, 'host-first', 'systemctl'), 0o700);
    await writeFile(join(root, 'state.json'), JSON.stringify({ scenario: 'available', alias: 'host-a' }));
    await writeFile(join(root, 'calls.jsonl'), '');
    const listArgv = [
      ['--user', 'list-units', '--all', '--type=service,timer', '--plain', '--no-legend', '--no-pager', '--full', 'orbi*.service', 'orbi*.timer'],
      ['--user', 'list-unit-files', '--type=service,timer', '--no-legend', '--no-pager', '--full', 'orbi*.service', 'orbi*.timer'],
    ];
    const allowed = await Promise.all(listArgv.map(run));
    const refused = await run(['--user', 'stop', 'orbi-demo@1.service']);
    const nearMiss = await run(['--user', 'list-units', '--all', '--type=service', '--plain', '--no-legend', '--no-pager', '--full', 'orbi*.service', 'orbi*.timer']);
    if (allowed.some(result => result.code !== 0 || !result.stdout.includes('orbi-demo'))) throw new Error('Host-first fixture did not answer both fixed inventory list argv forms');
    if (refused.code !== 64 || nearMiss.code !== 64) throw new Error('Host-first fixture accepted an unauthorized argv');
    return { lane: 'host-first', inventoryFlag: true, allowedListArgv: true, refusedArgv: ['--user', 'stop', 'orbi-demo@1.service'],
      refusalExitCode: refused.code, unknownArgvRefused: nearMiss.code === 64, fallback: false, verifiedAt: new Date().toISOString() };
  } finally { await rm(root, { recursive: true, force: true }); }
}
