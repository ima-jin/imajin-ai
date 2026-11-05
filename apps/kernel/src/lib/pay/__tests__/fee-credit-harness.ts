import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/src/db/schemas/pay';

export const feeMigration = readFileSync(
  new URL('../../../../../../migrations/0234_pay_transactions_source_kind_fee.sql', import.meta.url), 'utf8',
);

/** Use the real baseline's pay tables, keys and CHECKs, not a permissive test schema. */
export async function createFeeCreditHarness() {
  const baseline = readFileSync(
    new URL('../../../../../../migrations/0001_kernel_baseline.sql', import.meta.url), 'utf8',
  ).replaceAll('\r\n', '\n');
  const tables = [...baseline.matchAll(/CREATE TABLE pay\.(transactions|balances|balance_rollups|fee_ledger) \([\s\S]*?\n\);/g)];
  const keys = [...baseline.matchAll(/ALTER TABLE ONLY pay\.(transactions|balances|balance_rollups|fee_ledger)\n\s+ADD CONSTRAINT [^;]+;/g)];
  const unique = baseline.match(/CREATE UNIQUE INDEX uniq_transactions_idempotency_key [^;]+;/);
  if (tables.length !== 4 || keys.length !== 4 || !unique) throw new Error('Pay baseline DDL not found');
  const client = new PGlite();
  await client.exec(['CREATE SCHEMA pay;', ...tables.map(([ddl]) => ddl), ...keys.map(([ddl]) => ddl), unique[0]].join('\n'));
  return { client, db: drizzle(client, { schema }) };
}
