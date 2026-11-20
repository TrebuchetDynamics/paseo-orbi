'use strict';
// Trusted pinned-code isolation, not a same-UID security boundary.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isMainThread } = require('node:worker_threads');
const now = () => Number(process.hrtime.bigint()) / 1e6;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function read(file, limit) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > limit) throw Error('nonregular/oversized registration storage'); const bytes = Buffer.alloc(limit + 1); const size = fs.readSync(fd, bytes, 0, bytes.length, 0); if (size > limit) throw Error('registration overflow'); return bytes.subarray(0, size).toString(); }
  finally { fs.closeSync(fd); }
}
function identity(pid) {
  const text = read(`/proc/${pid}/stat`, 4096), fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  if (['Z', 'X', 'x'].includes(fields[0])) throw Error('dead process');
  return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19] };
}
const same = (a, b) => a && b && a.pid === b.pid && a.start === b.start && a.pgid === b.pgid;
function publish(file, bytes) {
  // Slot ownership bounds temporary files to one per record/control publisher.
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try { fs.linkSync(temporary, file); }
  catch (error) { if (error.code !== 'EEXIST' || read(file, 4096) !== bytes) throw Error('conflicting publication'); }
  finally { fs.unlinkSync(temporary); }
}
function fail(directory, reason) {
  try { fs.writeFileSync(path.join(directory, 'failure'), String(reason).slice(0, 512), { flag: 'wx', mode: 0o600 }); } catch { /* sticky first failure */ }
}
function phaseDeadline(config) {
  const control = JSON.parse(read(path.join(config.directory, 'control'), 1024));
  if (control.session !== config.session || !['startup', 'running', 'shutdown'].includes(control.phase) || !Number.isFinite(control.deadline)) throw Error('invalid phase control');
  return control.deadline;
}
function psArguments(parent, args) {
  const exact = value => JSON.stringify(args) === JSON.stringify(value);
  if (['daemon', 'terminal-worker'].includes(parent) && args.length === 7 && args[0] === '-ww' && args[1] === '-p' && /^[1-9][0-9]*$/.test(args[2]) && exact(['-ww', '-p', args[2], '-o', 'lstart=', '-o', 'command='])) return true;
  return parent === 'terminal-worker' && exact(['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'sid=', '-o', 'lstart=']);
}
function argsMatch(spec, args, config) {
  if (Array.isArray(spec.args)) return JSON.stringify(args) === JSON.stringify(spec.args);
  if (spec.args === 'fixture') return args.length <= 16 && args.every(a => a.length <= 1024); // operation itself is closed in tool.mjs
  if (spec.args === 'ps') return psArguments('terminal-worker', args); // collector binds actual parent
  if (spec.args === 'launcher' || spec.args === 'worker') {
    const launcher = spec.args === 'launcher';
    const id = args[launcher ? 2 : 1];
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id ?? '') && JSON.stringify(args) === JSON.stringify([...(launcher ? ['--launch', '--record-id'] : ['--paseo-terminal-worker']), id, '--paseo-home', config.home, '--paseo-version', '0.15.4', '--runtime', config.runtime]);
  }
  return false;
}
function classify(config, entry, args, nodeArgs) {
  const matches = config.specs.filter(spec => spec.entry === entry && argsMatch(spec, args, config) && JSON.stringify(spec.nodeArgs ?? []) === JSON.stringify(nodeArgs));
  if (matches.length !== 1) throw Error('unrecognized role/entry/argv');
  return matches[0];
}
function register() {
  const config = JSON.parse(read(process.env.ORBI_PROCESS_CONFIG, 65536));
  const directory = config.directory;
  try {
    const initial = identity(process.pid), parent = identity(initial.ppid);
    const entry = path.resolve(process.argv[1] ?? '');
    const spec = classify(config, entry, process.argv.slice(2), process.execArgv);
    if (hash(fs.readFileSync(entry)) !== spec.digest) throw Error('entry content mismatch');
    // buildSelfNodeCommand strips this runtime control key. Restore before application
    // entry so compiler threads (even execArgv: []) and descendants inherit the gate.
    if (config.esbuild) process.env.ESBUILD_BINARY_PATH = config.esbuild;
    const created = now(), deadline = created + 5000;
    const record = { session: config.session, identity: initial, parent, role: spec.role, entry, native: spec.native ?? null, nonce: crypto.randomBytes(16).toString('hex'), created, deadline };
    const bytes = JSON.stringify(record);
    if (Buffer.byteLength(bytes) > 4096) throw Error('record overflow');
    let slot;
    for (let n = 0; n < 256; n++) {
      const name = path.join(directory, `slot-${n}`);
      try { fs.mkdirSync(name, { mode: 0o700 }); slot = name; break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (!slot) throw Error('registration capacity exhausted');
    publish(path.join(slot, 'request'), bytes);
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (now() < Math.min(deadline, phaseDeadline(config))) {
      if (fs.existsSync(path.join(directory, 'failure'))) throw Error('collector denied admission');
      if (!same(config.collector, identity(config.collector.pid))) throw Error('collector died/reused');
      let ack;
      try { ack = JSON.parse(read(path.join(slot, 'ack'), 4096)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (ack) {
        if (ack.session !== config.session || ack.nonce !== record.nonce || ack.digest !== hash(bytes) || !same(ack.identity, initial)) throw Error('ack nonce/digest/identity mismatch');
        if (now() >= Math.min(deadline, phaseDeadline(config)) || !same(initial, identity(process.pid))) throw Error('ack deadline/identity mismatch');
        return { config, spec, identity: initial };
      }
      Atomics.wait(wait, 0, 0, Math.min(10, Math.max(1, Math.min(deadline, phaseDeadline(config)) - now())));
    }
    throw Error('five-second/phase admission deadline exceeded');
  } catch (error) { fail(directory, error.message); throw error; }
}
module.exports = { now, hash, read, identity, same, publish, fail, classify, argsMatch, psArguments, phaseDeadline };
// No exit, cleanup, publication or wait in a compiler worker thread.
if (isMainThread && module.parent?.id === 'internal/preload') {
  try { module.exports.admission = register(); }
  catch (error) { process.stderr.write(`Process registration refused: ${error.message}\n`); process.exit(78); }
}
