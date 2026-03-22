import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 30000,
    env: {
      DATABASE_URL: process.env.DATABASE_URL_PROD?.replace(/^"|"$/g, '') ?? '',
      NEXT_PUBLIC_DISABLE_INVITE_GATE: 'true',
      CONNECTIONS_SERVICE_URL: 'http://connections.test',
      PROFILE_SERVICE_URL: 'http://profile.test',
    },
  },
  resolve: {
    alias: {
      '@/': path.resolve(__dirname, './') + '/',
    },
  },
});
