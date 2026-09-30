/**
 * Migration 0168 (#2421): `subtotal_amount` / `tax_total_amount` on
 * `pay.payment_request`, against a real embedded Postgres (pglite) — a
 * fake executor can never evaluate `ADD COLUMN IF NOT EXISTS` or a backfill
 * `UPDATE`, which is the whole point of this suite.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

function findMigrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'migrations');
    if (existsSync(join(candidate, '0168_pay_payment_request_tax_amounts.sql'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('could not locate migrations/ directory');
}

const migrationsDir = findMigrationsDir();
const readMigration = (name: string) => readFileSync(join(migrationsDir, name), 'utf-8');

const INSERT_LEGACY = (id: string, total: number) => `
  INSERT INTO pay.payment_request
    (id, issuer_did, payee_account, recipient_did, line_items, total_amount, fair_manifest, content_hash)
  VALUES
    ('${id}', 'did:imajin:issuer', 'did:imajin:issuer', 'did:imajin:payer', '[]'::jsonb, ${total}, '{}'::jsonb, 'hash')`;

describe('migration 0168 — payment_request subtotal/tax_total', () => {
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite({ extensions: { pgcrypto } });
    await client.waitReady;
    await client.exec(readMigration('0001_seed.sql'));
    await client.exec(readMigration('0143_pay_payment_requests.sql'));
    // Two pre-tax-era rows, inserted BEFORE the migration exists.
    await client.exec(INSERT_LEGACY('pr_legacy_1', 12_345));
    await client.exec(INSERT_LEGACY('pr_legacy_2', 500));
    await client.exec(readMigration('0168_pay_payment_request_tax_amounts.sql'));
  });

  afterAll(async () => {
    await client.close();
  });

  async function rows() {
    const res = await client.query<{ id: string; total_amount: number; subtotal_amount: number; tax_total_amount: number }>(
      'SELECT id, total_amount, subtotal_amount, tax_total_amount FROM pay.payment_request ORDER BY id',
    );
    return res.rows;
  }

  it('backfills legacy rows with subtotal = total and tax_total = 0', async () => {
    expect(await rows()).toEqual([
      { id: 'pr_legacy_1', total_amount: 12_345, subtotal_amount: 12_345, tax_total_amount: 0 },
      { id: 'pr_legacy_2', total_amount: 500, subtotal_amount: 500, tax_total_amount: 0 },
    ]);
  });

  it('is idempotent and never overwrites a row that already carries tax', async () => {
    await client.exec(`
      INSERT INTO pay.payment_request
        (id, issuer_did, payee_account, recipient_did, line_items, total_amount, subtotal_amount, tax_total_amount, fair_manifest, content_hash)
      VALUES ('pr_taxed', 'a', 'a', 'b', '[]'::jsonb, 11300, 10000, 1300, '{}'::jsonb, 'h')`);

    await client.exec(readMigration('0168_pay_payment_request_tax_amounts.sql'));

    const taxed = (await rows()).find((r) => r.id === 'pr_taxed');
    expect(taxed).toEqual({ id: 'pr_taxed', total_amount: 11_300, subtotal_amount: 10_000, tax_total_amount: 1300 });
    expect(taxed!.subtotal_amount + taxed!.tax_total_amount).toBe(taxed!.total_amount);
  });

  it('makes subtotal_amount NOT NULL and defaults tax_total_amount to 0', async () => {
    await expect(
      client.exec(`
        INSERT INTO pay.payment_request
          (id, issuer_did, payee_account, recipient_did, line_items, total_amount, fair_manifest, content_hash)
        VALUES ('pr_no_subtotal', 'a', 'a', 'b', '[]'::jsonb, 100, '{}'::jsonb, 'h')`),
    ).rejects.toThrow(/subtotal_amount/);

    await client.exec(`
      INSERT INTO pay.payment_request
        (id, issuer_did, payee_account, recipient_did, line_items, total_amount, subtotal_amount, fair_manifest, content_hash)
      VALUES ('pr_default_tax', 'a', 'a', 'b', '[]'::jsonb, 100, 100, '{}'::jsonb, 'h')`);
    const row = (await rows()).find((r) => r.id === 'pr_default_tax');
    expect(row?.tax_total_amount).toBe(0);
  });
});
