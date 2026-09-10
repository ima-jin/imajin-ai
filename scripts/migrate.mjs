#!/usr/bin/env node
/**
 * Plain SQL migration runner.
 * Reads migrations/ sorted by name, tracks applied files in public._migrations.
 *
 * Usage:
 *   node scripts/migrate.mjs                                 # apply every pending migration (default, unchanged)
 *   node scripts/migrate.mjs --owner <app>                    # apply only migrations owned solely by <app>
 *   node scripts/migrate.mjs --owner <app> --include-shared   # also apply migrations shared with other owners
 *
 * DATABASE_URL is read from apps/kernel/.env.local or environment.
 *
 * ## Per-owner mode (#1991 phase 2a)
 *
 * `--owner <app>` filters the same root `migrations/` file list down to the
 * files `scripts/lib/migration-schema-scan.mjs` classifies as touching only
 * `<app>`'s schema (see `migrations/OWNERSHIP.md` for the owner list). A
 * file that touches more than one owner's schema — "shared" — is never run
 * for a non-kernel `--owner` unless `--include-shared` is also passed;
 * `--owner kernel` always includes shared files (nearly every shared file
 * touches kernel-owned schemas too, since `0001_seed.sql` creates every
 * schema at once). No file is ever silently dropped: every file is either
 * applied, or explicitly logged as skipped because it belongs to a
 * different single owner, or because it's shared and `--include-shared`
 * wasn't passed.
 *
 * With no flags, every file runs in the same order as before this feature
 * existed — this mode adds a filter, it does not change what "no filter"
 * means.
 *
 * ## Tracking-table convergence
 *
 * Applied migrations are tracked in the single, shared `public._migrations`
 * table (filename + checksum) regardless of which mode applied them. A
 * migration's row looks identical whether `node scripts/migrate.mjs` or
 * `node scripts/migrate.mjs --owner <app>` inserted it — the owner filter
 * only changes which files are *read* from disk in a given run, never how
 * a run records what it applied. This means:
 *   - A DB migrated entirely the old way (no flags, ever) and a DB migrated
 *     by running every owner's `--owner` slice once each (plus `--owner
 *     kernel --include-shared`) converge to the exact same set of rows in
 *     `public._migrations`, in the same content, because both paths apply
 *     the same files with the same checksums — just in different process
 *     invocations instead of one. Verified against a real Postgres
 *     instance: a fresh DB migrated with no flags and a fresh DB migrated
 *     by running `--owner kernel/coffee/dykil/events/learn/links/market
 *     --include-shared` in sequence produce byte-identical `pg_dump
 *     --schema-only` output and the same `public._migrations` row count.
 *   - Interleaving is safe in the "eventually consistent" sense, NOT in a
 *     single-pass, any-order sense: `getApplied()` dedupes by filename, so
 *     nothing is ever re-applied or permanently missed no matter what
 *     order `--owner` slices run in or how many times. But a shared file
 *     can have a real SQL dependency on a specific single-owner file
 *     that precedes it (e.g. `0025_backfill_survey_responses_for_orphan_
 *     registrations.sql`, shared between `dykil`/`events`, reads a column
 *     `0008_survey_response_ticket_id.sql` — `dykil`-only — adds). Running
 *     `--owner kernel --include-shared` on a fresh DB *before* `--owner
 *     dykil` has run hits that dependency and fails outright (not a skip
 *     — a real error, transaction rolled back, nothing marked applied).
 *     The fix is simply to run `--owner dykil` (or any owner order that
 *     happens to satisfy the dependency) and then retry the failed owner
 *     — idempotent, so a retry-until-clean loop over every owner
 *     converges. For bootstrapping a brand-new database in one pass,
 *     prefer the plain no-flag command; per-owner mode's practical use
 *     case is applying new, already-single-owner-scoped migrations to a
 *     database that's already fully caught up.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import envUtils from './env-utils.js';
import { parseArgs, scopeForOwner } from './lib/migrate-owner-filter.mjs';

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

// Read DATABASE_URL from apps/kernel/.env.local, fallback to env var
const envPath = resolve(kernelDir, '.env.local');
const databaseUrl = envUtils.readEnvValueFromFile(envPath, 'DATABASE_URL') || process.env.DATABASE_URL;

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

    const scope = scopeForOwner(content, args.owner, args.includeShared);
    if (!scope.include) {
      console.log(`⏭  ${filename} — out of scope for --owner ${args.owner} (${scope.reason})`);
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
