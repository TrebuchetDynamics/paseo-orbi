'use strict';
const fs = require('node:fs');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
if (!isMainThread) {
  fs.appendFileSync(process.env.ORBI_TEST_MARKER, 'thread\n');
  parentPort.postMessage(process.env.ESBUILD_BINARY_PATH ?? 'thread');
} else {
  fs.appendFileSync(process.env.ORBI_TEST_MARKER, 'application\n');
  if (process.env.ORBI_TEST_RESIST === '1') process.on('SIGTERM', () => {});
  if (process.send) process.send({ pid: process.pid });
  // FD3 is intentionally a readiness descriptor: the in-place preload must preserve it.
  try { if (!process.send) fs.writeSync(3, `${process.pid}\n`); } catch { /* direct root launch */ }
  const worker = new Worker(__filename, { execArgv: process.env.ORBI_TEST_THREAD_PRELOAD === '1' ? ['--require', process.env.ORBI_TEST_PRELOAD] : [] });
  worker.once('message', value => { if (process.env.ORBI_TEST_THREAD_RESULT) fs.writeFileSync(process.env.ORBI_TEST_THREAD_RESULT, String(value)); });
  setInterval(() => {}, 1000);
}
