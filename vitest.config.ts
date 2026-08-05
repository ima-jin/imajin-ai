import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: [
      'packages/*/tests/**/*.test.ts',
      'apps/**/__tests__/**/*.test.ts',
      // Component tests (#1604). Each one opts into jsdom with a
      // `// @vitest-environment jsdom` docblock rather than switching the whole
      // suite: jsdom costs real setup time per file and ~1800 of these tests are
      // pure Node logic that has no use for a DOM.
      'apps/**/__tests__/**/*.test.tsx',
      'scripts/__tests__/**/*.test.mjs',
    ],
    coverage: {
      // v8 rather than istanbul: no instrumentation step, so the suite runs at
      // close to its normal speed. Must stay major-aligned with the root vitest
      // (@vitest/coverage-v8 2.x with vitest 2.x) or the provider fails to load.
      provider: 'v8',
      // lcov is what SonarCloud ingests; text keeps the number visible in CI logs
      // so a regression is greppable without opening the dashboard.
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // .tsx is included (#1604) because SonarCloud counts executable lines it
      // parses itself, not lines present in the lcov report: a component absent
      // from the report is measured as 0% covered rather than skipped. Leaving
      // .tsx out therefore capped new-code coverage on any UI change.
      include: [
        'apps/*/src/**/*.ts',
        'apps/*/src/**/*.tsx',
        'apps/*/app/**/*.ts',
        'apps/*/app/**/*.tsx',
        'packages/*/src/**/*.ts',
        'packages/*/src/**/*.tsx',
      ],
      exclude: [
        // Tests describe behaviour, they are not behaviour under test.
        '**/__tests__/**',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.d.ts',
        // Build output and generated artefacts.
        '**/dist/**',
        '**/.next/**',
        '**/node_modules/**',
      ],
    },
  },
  // The kernel tsconfig sets `jsx: "preserve"` because Next.js owns that
  // transform in the app build. Vitest has no such downstream step, so state the
  // automatic runtime explicitly rather than relying on esbuild's inference.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      // Regex form: string aliases lose the trailing slash via path.resolve,
      // so '@/src/...' collapsed to 'apps/kernelsrc/...' and only ever worked
      // for mocked imports. Anchor '@/' and re-add the separator explicitly.
      { find: /^@\//, replacement: `${resolve(__dirname, 'apps/kernel')}/` },
      // Subpath first: string aliases match by prefix, so the bare '@imajin/auth'
      // entry would otherwise swallow '@imajin/auth/scope-vocabulary' (same
      // ordering requirement as @imajin/fair/react below).
      { find: '@imajin/auth/broker-consent-vocabulary', replacement: resolve(__dirname, 'packages/auth/src/broker-consent-vocabulary.ts') },
      { find: '@imajin/auth/scope-vocabulary', replacement: resolve(__dirname, 'packages/auth/src/scope-vocabulary.ts') },
      { find: '@imajin/cid', replacement: resolve(__dirname, 'packages/cid/src/index.ts') },
      { find: '@imajin/config', replacement: resolve(__dirname, 'packages/config/src/index.ts') },
      { find: '@imajin/logger', replacement: resolve(__dirname, 'packages/logger/src/index.ts') },
      { find: '@imajin/vault-core', replacement: resolve(__dirname, 'packages/vault-core/src/index.ts') },
      { find: '@imajin/db', replacement: resolve(__dirname, 'packages/db/src/index.ts') },
      { find: '@imajin/fair/react', replacement: resolve(__dirname, 'packages/fair/src/react.ts') },
      { find: '@imajin/fair', replacement: resolve(__dirname, 'packages/fair/src/index.ts') },
      { find: '@imajin/ui/server', replacement: resolve(__dirname, 'packages/ui/src/server.ts') },
      { find: '@imajin/ui', replacement: resolve(__dirname, 'packages/ui/src/index.ts') },
      { find: '@imajin/pay/providers', replacement: resolve(__dirname, 'packages/pay/src/providers/index.ts') },
      { find: '@imajin/pay', replacement: resolve(__dirname, 'packages/pay/src/index.ts') },
    ],
  },
});
