import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// Separate opt-in configuration: the #12 browser lane and its 42-case matrix are
// untouched, and ordinary CI only imports declarations.
export default defineConfig({
  testDir: '.', testMatch: ['overview.spec.ts'],
  workers: 1, fullyParallel: false, retries: 0, maxFailures: 1,
  timeout: 180000, globalTimeout: 20 * 60 * 1000, expect: { timeout: 15000 },
  globalSetup: './harness.ts',
  outputDir: resolve('.artifacts/paseo-host-first-scratch'),
  reporter: [['list'], ['../evidence.mjs']],
  use: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, trace: 'off', video: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
