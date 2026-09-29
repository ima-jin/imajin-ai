/**
 * Trust-liability tax remittance-owed query (#2419).
 *
 * Sums settled, not-yet-remitted tax credits (`transactions` rows written
 * by `settlePayment()` in `settle-core.ts` — see the `taxCredits` loop
 * there) grouped by jurisdiction + kind. A row counts as "owed" while
 * `metadata.remitted` is `null`; once a human/ops process remits it, the
 * row's `metadata.remitted` should be set to an ISO timestamp (out of
 * scope for this issue — #2419 ships the read-only query only).
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, transactions } from '@/src/db';

export interface TaxRemittanceOwedRow {
  jurisdiction: string;
  kind: string;
  amount: number;
}

/**
 * `SUM(amount)` over settled tax credits `WHERE metadata.tax AND
 * metadata.remitted IS NULL`, grouped by `(jurisdiction, kind)`, for a
 * single `collectorDid` (the ledger `toDid` a tax credit was written to).
 */
export async function getTaxRemittanceOwed(collectorDid: string): Promise<TaxRemittanceOwedRow[]> {
  const rows = await db
    .select({
      jurisdiction: sql<string>`${transactions.metadata}->>'jurisdiction'`,
      kind: sql<string>`${transactions.metadata}->>'kind'`,
      amount: sql<string>`SUM(CAST(${transactions.amount} AS NUMERIC))`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.toDid, collectorDid),
        eq(transactions.status, 'completed'),
        sql`${transactions.metadata}->>'tax' = 'true'`,
        sql`${transactions.metadata}->>'remitted' IS NULL`,
      ),
    )
    .groupBy(sql`${transactions.metadata}->>'jurisdiction'`, sql`${transactions.metadata}->>'kind'`);

  return rows.map((row) => ({
    jurisdiction: row.jurisdiction,
    kind: row.kind,
    amount: Number.parseFloat(row.amount),
  }));
}
