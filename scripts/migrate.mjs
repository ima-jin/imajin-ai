#!/usr/bin/env node
/**
 * Kernel SQL runner: baseline plus post-cut root migrations only.
 * Archived history is never scanned or re-executed. Existing complete ledgers
 * adopt the baseline without DDL; partial/mismatched histories fail closed.
 * Fresh databases initialize atomically from the generated baseline.
 *
 * Usage: node scripts/migrate.mjs [--owner kernel]
 * Legacy app owner filters remain parse-compatible but app migrations now live
 * in app repositories. See migrations/BASELINE.md for the cut and restore runbook.
 * Explicit DATABASE_URL takes precedence over the legacy kernel env-file fallback.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import envUtils from './env-utils.js';
import { parseArgs, scopeForOwner } from './lib/migrate-owner-filter.mjs';
import { mapSequentially } from './lib/sequential.mjs';
import { prepareKernelBaseline } from './lib/kernel-baseline.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseDir = resolve(__dirname, '..');
const migrationsDir = resolve(baseDir, 'migrations');

// CLI args are parsed and validated (scripts/lib/migrate-owner-filter.mjs)
// before touching the database, so a typo in --owner fails fast instead of
// after opening a connection.
let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`❌ migrate.mjs: ${err.message}`);
  process.exit(1);
}

// Resolve postgres from kernel's node_modules (same pattern as migrate-service.mjs)
const kernelDir = resolve(baseDir, 'apps', 'kernel');
const kernelRequire = createRequire(join(kernelDir, 'index.js'));
const postgres = kernelRequire('postgres');

// An explicit URL must win, so scratch/operator overrides never read an env file.
const envPath = resolve(kernelDir, '.env.local');
const databaseUrl = process.env.DATABASE_URL || envUtils.readEnvValueFromFile(envPath, 'DATABASE_URL');

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
  if (!args.owner || args.owner === 'kernel') {
    const manifest = JSON.parse(readFileSync(resolve(migrationsDir, 'kernel-baseline.json'), 'utf8'));
    const content = readFileSync(resolve(migrationsDir, manifest.filename), 'utf8');
    await prepareKernelBaseline(sql, manifest, content);
  }
  const applied = await getApplied();

  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let ranCount = 0;

  // Sequential on purpose: migrations must apply in filename order, each in its own transaction.
  await mapSequentially(files, async filename => {
    const filePath = resolve(migrationsDir, filename);
    const content = readFileSync(filePath, 'utf-8');
    const hash = checksum(content);

    if (applied.has(filename)) {
      if (applied.get(filename) !== hash) {
        console.warn(`⚠️  ${filename} — checksum changed (skipping, DDL is idempotent)`);
      } else {
        console.log(`⏭  ${filename} — already applied`);
      }
      return;
    }

    const scope = scopeForOwner(content, args.owner, args.includeShared);
    if (!scope.include) {
      console.log(`⏭  ${filename} — out of scope for --owner ${args.owner} (${scope.reason})`);
      return;
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
  });

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
