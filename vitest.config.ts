import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'apps/**/__tests__/**/*.test.ts'],
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
