import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'apps/**/__tests__/**/*.test.ts'],
    coverage: {
      // v8 rather than istanbul: no instrumentation step, so the suite runs at
      // close to its normal speed. Must stay major-aligned with the root vitest
      // (@vitest/coverage-v8 2.x with vitest 2.x) or the provider fails to load.
      provider: 'v8',
      // lcov is what SonarCloud ingests; text keeps the number visible in CI logs
      // so a regression is greppable without opening the dashboard.
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['apps/*/src/**/*.ts', 'apps/*/app/**/*.ts', 'packages/*/src/**/*.ts'],
      exclude: [
        // Tests describe behaviour, they are not behaviour under test.
        '**/__tests__/**',
        '**/*.test.ts',
        '**/*.d.ts',
        // Build output and generated artefacts.
        '**/dist/**',
        '**/.next/**',
        '**/node_modules/**',
      ],
    },
  },
  resolve: {
    alias: [
      // Regex form: string aliases lose the trailing slash via path.resolve,
      // so '@/src/...' collapsed to 'apps/kernelsrc/...' and only ever worked
      // for mocked imports. Anchor '@/' and re-add the separator explicitly.
      { find: /^@\//, replacement: `${resolve(__dirname, 'apps/kernel')}/` },
      { find: '@imajin/cid', replacement: resolve(__dirname, 'packages/cid/src/index.ts') },
      { find: '@imajin/config', replacement: resolve(__dirname, 'packages/config/src/index.ts') },
      { find: '@imajin/vault-core', replacement: resolve(__dirname, 'packages/vault-core/src/index.ts') },
    ],
  },
});
