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
        // CJS helpers that `node server.js` loads outside the Next build (#1653).
        // SonarCloud parses them as source either way, so leaving them out of the
        // report measures them as 0% covered rather than skipping them.
        'apps/*/src/**/*.js',
        'apps/*/app/**/*.ts',
        'apps/*/app/**/*.tsx',
        'packages/*/src/**/*.ts',
        'packages/*/src/**/*.tsx',
        // Shared test-utility modules (e.g. env/fetch stubbing helpers) that live
        // alongside *.test.ts under packages/*/tests/ instead of src/. Excluded
        // again below via the `**/*.test.ts` pattern — without this, SonarCloud
        // still parses their executable lines but the lcov report has no entry
        // for them, so they're measured as 0% covered rather than skipped.
        'packages/*/tests/**/*.ts',
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
      { find: '@imajin/auth/grant-scopes', replacement: resolve(__dirname, 'packages/auth/src/grant-scopes.ts') },
      { find: '@imajin/auth', replacement: resolve(__dirname, 'packages/auth/src/index.ts') },
      { find: '@imajin/chat', replacement: resolve(__dirname, 'packages/chat/src/index.ts') },
      { find: '@imajin/cid', replacement: resolve(__dirname, 'packages/cid/src/index.ts') },
      { find: '@imajin/config', replacement: resolve(__dirname, 'packages/config/src/index.ts') },
      { find: '@imajin/logger/db', replacement: resolve(__dirname, 'packages/logger/src/db.ts') },
      { find: '@imajin/logger', replacement: resolve(__dirname, 'packages/logger/src/index.ts') },
      { find: '@imajin/money', replacement: resolve(__dirname, 'packages/money/src/index.ts') },
      { find: '@imajin/vault-core', replacement: resolve(__dirname, 'packages/vault-core/src/index.ts') },
      { find: '@imajin/db', replacement: resolve(__dirname, 'packages/db/src/index.ts') },
      { find: '@imajin/fair/react', replacement: resolve(__dirname, 'packages/fair/src/react.ts') },
      { find: '@imajin/fair', replacement: resolve(__dirname, 'packages/fair/src/index.ts') },
      { find: '@imajin/ui/server', replacement: resolve(__dirname, 'packages/ui/src/server.ts') },
      { find: '@imajin/ui', replacement: resolve(__dirname, 'packages/ui/src/index.ts') },
      { find: '@imajin/pay/providers', replacement: resolve(__dirname, 'packages/pay/src/providers/index.ts') },
      { find: '@imajin/pay', replacement: resolve(__dirname, 'packages/pay/src/index.ts') },
      // #1011 phase 2 (#2142): newly built packages, same rationale as above —
      // vitest runs before build in CI, so every package that now ships a
      // real dist build needs to be aliased straight to source for tests.
      { find: '@imajin/bus', replacement: resolve(__dirname, 'packages/bus/src/index.ts') },
      { find: '@imajin/claw-provisioner', replacement: resolve(__dirname, 'packages/claw-provisioner/src/index.ts') },
      { find: '@imajin/claw-envelope', replacement: resolve(__dirname, 'packages/claw-envelope/src/index.ts') },
      { find: '@imajin/dfos', replacement: resolve(__dirname, 'packages/dfos/src/index.ts') },
      { find: '@imajin/emit', replacement: resolve(__dirname, 'packages/emit/src/index.ts') },
      { find: '@imajin/input', replacement: resolve(__dirname, 'packages/input/src/index.ts') },
      { find: '@imajin/llm', replacement: resolve(__dirname, 'packages/llm/src/index.ts') },
      { find: '@imajin/media', replacement: resolve(__dirname, 'packages/media/src/index.ts') },
      { find: '@imajin/nanoclaw-imajin-channel', replacement: resolve(__dirname, 'packages/nanoclaw-imajin-channel/src/index.ts') },
      { find: '@imajin/notify', replacement: resolve(__dirname, 'packages/notify/src/index.ts') },
      { find: '@imajin/onboard', replacement: resolve(__dirname, 'packages/onboard/src/index.tsx') },
      { find: '@imajin/trust-graph', replacement: resolve(__dirname, 'packages/trust-graph/src/index.ts') },
      { find: '@imajin/usage-emitter-claude-code', replacement: resolve(__dirname, 'packages/usage-emitter-claude-code/src/index.ts') },
    ],
  },
});
