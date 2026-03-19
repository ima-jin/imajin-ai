#!/usr/bin/env tsx
/**
 * Programmatic drizzle migrator with per-service migration tables.
 *
 * All services share one Postgres database (imajin_prod / imajin_dev),
 * so each service needs its own migration tracking table to avoid
 * drizzle thinking migrations are already applied when they aren't.
 *
 * Usage: tsx scripts/migrate-service.ts <app-name>
 *   e.g. tsx scripts/migrate-service.ts events
 *
 * Reads DATABASE_URL from apps/<app>/.env.local
 * Migrations from apps/<app>/drizzle/
 * Tracks in drizzle.__drizzle_migrations_<app>
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main() {
  const app = process.argv[2];
  if (!app) {
    console.error('Usage: tsx scripts/migrate-service.ts <app-name>');
    process.exit(1);
  }

  const scriptDir = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
  const baseDir = resolve(scriptDir, '..');
  const appDir = resolve(baseDir, 'apps', app);
  const migrationsFolder = resolve(appDir, 'drizzle');

  // Read DATABASE_URL from .env.local
  const envPath = resolve(appDir, '.env.local');
  let databaseUrl: string | undefined;
  try {
    const envContent = readFileSync(envPath, 'utf-8');
    const match = envContent.match(/^DATABASE_URL=["']?(.+?)["']?\s*$/m);
    databaseUrl = match?.[1];
  } catch {
    // fall through — check env
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
