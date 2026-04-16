#!/usr/bin/env node
/**
 * Plain SQL migration runner.
 * Reads migrations/ sorted by name, tracks applied files in public._migrations.
 *
 * Usage: node scripts/migrate.mjs
 * DATABASE_URL is read from apps/kernel/.env.local or environment.
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseDir = resolve(__dirname, '..');
const migrationsDir = resolve(baseDir, 'migrations');

// Resolve postgres from kernel's node_modules (same pattern as migrate-service.mjs)
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

async function ensureTrackingTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS public._migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
}

async function getApplied() {
  const rows = await sql`SELECT filename, checksum FROM public._migrations`;
  return new Map(rows.map(r => [r.filename, r.checksum]));
}

async function runMigrations() {
  await ensureTrackingTable();
  const applied = await getApplied();

  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let ranCount = 0;

  for (const filename of files) {
    const filePath = resolve(migrationsDir, filename);
    const content = readFileSync(filePath, 'utf-8');
    const hash = checksum(content);

    if (applied.has(filename)) {
      if (applied.get(filename) !== hash) {
        console.warn(`⚠️  ${filename} — checksum changed (skipping, DDL is idempotent)`);
      } else {
        console.log(`⏭  ${filename} — already applied`);
      }
      continue;
    }

    console.log(`▶  ${filename} — applying...`);
    await sql.begin(async tx => {
      await tx.unsafe(content);
      await tx`
        INSERT INTO public._migrations (filename, checksum)
        VALUES (${filename}, ${hash})
      `;
    });
    console.log(`✅ ${filename}`);
    ranCount++;
  }

  if (ranCount === 0) {
    console.log('✅ All migrations already applied.');
  } else {
    console.log(`✅ Applied ${ranCount} migration(s).`);
  }
}

try {
  await runMigrations();
} catch (err) {
  console.error('❌ Migration failed:', err.message ?? err);
  process.exit(1);
} finally {
  await sql.end();
}
