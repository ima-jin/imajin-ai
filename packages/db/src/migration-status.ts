/**
 * Per-app migration status (#2384). Ruled by Ryan on the #2060 posture cards
 * (#2378, option c): each app is master of its own schema, so each app's own
 * `/api/health` reports its own migration head from its own DB connection —
 * never by another service reaching into it. Kernel's aggregating
 * `/api/health` (apps/kernel/app/api/health/route.ts) calls each service's
 * own `/api/health` and relays this block verbatim; it never queries
 * another app's database directly.
 *
 * Tracking matches `scripts/migrate.mjs`: applied migrations live in the
 * shared `public._migrations` table (filename + checksum), and the full set
 * of `.sql` files under the repo-root `migrations/` directory is what a
 * deploy applies against (`scripts/migrate.mjs`'s `runMigrations()`).
 */

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type postgres from 'postgres';

/**
 * This app's own migration state. `pendingCount` is `null` (never a number
 * derived from partial data) when it can't be determined — e.g. the DB is
 * unreachable or the `migrations/` directory isn't present on this deploy —
 * so a caller never mistakes "unknown" for "caught up".
 */
export interface MigrationStatus {
  /** Filename of the most-recently-applied migration this app's DB connection can see, or `null` if none have run yet. */
  migrationHead: string | null;
  /** Count of migrations recorded as applied in `public._migrations`. */
  appliedCount: number;
  /** Count of `.sql` files under `migrations/` not yet recorded as applied, or `null` if unknown. */
  pendingCount: number | null;
  /** Present only when the check failed outright; `pendingCount` is `null` in that case. */
  error?: string;
}

/** Reads applied migration filenames from an app's own DB connection — the only allowed source (#2384: no cross-DB reads). */
export interface MigrationStatusQuerier {
  getAppliedMigrationFilenames: () => Promise<string[]>;
}

/**
 * Lists every `*.sql` file in `migrationsDir`, sorted the same way
 * `scripts/migrate.mjs`'s `runMigrations()` applies them.
 */
export function listMigrationFilenames(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
}

/**
 * Every deployed app process's `cwd` is `apps/<app>` (see
 * `deploy/ecosystem.*.config.js`), so the shared repo-root `migrations/`
 * directory every deploy applies against (`scripts/migrate.mjs`) is always
 * two levels up from an app's own working directory.
 */
export function defaultMigrationsDir(): string {
  return resolve(process.cwd(), '..', '..', 'migrations');
}

/**
 * Computes this app's own migration status. Applied state comes from
 * `querier` (this app's own DB connection only); the expected total comes
 * from a filesystem read of the shared repo-root `migrations/` directory,
 * not a database read of any kind. Never throws — either source failing
 * degrades gracefully into `pendingCount: null` (and, for a `querier`
 * failure, `appliedCount: 0`/`migrationHead: null`/`error` set) so a health
 * route can always render a response.
 */
export async function getMigrationStatus(
  querier: MigrationStatusQuerier,
  migrationsDir: string = defaultMigrationsDir(),
): Promise<MigrationStatus> {
  let applied: string[];
  try {
    applied = await querier.getAppliedMigrationFilenames();
  } catch (error) {
    return {
      migrationHead: null,
      appliedCount: 0,
      pendingCount: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  const appliedSorted = [...applied].sort();
  const migrationHead = appliedSorted.length > 0 ? appliedSorted[appliedSorted.length - 1] : null;

  let pendingCount: number | null;
  try {
    const appliedSet = new Set(applied);
    pendingCount = listMigrationFilenames(migrationsDir).filter((filename) => !appliedSet.has(filename)).length;
  } catch {
    pendingCount = null;
  }

  return { migrationHead, appliedCount: applied.length, pendingCount };
}

/**
 * Default `MigrationStatusQuerier`, backed by this app's own postgres.js
 * client (pass `getClient()`). A missing `_migrations` table is treated as
 * "nothing applied yet", not an error — a fresh, not-yet-migrated DB is a
 * valid state to report.
 */
export function createPostgresMigrationsQuerier(sql: postgres.Sql): MigrationStatusQuerier {
  return {
    async getAppliedMigrationFilenames() {
      const [{ reg }] = await sql<{ reg: string | null }[]>`SELECT to_regclass('public._migrations') AS reg`;
      if (!reg) return [];
      const rows = await sql<{ filename: string }[]>`SELECT filename FROM public._migrations`;
      return rows.map((row) => row.filename);
    },
  };
}
