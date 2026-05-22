import envUtils from '../../scripts/env-utils.js';

import { defineConfig } from 'drizzle-kit';

envUtils.loadEnvFileIntoProcessEnv('.env.local');
export default defineConfig({
  schema: './src/db/schemas/auth.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  schemaFilter: ['auth'],
});
