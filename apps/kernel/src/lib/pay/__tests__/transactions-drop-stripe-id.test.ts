/**
 * #2650 — migration 0181 drops `pay.transactions.stripe_id`, against a real embedded Postgres (pglite):
 * a fake executor can never evaluate a backfill `UPDATE`, a `DROP COLUMN` or what the engine then refuses.
 *
 * Proves, on the table as it exists AFTER 0181:
 *   - the column and `idx_transactions_stripe_id` are gone, and the ledger carries no Stripe-named column;
 *   - the re-run backfill moved every reference that only the alias held into `rail` + `external_ref`
 *     (including a row an old-code writer inserted after 0178 without `external_ref`);
 *   - the migration is idempotent (a replay on the already-dropped table changes nothing);
 *   - the engine refuses any read or write of `stripe_id` (the refusal path);
 *   - checkout, top-up and webhook completion find their rows by `external_ref` through the real
 *     writer/reader helpers and the real Drizzle schema (which would fail to select if it still named the column).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, inArray } from 'drizzle-orm';

vi.mock('@/src/db', async () => ({
  transactions: (await import('@/src/db/schemas/pay')).transactions,
}));

import { transactions } from '@/src/db/schemas/pay';
import { externalRefColumns, whereExternalRef } from '../external-ref';

// Heavy suite (embedded PGlite / seed replay): the 5000ms default is too tight on contended CI runners (#2548).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ADD_COLUMNS = '0178_pay_transactions_rail_external_ref.sql';
const DROP = '0181_pay_transactions_drop_stripe_id.sql';

function findMigrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'migrations');
    if (existsSync(join(candidate, DROP))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('could not locate migrations/ directory');
}

const migrationsDir = findMigrationsDir();
const readMigration = (name: string) => readFileSync(join(migrationsDir, name), 'utf-8');

/** A row as every pre-#2176 writer inserted it: only the Stripe-named column carries the reference. */
const INSERT_LEGACY = (id: string, type: string, status: string, stripeId: string | null, metadata: object = {}) => `
  INSERT INTO pay.transactions (id, service, type, status, to_did, amount, stripe_id, metadata)
  VALUES ('${id}', 'pay', '${type}', '${status}', 'did:imajin:to', 1, ${stripeId === null ? 'NULL' : `'${stripeId}'`}, '${JSON.stringify(metadata)}'::jsonb)`;

interface TxRow {
  id: string;
  rail: string | null;
  external_ref: string | null;
}

describe('migration 0181 — pay.transactions drops stripe_id', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let beforeDrop: Record<string, TxRow>;

  async function rows(): Promise<Record<string, TxRow>> {
    const res = await client.query<TxRow>('SELECT id, rail, external_ref FROM pay.transactions ORDER BY id');
    return Object.fromEntries(res.rows.map((r) => [r.id, r]));
  }

  beforeAll(async () => {
    client = new PGlite({ extensions: { pgcrypto } });
    await client.waitReady;
    await client.exec(readMigration('0001_seed.sql'));
    // The real Drizzle `transactions` schema selects/inserts every column, so the table must carry the
    // columns later migrations added: unit / source_kind / attestation_id (0133) ...
    // (with the same prerequisites the pay pglite harness applies first: 0029, 0030).
    for (const name of ['0029_cad_currency_defaults.sql', '0030_withdrawal_requests.sql', '0133_pay_balance_units.sql']) {
      await client.exec(readMigration(name));
    }
    // ... and 0170's pay.transactions DDL, inlined: the rest of 0170 seeds kernel.bus_chain_configs,
    // which this suite neither needs nor owns.
    await client.exec(`
      ALTER TABLE pay.transactions
        ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
        ADD COLUMN IF NOT EXISTS emission_config_id TEXT,
        ADD COLUMN IF NOT EXISTS emission_config_version INTEGER;
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_transactions_idempotency_key
        ON pay.transactions (idempotency_key) WHERE idempotency_key IS NOT NULL;`);

    // Pre-#2176 rows (only `stripe_id`), inserted BEFORE 0178 exists.
    await client.exec(INSERT_LEGACY('tx_checkout', 'checkout', 'pending', 'cs_checkout'));
    await client.exec(INSERT_LEGACY('tx_topup', 'topup', 'pending', 'cs_topup'));
    await client.exec(INSERT_LEGACY('tx_webhook', 'checkout', 'pending', 'cs_webhook'));
    await client.exec(INSERT_LEGACY('tx_withdrawal', 'withdrawal', 'completed', 'emt_ref_9', { rail: 'emt', externalRef: 'emt_ref_9' }));
    // `metadata.rail` on a non-withdrawal row is caller-supplied and must NOT become the rail.
    await client.exec(INSERT_LEGACY('tx_spoofed', 'checkout', 'pending', 'cs_spoofed', { rail: 'evil' }));
    await client.exec(INSERT_LEGACY('tx_internal', 'transfer', 'completed', null));
    await client.exec(readMigration(ADD_COLUMNS));

    // A row an OLD-code writer inserted after 0178 ran (old pods still serving during the deploy
    // window): `stripe_id` only, `external_ref` NULL. Only 0181's re-run backfill can rescue it.
    await client.exec(INSERT_LEGACY('tx_old_pod', 'checkout', 'pending', 'cs_old_pod'));
    // A post-#2176 writer's row (both set) — the backfill must leave it exactly as written.
    await client.exec(
      `INSERT INTO pay.transactions (id, service, type, to_did, amount, stripe_id, rail, external_ref)
       VALUES ('tx_new_writer', 'pay', 'topup', 'did:imajin:to', 1, 'cs_new_writer', 'stripe', 'cs_new_writer')`,
    );
    // Same ref, different rails: the rail scoping must survive the drop.
    await client.exec(
      `INSERT INTO pay.transactions (id, service, type, to_did, amount, stripe_id, rail, external_ref)
       VALUES ('tx_emt_twin', 'pay', 'withdrawal', 'did:imajin:to', 1, 'cs_checkout', 'emt', 'cs_checkout')`,
    );

    await client.exec(readMigration(DROP));
    beforeDrop = await rows();
    db = drizzle(client, { schema: { transactions } });
  });

  afterAll(async () => {
    await client.close();
  });

  describe('schema after the drop', () => {
    it('removes the stripe_id column — the ledger carries no Stripe-named column', async () => {
      const res = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'pay' AND table_name = 'transactions'`,
      );
      const cols = res.rows.map((r) => r.column_name);
      expect(cols).not.toContain('stripe_id');
      expect(cols.filter((c) => c.includes('stripe'))).toEqual([]);
      expect(cols).toEqual(expect.arrayContaining(['rail', 'external_ref']));
    });

    it('drops idx_transactions_stripe_id and keeps the (rail, external_ref) index', async () => {
      const res = await client.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'pay' AND tablename = 'transactions'`,
      );
      const byName = Object.fromEntries(res.rows.map((r) => [r.indexname, r.indexdef]));
      expect(byName.idx_transactions_stripe_id).toBeUndefined();
      expect(byName.idx_transactions_rail_external_ref).toMatch(/\(rail, external_ref\)/);
    });

    it('leaves no index mentioning stripe_id', async () => {
      const res = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = 'pay' AND tablename = 'transactions'`,
      );
      expect(res.rows.filter((r) => r.indexdef.includes('stripe_id'))).toEqual([]);
    });

    it('does not touch pay.connected_accounts (out of scope: other Stripe-named things)', async () => {
      const res = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'pay' AND table_name = 'connected_accounts'`,
      );
      expect(res.rows.map((r) => r.column_name)).toContain('stripe_account_id');
    });
  });

  describe('backfill ran first: nothing is left holding a reference only stripe_id carried', () => {
    it('keeps every reference the earlier backfill wrote', () => {
      expect(beforeDrop.tx_checkout).toEqual({ id: 'tx_checkout', rail: 'stripe', external_ref: 'cs_checkout' });
      expect(beforeDrop.tx_topup).toEqual({ id: 'tx_topup', rail: 'stripe', external_ref: 'cs_topup' });
      expect(beforeDrop.tx_webhook).toEqual({ id: 'tx_webhook', rail: 'stripe', external_ref: 'cs_webhook' });
    });

    it('rescues the row an old-code writer inserted after 0178 with only stripe_id', () => {
      expect(beforeDrop.tx_old_pod).toEqual({ id: 'tx_old_pod', rail: 'stripe', external_ref: 'cs_old_pod' });
    });

    it("keeps a withdrawal receipt's own rail and never trusts metadata.rail on other rows", () => {
      expect(beforeDrop.tx_withdrawal).toEqual({ id: 'tx_withdrawal', rail: 'emt', external_ref: 'emt_ref_9' });
      expect(beforeDrop.tx_spoofed).toEqual({ id: 'tx_spoofed', rail: 'stripe', external_ref: 'cs_spoofed' });
    });

    it('leaves rows that never had a reference NULL, and never overwrites a value a writer set', () => {
      expect(beforeDrop.tx_internal).toEqual({ id: 'tx_internal', rail: null, external_ref: null });
      expect(beforeDrop.tx_new_writer).toEqual({ id: 'tx_new_writer', rail: 'stripe', external_ref: 'cs_new_writer' });
      expect(beforeDrop.tx_emt_twin).toEqual({ id: 'tx_emt_twin', rail: 'emt', external_ref: 'cs_checkout' });
    });

    it('leaves no row that lost its reference: every row with an external_ref keeps a rail', async () => {
      const res = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pay.transactions WHERE external_ref IS NOT NULL AND rail IS NULL`,
      );
      expect(res.rows[0].n).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('a replay on the already-dropped table is a no-op (the backfill is skipped, the drops are IF EXISTS)', async () => {
      const before = await rows();
      await client.exec(readMigration(DROP));
      await client.exec(readMigration(DROP));
      expect(await rows()).toEqual(before);
    });
  });

  describe('refusal paths: the engine rejects any use of the dropped column', () => {
    it('refuses an INSERT that writes stripe_id', async () => {
      await expect(
        client.exec(
          `INSERT INTO pay.transactions (id, service, type, to_did, amount, stripe_id) VALUES ('tx_nope', 'pay', 'topup', 'did:imajin:to', 1, 'cs_nope')`,
        ),
      ).rejects.toThrow(/stripe_id/);
      expect((await rows()).tx_nope).toBeUndefined();
    });

    it('refuses a SELECT / WHERE on stripe_id (the old reader predicate)', async () => {
      await expect(client.query(`SELECT id FROM pay.transactions WHERE stripe_id = 'cs_checkout'`)).rejects.toThrow(/stripe_id/);
    });

    it('refuses the old cross-schema join key (tx.stripe_id)', async () => {
      await expect(
        client.query(`SELECT tx.id FROM pay.transactions tx WHERE tx.stripe_id = 'cs_checkout'`),
      ).rejects.toThrow(/stripe_id/);
    });
  });

  describe('flows find their rows by external_ref (real Drizzle schema + real helpers, post-drop)', () => {
    it('selecting the whole row through the Drizzle schema works (the schema no longer names stripe_id)', async () => {
      const [row] = await db.select().from(transactions).where(eq(transactions.id, 'tx_checkout')).limit(1);
      expect(row).toMatchObject({ id: 'tx_checkout', rail: 'stripe', externalRef: 'cs_checkout' });
      expect(row).not.toHaveProperty('stripeId');
    });

    it('checkout: the pending row written by the checkout writer is found by its session id', async () => {
      await db.insert(transactions).values({
        id: 'tx_new_checkout',
        service: 'events',
        type: 'ticket',
        toDid: 'did:imajin:seller',
        amount: '10',
        status: 'pending',
        ...externalRefColumns('cs_new_checkout'),
      });

      const found = await db.select({ id: transactions.id }).from(transactions).where(whereExternalRef('cs_new_checkout'));
      expect(found).toEqual([{ id: 'tx_new_checkout' }]);
    });

    it('checkout: the migrated pre-existing pending row is found by its session id, scoped to the Stripe rail', async () => {
      const stripeRows = await db.select({ id: transactions.id }).from(transactions).where(whereExternalRef('cs_checkout'));
      expect(stripeRows).toEqual([{ id: 'tx_checkout' }]);
      // The same ref on another rail never collides.
      const emtRows = await db.select({ id: transactions.id }).from(transactions).where(whereExternalRef('cs_checkout', 'emt'));
      expect(emtRows).toEqual([{ id: 'tx_emt_twin' }]);
    });

    it('top-up: the pending row from the top-up writer is found by its session id (the success-page lookup)', async () => {
      await db.insert(transactions).values({
        id: 'tx_new_topup',
        service: 'topup',
        type: 'topup',
        fromDid: 'did:imajin:buyer',
        toDid: 'did:imajin:buyer',
        amount: '25',
        status: 'pending',
        source: 'fiat',
        ...externalRefColumns('cs_new_topup'),
      });

      const [byNew] = await db.select().from(transactions).where(whereExternalRef('cs_new_topup')).limit(1);
      expect(byNew).toMatchObject({ id: 'tx_new_topup', type: 'topup', status: 'pending' });

      const [byMigrated] = await db.select().from(transactions).where(whereExternalRef('cs_topup')).limit(1);
      expect(byMigrated).toMatchObject({ id: 'tx_topup', type: 'topup' });
    });

    it('webhook completion: the idempotency lookup and the status update both key on external_ref', async () => {
      // 1) idempotency lookup: a pending row is not "already completed"
      const [before] = await db.select().from(transactions).where(whereExternalRef('cs_webhook')).limit(1);
      expect(before).toMatchObject({ id: 'tx_webhook', status: 'pending' });

      // 2) the completion update (what handleCheckoutCompleted / handlePaymentSucceeded run)
      const updated = await db
        .update(transactions)
        .set({ status: 'completed' })
        .where(whereExternalRef('cs_webhook'))
        .returning({ id: transactions.id });
      expect(updated).toEqual([{ id: 'tx_webhook' }]);

      // 3) a redelivery now sees the completed row and skips
      const [after] = await db.select().from(transactions).where(whereExternalRef('cs_webhook')).limit(1);
      expect(after?.status).toBe('completed');
    });

    it('webhook completion: the update touches only the matching row (and the old-pod row is reachable too)', async () => {
      // tx_webhook was completed above; its siblings must still be pending.
      const siblings = await db
        .select({ id: transactions.id, status: transactions.status })
        .from(transactions)
        .where(inArray(transactions.id, ['tx_checkout', 'tx_topup', 'tx_old_pod']))
        .orderBy(transactions.id);
      expect(siblings).toEqual([
        { id: 'tx_checkout', status: 'pending' },
        { id: 'tx_old_pod', status: 'pending' },
        { id: 'tx_topup', status: 'pending' },
      ]);

      // The row an old pod wrote with only stripe_id is completed via its (backfilled) external_ref.
      const updated = await db
        .update(transactions)
        .set({ status: 'completed' })
        .where(whereExternalRef('cs_old_pod'))
        .returning({ id: transactions.id });
      expect(updated).toEqual([{ id: 'tx_old_pod' }]);
    });

    it('webhook completion: an unknown reference matches nothing (no row is created or touched)', async () => {
      const updated = await db
        .update(transactions)
        .set({ status: 'completed' })
        .where(whereExternalRef('cs_does_not_exist'))
        .returning({ id: transactions.id });
      expect(updated).toEqual([]);
    });
  });
});
