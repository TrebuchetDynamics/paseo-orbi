// Strict process stand-ins below the real adapters. Never forward to a system tool.
import { readFileSync, appendFileSync } from 'node:fs';
import { basename } from 'node:path';

export function operation(name, args, { scenario, alias, records, guidance }) {
const properties = '--property=Id,LoadState,ActiveState,SubState,UnitFileState,Result,ExecMainCode,ExecMainStatus,NRestarts,LastTriggerUSec,NextElapseUSecRealtime,NextElapseUSecMonotonic';
const exact = expected => JSON.stringify(args) === JSON.stringify(expected);
let allowed = false, body = '', code = 0;
const response = (data, status = 200) => `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}`;
const stamp = '2026-11-14T23:00:00Z';
const issue = n => ({ number: n, title: `${alias} synthetic issue ${n}`, state: 'open', updated_at: stamp, labels: [{ name: n === 42 ? 'ai-in-progress' : n === 43 ? 'ai-blocked' : 'ai-ready' }] });
if (name === 'systemctl' && [1, 2].some(slot => ['service', 'timer'].some(unit => exact(['--user', 'show', `orbi-demo@${slot}.${unit}`, properties, '--no-pager'])))) {
  allowed = true;
  if (scenario === 'unavailable' || scenario === 'stale' || (scenario === 'partial' && args[2] === 'orbi-demo@2.timer')) code = 1;
  else body = `Id=${args[2]}\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=static\nResult=success\nExecMainStatus=0\n`;
} else if (name === 'journalctl' && [1, 2].some(slot => exact(['--user', '-u', `orbi-demo@${slot}.service`, '--no-pager', '--since', '-1 hour', '-n', '200', '-o', 'json']))) {
  allowed = true; body = JSON.stringify({ ...records.journal, MESSAGE: records.journal.MESSAGE.replaceAll('22222222', '84360d31') }) + '\n';
} else if (name === 'gh' && exact(['api', '--hostname', 'github.com', '--method', 'GET', '--include', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', args[10]])) {
  const endpoint = args[10];
  const list = /^repos\/Example\/project\/issues\?state=(all|open)&sort=updated&direction=desc&per_page=100&page=([1-9]|10)$/.exec(endpoint ?? '');
  const detail = /^repos\/Example\/project\/issues\/(4[2-9]|[5-9][0-9]|1[0-5][0-9]|16[0-6])(?:(\/comments|\/dependencies\/blocked_by)\?per_page=100&page=([1-9]|10))?$/.exec(endpoint ?? '');
  const pull = endpoint === 'repos/Example/project/pulls/42';
  const checks = /^repos\/Example\/project\/commits\/a{40}\/check-runs\?per_page=100&page=([1-9]|10)$/.test(endpoint ?? '');
  allowed = !!(list || detail || pull || checks);
  if (allowed) {
    if (scenario === 'unavailable' || scenario === 'stale') { body = response({}, 401); code = 1; }
    else if (list) body = response(scenario === 'empty' || Number(list[2]) > 2 ? [] : Array.from({ length: Number(list[2]) === 1 ? 100 : 25 }, (_, i) => issue(i + (Number(list[2]) === 2 ? 142 : 42))));
    else if (detail) {
      const n = Number(detail[1]);
      if (!detail[2]) body = response(issue(n));
      else if (detail[2] === '/dependencies/blocked_by') body = scenario === 'partial' ? response({}, 500) : response([]);
      else if (scenario === 'partial') { body = response({}, 500); code = 1; }
      else body = response(Number(detail[3]) > 1 || ![42, 43].includes(n) ? [] : [{ id: 1, user: { login: 'publisher-canary' }, updated_at: stamp,
        body: '<!-- orbi:run=84360d31 -->\n<!-- orbi:comment=failure -->\n' + `<!-- orbi:failure:v1 ${JSON.stringify(guidance.failure)} -->\n` + `<!-- orbi:scene:v1 ${JSON.stringify({ ...guidance.scene, run_id: '84360d31' })} -->` }]);
    } else if (pull) body = response({ ...records.pull, number: 42, html_url: 'https://github.com/Example/project/pull/42' });
    else body = response({ check_runs: [records.check] });
  }
}

return { allowed, body, code };
}

const name = basename(process.argv[1] ?? "");
// ORBI_E2E_DELEGATED is set only by the redesign entry after it has decided its
// own argv. Default (#12) execution never sets it, so this stand-in's allowed
// and refused argv set is unchanged.
if (!process.env.ORBI_E2E_DELEGATED && ["gh", "systemctl", "journalctl"].includes(name)) {
// Ownership was acknowledged by the CJS preload before this ESM entry.
// Calls below are telemetry only, never a signaling capability.
const args = process.argv.slice(2);
const data = JSON.parse(readFileSync(process.env.ORBI_E2E_STATE, 'utf8'));
const { allowed, body, code } = operation(name, args, data);
const record = () => appendFileSync(process.env.ORBI_E2E_CALLS, JSON.stringify({ name, args, allowed, phase: 'completed', scenario: data.scenario, at: new Date().toISOString() }) + '\n');
if (!allowed) { record(); process.stderr.write('Fixture command refused: unrecognized read operation\n'); process.exit(64); }
if (data.scenario === 'late') await new Promise(resolve => setTimeout(resolve, 1800));
record(); process.stdout.write(body); process.exitCode = code;
}
