/**
 * #2176 — `rail` + `external_ref` on `pay.transactions` (migration 0177), against a real embedded
 * Postgres (pglite): a fake executor can never evaluate `ADD COLUMN IF NOT EXISTS`, a backfill
 * `UPDATE` or an index, which is the point of this suite.
 *
 * Also pins the two helpers every reader/writer goes through (`external-ref.ts`):
 *   - `externalRefColumns` — dual-write: `rail`, `external_ref` and the deprecated `stripe_id` alias agree;
 *   - `whereExternalRef`   — readers key on `external_ref` (with `rail`, matching the index) and never `stripe_id`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

vi.mock('@/src/db', async () => ({
  transactions: (await import('@/src/db/schemas/pay')).transactions,
}));

import { STRIPE_RAIL, externalRefColumns, whereExternalRef } from '../external-ref';

// Heavy suite (embedded PGlite / seed replay): the 5000ms default is too tight on contended CI runners (#2548).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const MIGRATION = '0177_pay_transactions_rail_external_ref.sql';

function findMigrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'migrations');
    if (existsSync(join(candidate, MIGRATION))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('could not locate migrations/ directory');
}

const migrationsDir = findMigrationsDir();
const readMigration = (name: string) => readFileSync(join(migrationsDir, name), 'utf-8');

const INSERT_LEGACY = (id: string, type: string, stripeId: string | null, metadata: object = {}) => `
  INSERT INTO pay.transactions (id, service, type, to_did, amount, stripe_id, metadata)
  VALUES ('${id}', 'pay', '${type}', 'did:imajin:to', 1, ${stripeId === null ? 'NULL' : `'${stripeId}'`}, '${JSON.stringify(metadata)}'::jsonb)`;

interface TxRow {
  id: string;
  rail: string | null;
  external_ref: string | null;
  stripe_id: string | null;
}

describe('migration 0177 — pay.transactions rail + external_ref', () => {
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite({ extensions: { pgcrypto } });
    await client.waitReady;
    await client.exec(readMigration('0001_seed.sql'));
    // Pre-#2176 rows, inserted BEFORE the migration exists.
    await client.exec(INSERT_LEGACY('tx_checkout', 'checkout', 'cs_1'));
    await client.exec(INSERT_LEGACY('tx_topup', 'topup', 'pi_1'));
    await client.exec(INSERT_LEGACY('tx_withdrawal', 'withdrawal', 'emt_ref_9', { rail: 'emt', externalRef: 'emt_ref_9' }));
    // `metadata.rail` on a non-withdrawal row is caller-supplied and must NOT become the rail.
    await client.exec(INSERT_LEGACY('tx_spoofed', 'checkout', 'cs_2', { rail: 'evil' }));
    await client.exec(INSERT_LEGACY('tx_internal', 'transfer', null));
    await client.exec(readMigration(MIGRATION));
  });

  afterAll(async () => {
    await client.close();
  });

  async function rows(): Promise<Record<string, TxRow>> {
    const res = await client.query<TxRow>('SELECT id, rail, external_ref, stripe_id FROM pay.transactions ORDER BY id');
    return Object.fromEntries(res.rows.map((r) => [r.id, r]));
  }

  it('adds nullable text columns `rail` and `external_ref`', async () => {
    const res = await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'pay' AND table_name = 'transactions' AND column_name IN ('rail', 'external_ref')
        ORDER BY column_name`,
    );
    expect(res.rows).toEqual([
      { column_name: 'external_ref', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'rail', data_type: 'text', is_nullable: 'YES' },
    ]);
  });

  it("backfills rail='stripe' and external_ref=stripe_id on every row that has a stripe_id", async () => {
    const r = await rows();
    expect(r.tx_checkout).toMatchObject({ rail: 'stripe', external_ref: 'cs_1', stripe_id: 'cs_1' });
    expect(r.tx_topup).toMatchObject({ rail: 'stripe', external_ref: 'pi_1', stripe_id: 'pi_1' });
  });

  it("keeps a withdrawal receipt's own rail (metadata.rail) but ignores metadata.rail on other row types", async () => {
    const r = await rows();
    expect(r.tx_withdrawal).toMatchObject({ rail: 'emt', external_ref: 'emt_ref_9' });
    expect(r.tx_spoofed).toMatchObject({ rail: 'stripe', external_ref: 'cs_2' });
  });

  it('leaves rows with no stripe_id (no external reference) NULL', async () => {
    expect((await rows()).tx_internal).toEqual({ id: 'tx_internal', rail: null, external_ref: null, stripe_id: null });
  });

  it('creates a (rail, external_ref) index and keeps the stripe_id alias index', async () => {
    const res = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'pay' AND tablename = 'transactions'`,
    );
    const byName = Object.fromEntries(res.rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.idx_transactions_rail_external_ref).toMatch(/\(rail, external_ref\)/);
    expect(byName.idx_transactions_stripe_id).toBeDefined();
  });

  it('is idempotent and never overwrites a value a writer has since set', async () => {
    // A post-#2176 writer's row (dual-written) — a re-run must leave it exactly as written.
    await client.exec(
      `INSERT INTO pay.transactions (id, service, type, to_did, amount, stripe_id, rail, external_ref)
       VALUES ('tx_new_writer', 'pay', 'topup', 'did:imajin:to', 1, 'cs_9', 'stripe', 'cs_9')`,
    );
    const before = await rows();

    await client.exec(readMigration(MIGRATION));
    await client.exec(readMigration(MIGRATION));

    expect(await rows()).toEqual(before);
  });

  it('does not touch pay.connected_accounts — it stays Stripe-shaped (ruling: option c)', async () => {
    const res = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'pay' AND table_name = 'connected_accounts' ORDER BY column_name`,
    );
    const cols = res.rows.map((r) => r.column_name);
    expect(cols).toContain('stripe_account_id');
    expect(cols).not.toContain('rail');
    expect(cols).not.toContain('external_ref');
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'pay' AND table_name = 'payout_accounts'`,
    );
    expect(tables.rows).toEqual([]);
  });

  describe('whereExternalRef (the reader predicate), evaluated against the migrated table', () => {
    async function find(ref: string, rail?: string): Promise<string[]> {
      const q = new PgDialect().sqlToQuery(sql`SELECT id FROM pay.transactions WHERE ${whereExternalRef(ref, rail)} ORDER BY id`);
      const res = await client.query<{ id: string }>(q.sql, q.params);
      return res.rows.map((r) => r.id);
    }

    it('matches on external_ref', async () => {
      expect(await find('cs_1')).toEqual(['tx_checkout']);
      expect(await find('pi_1')).toEqual(['tx_topup']);
    });

    it('does NOT match a row whose only match is the deprecated stripe_id alias', async () => {
      await client.exec(
        `INSERT INTO pay.transactions (id, service, type, to_did, amount, stripe_id) VALUES ('tx_alias_only', 'pay', 'topup', 'did:imajin:to', 1, 'cs_alias_only')`,
      );
      expect(await find('cs_alias_only')).toEqual([]);
    });

    it("scopes to the rail (default 'stripe'), so another rail's identical ref never collides", async () => {
      expect(await find('emt_ref_9')).toEqual([]);
      expect(await find('emt_ref_9', 'emt')).toEqual(['tx_withdrawal']);
    });

    it('renders against external_ref + rail, never stripe_id', () => {
      const q = new PgDialect().sqlToQuery(sql`${whereExternalRef('cs_1')}`);
      expect(q.sql).toContain('"external_ref"');
      expect(q.sql).toContain('"rail"');
      expect(q.sql).not.toContain('stripe_id');
      expect(q.params).toEqual([STRIPE_RAIL, 'cs_1']);
    });
  });
});

describe('externalRefColumns (the dual-write)', () => {
  it('writes rail, external_ref and the deprecated stripe_id alias together, defaulting to the stripe rail', () => {
    expect(externalRefColumns('cs_1')).toEqual({ rail: 'stripe', externalRef: 'cs_1', stripeId: 'cs_1' });
  });

  it('carries a non-Stripe rail name through with the same ref in both columns', () => {
    expect(externalRefColumns('emt_ref_9', 'emt')).toEqual({ rail: 'emt', externalRef: 'emt_ref_9', stripeId: 'emt_ref_9' });
  });
});
