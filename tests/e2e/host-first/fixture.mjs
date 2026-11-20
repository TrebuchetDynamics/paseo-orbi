// Redesign-only stand-in for the host Overview. It adds exactly the two fixed
// `systemctl` list argv forms the host-scoped inventory port can issue, and
// delegates every other read to the unchanged #12 stand-in. No argv is ever
// forwarded to a real binary: anything unrecognized is refused with exit 64.
import { readFileSync, appendFileSync } from 'node:fs';
import { basename } from 'node:path';

// Copied verbatim from server/read-ports.ts hostInventory(); any different argv
// (extra flag, different pattern, different verb) is refused below.
export const listArgs = {
  runtime: ['--user', 'list-units', '--all', '--type=service,timer', '--plain', '--no-legend', '--no-pager', '--full', 'orbi*.service', 'orbi*.timer'],
  installed: ['--user', 'list-unit-files', '--type=service,timer', '--no-legend', '--no-pager', '--full', 'orbi*.service', 'orbi*.timer'],
};
const exact = (args, expected) => JSON.stringify(args) === JSON.stringify(expected);
const longFamily = 'orbi-analytics-pipeline-with-a-very-long-family-name';
// Both hosts intentionally share the same family label so a host switch cannot
// carry slot identity across; the slot numbers differ per host.
const runtimeRows = {
  'host-a': [
    'orbi-demo@1.service loaded active running',
    'orbi-demo@1.timer loaded active waiting',
    'orbi-demo@2.service loaded activating start',
    'orbi-demo@2.timer loaded failed failed',
    'orbi-demo@3.service loaded active exited',
    `${longFamily}@1.service loaded active running`,
    'orbi-unclaimed@1.service loaded inactive dead',
  ],
  'host-b': [
    'orbi-demo@4.service loaded active running',
    'orbi-demo@4.timer loaded active waiting',
  ],
};
const installedRows = {
  'host-a': ['orbi-demo@.service static', 'orbi-demo@1.service static', 'orbi-demo@1.timer static',
    'orbi-demo@2.service static', 'orbi-demo@2.timer static', 'orbi-demo@3.service static',
    `${longFamily}@1.service static`, 'orbi-unclaimed@1.service static'],
  'host-b': ['orbi-demo@.service static', 'orbi-demo@4.service static', 'orbi-demo@4.timer static'],
};
function inventory(source, data) {
  // A denied installed read is the partial case: runtime facts survive, while a
  // failed source must never be published as confirmed absence.
  if (data.scenario === 'unavailable' || (data.scenario === 'denied' && source === 'installed')) return { allowed: true, body: '', code: 1 };
  if (data.scenario === 'empty') return { allowed: true, body: '', code: 0 };
  const rows = (source === 'runtime' ? runtimeRows : installedRows)[data.alias] ?? [];
  return { allowed: true, body: rows.map(row => `${row}\n`).join(''), code: 0 };
}
// Delegated reads are loaded only inside this module's own entry, with the
// standard entry point suppressed: importing the #12 tool must never run it.
let base;
async function delegate(name, args, data) {
  base ??= (await import('../fixtures/tool.mjs')).operation;
  return base(name, args, data);
}
export async function operation(name, args, data) {
  if (name === 'systemctl' && exact(args, listArgs.runtime)) return inventory('runtime', data);
  if (name === 'systemctl' && exact(args, listArgs.installed)) return inventory('installed', data);
  // Exact `show` reads remain the unchanged #12 behavior; everything else is refused.
  return delegate(name, args, data);
}

if (['gh', 'systemctl', 'journalctl'].includes(basename(process.argv[1] ?? ''))) {
  // Ownership was acknowledged by the CJS preload before this ESM entry.
  // Calls below are telemetry only, never a signaling capability.
  const name = basename(process.argv[1]), args = process.argv.slice(2);
  const data = JSON.parse(readFileSync(process.env.ORBI_E2E_STATE, 'utf8'));
  process.env.ORBI_E2E_DELEGATED = '1';
  const result = await operation(name, args, data);
  const record = () => appendFileSync(process.env.ORBI_E2E_CALLS, JSON.stringify({ name, args, allowed: result.allowed, phase: 'completed', scenario: data.scenario, at: new Date().toISOString() }) + '\n');
  if (!result.allowed) { record(); process.stderr.write('Fixture command refused: unrecognized read operation\n'); process.exit(64); }
  if (data.scenario === 'late') await new Promise(resolve => setTimeout(resolve, 1800));
  record(); process.stdout.write(result.body); process.exitCode = result.code;
}
