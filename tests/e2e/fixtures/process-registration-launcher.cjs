'use strict';
// Only disposable synthetic applications. Each edge uses the production role graph.
const { spawn, fork } = require('node:child_process');
const fs = require('node:fs');
const role = process.argv[2];
const next = { root: 'supervisor', supervisor: 'daemon', daemon: 'terminal-launcher' }[role];
if (role === 'collector-exit') {
  const protocol = require('./process-register.cjs');
  const configPath = process.env.ORBI_TEST_PROCESS_CONFIG;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.collector = protocol.identity(process.pid);
  fs.chmodSync(configPath, 0o600); fs.writeFileSync(configPath, JSON.stringify(config));
  const env = { ...process.env, ORBI_PROCESS_CONFIG: configPath, NODE_OPTIONS: `--require=${require('node:path').join(config.directory, 'process-register.cjs')}` };
  delete env.ORBI_TEST_PROCESS_CONFIG;
  const child = spawn(process.execPath, [process.env.ORBI_TEST_WORKER], { env, detached: true, stdio: ['ignore', 'ignore', fs.openSync(process.env.ORBI_TEST_ERROR, 'w')] });
  fs.writeFileSync(process.env.ORBI_TEST_CHILD, String(child.pid));
  child.unref(); process.exit(0);
} else if (role === 'daemon' && process.env.ORBI_TEST_FANOUT) {
  const count = Number(process.env.ORBI_TEST_FANOUT);
  if (!Number.isInteger(count) || count < 1 || count > 16) process.exit(64);
  const children = [];
  let ready = 0;
  for (let n = 0; n < count; n++) {
    const child = fork(process.env.ORBI_TEST_WORKER, [], { env: process.env, detached: true, execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.push(child.pid);
    child.once('message', () => { child.disconnect(); child.unref(); if (++ready === count) process.exit(0); });
  }
  fs.writeFileSync(process.env.ORBI_TEST_CHILD, JSON.stringify(children));
  setTimeout(() => process.exit(79), 8000).unref();
} else if (next) {
  const child = spawn(process.execPath, [__filename, next], { env: process.env, stdio: ['ignore', 'ignore', 'inherit'] });
  child.once('exit', () => process.exit(0));
} else if (role === 'terminal-launcher') {
  const child = spawn(process.execPath, [process.env.ORBI_TEST_WORKER], { env: process.env, detached: true, stdio: ['ignore', 'ignore', 'inherit', 'pipe'] });
  // Store directly observed PID for independent finally cleanup, never for ledger authority.
  fs.writeFileSync(process.env.ORBI_TEST_CHILD, String(child.pid));
  if (process.env.ORBI_TEST_PARENT_EARLY_EXIT === '1') process.exit(0);
  child.stdio[3].once('data', () => { child.stdio[3].destroy(); child.unref(); process.exit(0); });
  setTimeout(() => process.exit(79), 8000).unref();
} else process.exit(64);
