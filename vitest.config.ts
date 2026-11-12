import { defineConfig } from 'vitest/config';

// Most files launch real Chromium. Running one per core starves the browsers
// and trips product deadlines such as the two-second page inspection limit.
export default defineConfig({ test: { include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'], testTimeout: 30000, maxWorkers: 6 } });
