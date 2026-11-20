import { readFile, writeFile, rm, mkdtemp, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { installStandin } from '../harness';

// Executed by the run's global setup, before any daemon: prove the redesign
// stand-in answers both fixed list argv forms, answers the delegated reads it
// still takes from the unchanged #12 tool and refuses every other argv with exit
// 64, without ever resolving a real tool. The layout comes from the same helper
// a launched host uses, so an unresolvable delegation fails here, not mid-journey.
export async function verifyFixtureRefusal() {
  const source = await readFile(new URL('./fixture.mjs', import.meta.url), 'utf8');
  if (/node:child_process|execFile|spawn\(|execSync|\/usr\/bin\/systemctl/.test(source)) throw new Error('Host-first fixture must not fall back to a real tool');
  const root = await mkdtemp(join(tmpdir(), 'orbi-host-first-proof-'));
  const bin = join(root, 'host-a-bin');
  const run = async (args: string[]) => {
    try { return { code: 0, stdout: (await promisify(execFile)(process.execPath, [join(bin, 'systemctl'), ...args], {
      env: { PATH: dirname(process.execPath), ORBI_E2E_STATE: join(root, 'state.json'), ORBI_E2E_CALLS: join(root, 'calls.jsonl') }, timeout: 15000, maxBuffer: 65536 })).stdout, stderr: '' }; }
    catch (error) { const detail = error as { code?: number; stdout?: string; stderr?: string }; return { code: typeof detail.code === 'number' ? detail.code : 1, stdout: detail.stdout ?? '', stderr: detail.stderr ?? '' }; }
  };
  try {
    await mkdir(bin);
    await installStandin(root, bin, 'host-first');
    await writeFile(join(root, 'state.json'), JSON.stringify({ scenario: 'available', alias: 'host-a' }));
    await writeFile(join(root, 'calls.jsonl'), '');
    const listArgv = [
      ['--user', 'list-units', '--all', '--type=service,timer', '--plain', '--no-legend', '--no-pager', '--full', 'orbi*.service', 'orbi*.timer'],
      ['--user', 'list-unit-files', '--type=service,timer', '--no-legend', '--no-pager', '--full', 'orbi*.service', 'orbi*.timer'],
    ];
    const properties = '--property=Id,LoadState,ActiveState,SubState,UnitFileState,Result,ExecMainCode,ExecMainStatus,NRestarts,LastTriggerUSec,NextElapseUSecRealtime,NextElapseUSecMonotonic';
    const allowed = await Promise.all(listArgv.map(run));
    const delegated = await run(['--user', 'show', 'orbi-demo@1.service', properties, '--no-pager']);
    const refused = await run(['--user', 'stop', 'orbi-demo@1.service']);
    const nearMiss = await run(['--user', 'list-units', '--all', '--type=service', '--plain', '--no-legend', '--no-pager', '--full', 'orbi*.service', 'orbi*.timer']);
    if (allowed.some(result => result.code !== 0 || !result.stdout.includes('orbi-demo'))) throw new Error('Host-first fixture did not answer both fixed inventory list argv forms');
    if (delegated.code !== 0 || !delegated.stdout.includes('Id=orbi-demo@1.service')) throw new Error('Host-first fixture did not answer a delegated read from the launched stand-in layout');
    if (refused.code !== 64 || nearMiss.code !== 64) throw new Error('Host-first fixture accepted an unauthorized argv');
    return { lane: 'host-first', inventoryFlag: true, allowedListArgv: true, delegatedRead: true, refusedArgv: ['--user', 'stop', 'orbi-demo@1.service'],
      refusalExitCode: refused.code, unknownArgvRefused: nearMiss.code === 64, fallback: false, verifiedAt: new Date().toISOString() };
  } finally { await rm(root, { recursive: true, force: true }); }
}
