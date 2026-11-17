import { configDefaults, defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.{ts,tsx}'], environment: 'node', exclude: [...configDefaults.exclude, 'tests/e2e/**'], setupFiles: ['tests/helpers/environment.ts'], testTimeout: 10000, hookTimeout: 10000 } });
