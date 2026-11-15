import type { RunEvent } from '../shared/runs';
import type { Problem } from '../shared/common';

// A bounded journal window is partial evidence, never an assertion of continuity.
export function projectEvents(text: string, scope: { unit: string; repo: string; issue: number; runId: string; retained: boolean }) {
  const events: RunEvent[] = [];
  const problems: Problem[] = [{ source: 'journal', code: 'incomplete' }];
  const omit = () => { if (!problems.some(p => p.code === 'invalid_response')) problems.push({ source: 'journal', code: 'invalid_response' }); };
  let bytes = 2;
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (Buffer.byteLength(line) > 65536) { problems.push({ source: 'journal', code: 'read_limit' }); continue; }
    try {
      const record = JSON.parse(line);
      // journalctl emits flat JSON. Reject duplicate (including escaped-key)
      // attribution fields before JSON.parse's last-key-wins could hide them.
      const keys = [...line.matchAll(/"(?:[^"\\]|\\.)*"/g)].filter(token => line.slice(token.index! + token[0].length).trimStart().startsWith(':')).map(token => JSON.parse(token[0]));
      if (['MESSAGE', '_SYSTEMD_USER_UNIT', '__REALTIME_TIMESTAMP'].some(key => keys.filter(candidate => candidate === key).length !== 1)) { omit(); continue; }
      if (record._SYSTEMD_USER_UNIT !== scope.unit) continue;
      if (typeof record.MESSAGE !== 'string' || typeof record.__REALTIME_TIMESTAMP !== 'string' || !/^[0-9]{1,19}$/.test(record.__REALTIME_TIMESTAMP)) { omit(); continue; }
      const message = record.MESSAGE.match(/^(?:DEBUG|INFO|WARNING|ERROR|CRITICAL) \[([0-9a-f]{8})\] (run_start|run_end|worktree_cleaned|worktree_retained) (.+)$/);
      if (!message || message[1] !== scope.runId || (message[2] === 'worktree_retained' && !scope.retained)) continue;
      // Consume the entire field sequence. No free-text suffix, duplicate keys,
      // ambiguous quoting, or extraction of fields from within quoted values.
      const fields = new Map<string, string>();
      let rest = message[3];
      while (rest) {
        const token = rest.match(/^([a-z][a-z0-9_]*)=("(?:[^"\\\r\n]|\\[^\r\n])*"|[^\s"\\]+)(?: |$)/);
        if (!token || fields.has(token[1])) throw new Error('invalid');
        fields.set(token[1], token[2]); rest = rest.slice(token[0].length);
      }
      const lifecycle = message[2] === 'run_start' || message[2] === 'run_end';
      const key = lifecycle ? 'run' : 'run_id';
      if (fields.has(lifecycle ? 'run_id' : 'run') || fields.get(key) !== scope.runId || fields.get('issue') !== (lifecycle ? `${scope.repo}#${scope.issue}` : String(scope.issue))) { omit(); continue; }
      const millis = Number(BigInt(record.__REALTIME_TIMESTAMP) / 1000n);
      const at = new Date(millis).toISOString();
      const event: RunEvent = { at, event: message[2] as RunEvent['event'], runId: scope.runId, issue: scope.issue };
      const size = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (events.length === 200 || bytes + size > 65536) { problems.push({ source: 'journal', code: 'read_limit' }); break; }
      events.push(event); bytes += size;
    } catch { omit(); }
  }
  return { events, problems };
}
