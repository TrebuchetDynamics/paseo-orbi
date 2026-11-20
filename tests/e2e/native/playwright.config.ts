import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// Native Linux Electron qualification: one worker, one owned Xvfb display, one app window.
export default defineConfig({
  testDir: '.', testMatch: ['linux.spec.ts'],
  workers: 1, fullyParallel: false, retries: 0, maxFailures: 1,
  timeout: 180000, globalTimeout: 20 * 60 * 1000, expect: { timeout: 15000 },
  globalSetup: './fixture.ts',
  // Only sanitized records and deliberate PNGs survive; no raw HAR/trace/video.
  outputDir: resolve('.artifacts/paseo-qualification-native-scratch'),
  reporter: [['list'], ['../evidence.mjs']],
  use: { trace: 'off', video: 'off', screenshot: 'off' },
  projects: [{ name: 'native-linux' }],
});
