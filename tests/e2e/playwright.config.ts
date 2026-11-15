import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: '.', testMatch: ['paseo-orbi.spec.ts', 'screenshots.spec.ts'],
  workers: 1, fullyParallel: false, retries: 0, maxFailures: 1,
  timeout: 120000, globalTimeout: 20 * 60 * 1000, expect: { timeout: 10000 },
  globalSetup: './harness.ts',
  // Only sanitized records and deliberate PNGs survive; no raw HAR/trace/video.
  outputDir: resolve('.artifacts/paseo-qualification-scratch'),
  reporter: [['list'], ['./evidence.mjs']],
  use: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, trace: 'off', video: 'off', screenshot: 'off' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', testMatch: 'paseo-orbi.spec.ts', grep: /\[smoke\]/, use: { browserName: 'firefox' } },
    { name: 'webkit', testMatch: 'paseo-orbi.spec.ts', grep: /\[smoke\]/, use: { browserName: 'webkit' } },
  ],
});
