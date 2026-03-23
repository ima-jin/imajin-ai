import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: ['./src/db/schema.ts', './src/db/relay-schema.ts'],
  out: './drizzle',
  dialect: 'postgresql',
  schemaFilter: ['registry', 'relay'],
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
