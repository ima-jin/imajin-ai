import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'apps/**/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@/': resolve(__dirname, 'apps/kernel/'),
      '@imajin/cid': resolve(__dirname, 'packages/cid/src/index.ts'),
      '@imajin/vault-core': resolve(__dirname, 'packages/vault-core/src/index.ts'),
    },
  },
});
