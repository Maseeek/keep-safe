import { defineConfig } from 'vitest/config';

// Most files launch real Chromium. Running one per core starves the browsers
// and trips product deadlines such as the two-second page inspection limit.
// Tests use the hidden bundled browser, so a run never opens windows on the
// desktop. KEEP_SAFE_BROWSER=chrome runs the same tests in installed Chrome.
export default defineConfig({ test: { include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'], testTimeout: 30000, maxWorkers: 6, env: { KEEP_SAFE_BROWSER: process.env.KEEP_SAFE_BROWSER ?? 'bundled' } } });
