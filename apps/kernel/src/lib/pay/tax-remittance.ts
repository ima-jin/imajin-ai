/**
 * Trust-liability tax remittance-owed query (#2419).
 *
 * Sums settled, not-yet-remitted tax credits (`transactions` rows written
 * by `settlePayment()` in `settle-core.ts` — see the `taxCredits` loop
 * there) grouped by jurisdiction + kind (+ the registration number the
 * credit was collected under, #2439, so each owed line shows the
 * registration it's owed against). A row counts as "owed" while
 * `metadata.remitted` is `null`; once a human/ops process remits it, the
 * row's `metadata.remitted` should be set to an ISO timestamp (out of
 * scope for this issue — #2419 ships the read-only query only).
 *
 * Grouping by jurisdiction + kind (not jurisdiction alone) is intentional
 * (#2435 review question): one jurisdiction can carry several taxes that are
 * filed and remitted separately — e.g. `CA-QC` GST/HST to the CRA and QST to
 * Revenu Québec — so collapsing them to a single per-jurisdiction total would
 * give a number nobody can remit against. Credits written by `settlePayment()`
 * and by the Stripe webhook's tax path (#2435) share the same metadata shape,
 * so both appear here.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, transactions } from '@/src/db';

export interface TaxRemittanceOwedRow {
  jurisdiction: string;
  kind: string;
  /** The registration the tax was collected under. `null` only for credits settled before #2439 started persisting it. */
  registrationNumber: string | null;
  amount: number;
}

/**
 * `SUM(amount)` over settled tax credits `WHERE metadata.tax AND
 * metadata.remitted IS NULL`, grouped by `(jurisdiction, kind,
 * registrationNumber)`, for a single `collectorDid` (the ledger `toDid` a
 * tax credit was written to).
 */
export async function getTaxRemittanceOwed(collectorDid: string): Promise<TaxRemittanceOwedRow[]> {
  const rows = await db
    .select({
      jurisdiction: sql<string>`${transactions.metadata}->>'jurisdiction'`,
      kind: sql<string>`${transactions.metadata}->>'kind'`,
      registrationNumber: sql<string | null>`${transactions.metadata}->>'registrationNumber'`,
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
    .groupBy(
      sql`${transactions.metadata}->>'jurisdiction'`,
      sql`${transactions.metadata}->>'kind'`,
      sql`${transactions.metadata}->>'registrationNumber'`,
    );

  return rows.map((row) => ({
    jurisdiction: row.jurisdiction,
    kind: row.kind,
    registrationNumber: row.registrationNumber ?? null,
    amount: Number.parseFloat(row.amount),
  }));
}
