#!/usr/bin/env node
/**
 * Programmatic drizzle migrator with per-service migration tables.
 *
 * Usage: node scripts/migrate-service.mjs <app-name>
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = process.argv[2];
  if (!app) {
    console.error('Usage: node scripts/migrate-service.mjs <app-name>');
    process.exit(1);
  }

  const baseDir = resolve(__dirname, '..');
  const appDir = resolve(baseDir, 'apps', app);
  const migrationsFolder = resolve(appDir, 'drizzle');

  // Read DATABASE_URL from .env.local
  const envPath = resolve(appDir, '.env.local');
  let databaseUrl;
  try {
    const envContent = readFileSync(envPath, 'utf-8');
    const match = envContent.match(/^DATABASE_URL=["']?(.+?)["']?\s*$/m);
    databaseUrl = match?.[1];
  } catch {
    // fall through
  }

  databaseUrl = databaseUrl || process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error(`❌ ${app} — no DATABASE_URL found in ${envPath} or environment`);
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  try {
    console.log(`=== Migrating ${app} ===`);
    await migrate(db, {
      migrationsFolder,
      migrationsTable: `__drizzle_migrations_${app}`,
      migrationsSchema: 'drizzle',
    });
    console.log(`✅ ${app}`);
  } catch (err) {
    console.error(`❌ ${app} — migration failed`);
    console.error(err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
