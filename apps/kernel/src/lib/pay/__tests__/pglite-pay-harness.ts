/**
 * Real two-connection concurrency harness for `pay.balances` (#2168).
 *
 * Every existing pay-service suite (e.g. `ledger.test.ts`) exercises DB-touching
 * ledger helpers against a hand-rolled fake Drizzle executor — see
 * `mock-drizzle-table.ts`. That is the right tool for pure branching logic, but a
 * fake executor can never evaluate a real SQL guard clause: it just returns
 * whatever rows the test tells it to return. Per the #2165 round-2 review, a
 * "concurrency" test built on that mock can prove a `WHERE amount >= $x` guard
 * clause *exists* in the generated query, never that a real Postgres engine
 * *enforces* it under contention — deleting the guard entirely leaves every
 * mock-based test green.
 *
 * This module boots `@electric-sql/pglite` — an embedded, WASM build of real
 * Postgres, in-process and fast (no Docker) — applies the pay-relevant migrations
 * to a throwaway instance, and hands back two independent Drizzle connections
 * over that one real engine so a test can fire concurrent statements the way two
 * pooled application connections would.
 *
 * ## Why pglite over testcontainers
 * `@electric-sql/pglite` runs Postgres in-process via WASM: no Docker, no
 * container startup latency, and (per prototyping for #2168) it still evaluates
 * row-level `WHERE` guards with real Postgres semantics — a guarded
 * `UPDATE ... WHERE amount >= $x RETURNING *` issued twice concurrently against
 * the same row reliably yields exactly one match, and removing the guard clause
 * reliably drives the balance negative. That is exactly the fidelity #2168 asks
 * for, at a fraction of testcontainers' per-test startup cost (single-digit ms to
 * apply migrations here, vs. seconds to pull/start a container), and with no new
 * CI infrastructure (Docker-in-CI) required.
 *
 * PGlite is single-connection/single-transaction under the hood (there is no
 * true multi-backend parallelism inside one WASM instance — see
 * https://github.com/electric-sql/pglite/issues/324). `connA`/`connB` below are
 * two independent Drizzle handles wrapping that one instance, modeling two
 * application-level connections/executors the way a real connection pool would
 * hand two callers separate sessions. What still makes this a meaningful
 * regression test: PGlite serializes at the *statement* level, not the
 * *call* level, so a caller that splits its sufficiency check and its debit into
 * two separate statements (the pre-#2165 TOCTOU shape — read balance, compare in
 * JS, then unconditionally debit) can still have its read and write interleave
 * with another caller's, reproducing the exact bug #2165 fixed. A caller whose
 * check-and-debit is one atomic guarded UPDATE cannot ever interleave with
 * itself, no matter how the two calls are scheduled.
 *
 * Not a `.test.ts` file, so vitest's `apps/**\/__tests__/**\/*.test.ts` include
 * glob does not pick this up as a test suite of its own.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import { balances } from '@/src/db/schemas/pay';

/**
 * The migration files (from the repo-root `migrations/` directory) that touch
 * `pay.balances` / `pay.transactions`, in apply order. `0001_seed.sql` also
 * creates every other app's schema in the same idempotent file — that's the
 * baseline seed, not pay-specific, but there is no narrower on-disk migration
 * to apply instead; the file is fast (idempotent `CREATE ... IF NOT EXISTS`,
 * no data) so applying it in full costs nothing meaningful here.
 *
 * If a future migration touches `pay.balances`/`pay.transactions`, add its
 * filename here too — this list is intentionally NOT "every migration" so a
 * throwaway test DB stays fast (see the < 30s CI budget in #2168).
 */
const PAY_RELEVANT_MIGRATIONS = [
  '0001_seed.sql',
  '0029_cad_currency_defaults.sql',
  '0030_withdrawal_requests.sql',
  '0133_pay_balance_units.sql',
  '0134_pay_balance_units_drop_legacy_columns.sql',
  // #2172 — pay.withdrawal_intents / pay.reconciliation_watermarks.
  '0141_pay_withdrawal_intents.sql',
] as const;

type PgliteLedgerSchema = { balances: typeof balances };
export type PgliteLedgerConnection = PgliteDatabase<PgliteLedgerSchema>;

export interface PgliteLedgerHarness {
  /** The underlying embedded Postgres engine (single instance, single transaction — see the module docblock). */
  client: PGlite;
  /**
   * Two independent Drizzle connections over the SAME `client`, modeling two
   * pooled application connections. Pass these directly as the `executor`
   * argument ledger helpers expect.
   */
  connA: PgliteLedgerConnection;
  connB: PgliteLedgerConnection;
  /** Insert or overwrite a `(did, unit)` balance row for a test scenario. */
  seedBalance(args: { did: string; unit: string; amount: number | string; currency?: string }): Promise<void>;
  /** Read back a single `(did, unit)` balance amount as a number (0 if the row doesn't exist), via the given connection. */
  readBalance(conn: PgliteLedgerConnection, did: string, unit: string): Promise<number>;
  /** Tear down the embedded engine. Call from `afterAll`/`afterEach`. */
  close(): Promise<void>;
}

/** Walk upward from this file to find the repo-root `migrations/` directory, independent of the test runner's cwd. */
function findRepoMigrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `pglite-pay-harness: could not locate the repo's migrations/ directory by walking up from ${import.meta.url}`,
  );
}

/**
 * Boot a throwaway `@electric-sql/pglite` instance, apply the pay-relevant
 * migrations to it, and return two connections over it. Reusable by any ledger
 * test that needs real Postgres semantics instead of a fake executor (#2168).
 */
export async function createPgliteLedgerHarness(): Promise<PgliteLedgerHarness> {
  const migrationsDir = findRepoMigrationsDir();
  const client = new PGlite({ extensions: { pgcrypto } });
  await client.waitReady;

  for (const filename of PAY_RELEVANT_MIGRATIONS) {
    const sql = readFileSync(join(migrationsDir, filename), 'utf-8');
    await client.exec(sql);
  }

  const schema: PgliteLedgerSchema = { balances };
  const connA = drizzle(client, { schema });
  const connB = drizzle(client, { schema });

  return {
    client,
    connA,
    connB,
    async seedBalance({ did, unit, amount, currency = 'CAD' }) {
      const amountStr = String(amount);
      await connA
        .insert(balances)
        .values({ did, unit, amount: amountStr, currency })
        .onConflictDoUpdate({
          target: [balances.did, balances.unit],
          set: { amount: amountStr, currency },
        });
    },
    async readBalance(conn, did, unit) {
      const rows = await conn
        .select()
        .from(balances)
        .where(and(eq(balances.did, did), eq(balances.unit, unit)))
        .limit(1);
      return rows[0] ? Number.parseFloat(rows[0].amount) : 0;
    },
    async close() {
      await client.close();
    },
  };
}
