#!/usr/bin/env node
/**
 * One-time script to mark all existing migrations as applied on dev/prod databases
 * that already have the full schema. Prevents 0001_seed.sql from re-running.
 *
 * Usage: node scripts/seed-migrations.mjs [--dry-run]
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseDir = resolve(__dirname, '..');
const migrationsDir = resolve(baseDir, 'migrations');

const dryRun = process.argv.includes('--dry-run');

// Resolve postgres from kernel's node_modules
const kernelDir = resolve(baseDir, 'apps', 'kernel');
const kernelRequire = createRequire(join(kernelDir, 'index.js'));
const postgres = kernelRequire('postgres');

// Read DATABASE_URL from apps/kernel/.env.local, fallback to env var
const envPath = resolve(kernelDir, '.env.local');
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
  console.error(`❌ No DATABASE_URL found in ${envPath} or environment`);
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

function checksum(content) {
  return createHash('sha256').update(content).digest('hex');
}

if (dryRun) {
  console.log('🔍 Dry run mode — no changes will be made\n');
}

try {
  // Ensure tracking table exists
  if (!dryRun) {
    await sql`
      CREATE TABLE IF NOT EXISTS public._migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT UNIQUE NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
  }

  // Get already-tracked files
  let tracked = new Set();
  try {
    const rows = await sql`SELECT filename FROM public._migrations`;
    tracked = new Set(rows.map(r => r.filename));
  } catch {
    // Table may not exist yet in dry-run mode
  }

  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let seededCount = 0;

  for (const filename of files) {
    const filePath = resolve(migrationsDir, filename);
    const content = readFileSync(filePath, 'utf-8');
    const hash = checksum(content);

    if (tracked.has(filename)) {
      console.log(`⏭  ${filename} — already tracked`);
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] would mark: ${filename} (${hash.slice(0, 8)}...)`);
    } else {
      await sql`
        INSERT INTO public._migrations (filename, checksum)
        VALUES (${filename}, ${hash})
        ON CONFLICT (filename) DO NOTHING
      `;
      console.log(`✅ Marked: ${filename}`);
    }
    seededCount++;
  }

  if (seededCount === 0) {
    console.log('✅ All migrations already tracked — nothing to do.');
  } else if (dryRun) {
    console.log(`\n🔍 Would mark ${seededCount} migration(s) as applied.`);
  } else {
    console.log(`\n✅ Seeded ${seededCount} migration(s) as applied.`);
  }
} catch (err) {
  console.error('❌ Seed failed:', err.message ?? err);
  process.exit(1);
} finally {
  await sql.end();
}
