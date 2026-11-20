'use strict';
const fs = require('node:fs');
const { admission, hash, same, identity } = require(require('node:path').join(require('node:path').dirname(process.env.ORBI_PROCESS_CONFIG), 'process-register.cjs'));
try {
  if (!admission?.spec.native || process.platform !== 'linux' || typeof process.execve !== 'function') throw Error('Linux process.execve gate prerequisite missing');
  const { target, digest } = admission.spec.native;
  if (fs.realpathSync(target) !== target || hash(fs.readFileSync(target)) !== digest || !same(identity(process.pid), admission.identity)) throw Error('native target/identity changed');
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
  // Explicit environment; no shell/spawn and no stdout before native protocol bytes.
  process.execve(target, [target, ...process.argv.slice(2)], env);
  throw Error('execve returned');
} catch (error) { process.stderr.write(`Native exec gate refused: ${error.message}\n`); process.exit(78); }
