/**
 * `GET /usage/api/summary` read model (#2030).
 *
 * Combines three existing reads — never a new table — for one
 * (principal, window): `usage.incurred` (OUR meter), `usage.billed` (the
 * COUNTERPARTY'S STATEMENT), and the most recent `usage.rollup` attestation
 * (`lib/usage/rollup.ts`) whose signing fell inside the window. Drift is not
 * recomputed here — it delegates to `lib/usage/reconciliation.ts` so the
 * two routes can never disagree about what "drift" means for the same
 * window (#2030 acceptance criterion).
 */
import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { db, usageIncurred, usageBilled, attestations } from '@/src/db';
import { readReconciliation } from './reconciliation';

export interface UsageSummaryQuery {
  principalDid: string;
  from: Date;
  to: Date;
  windowLabel: string;
}

export interface UsageSummaryResult {
  did: string;
  window: string;
  incurred: { total: number; byProvider: Record<string, number> };
  billed: { total: number; byVendor: Record<string, number>; bySource: Record<string, number> };
  drift: number;
  rollup: { attestationId: string; signedAt: string } | null;
  currency: string;
}

function toNumber(value: string | number | null): number {
  return value === null || value === undefined ? 0 : Number(value);
}

interface IncurredRow {
  provider: string;
  costUsd: string | null;
}

async function readIncurredByProvider(principalDid: string, from: Date, to: Date): Promise<IncurredRow[]> {
  return db
    .select({
      provider: usageIncurred.provider,
      costUsd: sql<string | null>`SUM(${usageIncurred.costUsd})`,
    })
    .from(usageIncurred)
    .where(and(eq(usageIncurred.principalDid, principalDid), gte(usageIncurred.createdAt, from), lt(usageIncurred.createdAt, to)))
    .groupBy(usageIncurred.provider);
}

interface BilledRow {
  provider: string;
  source: string;
  granularity: string;
  billedUsd: string | null;
}

async function readBilledByProviderAndSource(principalDid: string, from: Date, to: Date): Promise<BilledRow[]> {
  return db
    .select({
      provider: usageBilled.provider,
      source: usageBilled.source,
      granularity: usageBilled.granularity,
      billedUsd: sql<string | null>`SUM(${usageBilled.billedUsd})`,
    })
    .from(usageBilled)
    .where(and(eq(usageBilled.principalDid, principalDid), gte(usageBilled.periodStart, from), lt(usageBilled.periodStart, to)))
    .groupBy(usageBilled.provider, usageBilled.source, usageBilled.granularity);
}

/**
 * `source = 'api'` rows are pulled at both 'day' (settled) and 'month'
 * (moving month-to-date) granularity for the SAME days — see
 * `billed/ingest-job.ts`. Summing both would double-count; only the 'day'
 * rows are counted for api-sourced totals. Manual/document rows have no
 * such duplicate bucket, so every one of them counts once, unconditionally.
 */
function countsTowardBilledTotal(row: BilledRow): boolean {
  return row.source !== 'api' || row.granularity === 'day';
}

interface RollupPointer {
  attestationId: string;
  signedAt: string;
}

async function readLatestRollup(principalDid: string, from: Date, to: Date): Promise<RollupPointer | null> {
  const [row] = await db
    .select({ id: attestations.id, issuedAt: attestations.issuedAt })
    .from(attestations)
    .where(
      and(
        eq(attestations.type, 'usage.rollup'),
        eq(attestations.subjectDid, principalDid),
        isNull(attestations.revokedAt),
        gte(attestations.issuedAt, from),
        lt(attestations.issuedAt, to),
      ),
    )
    .orderBy(desc(attestations.issuedAt))
    .limit(1);

  if (!row) return null;
  return { attestationId: row.id, signedAt: row.issuedAt.toISOString() };
}

/** Read the full summary for one (principal, window). */
export async function readUsageSummary(query: UsageSummaryQuery): Promise<UsageSummaryResult> {
  const { principalDid, from, to, windowLabel } = query;

  const [incurredRows, billedRows, reconciliation, rollup] = await Promise.all([
    readIncurredByProvider(principalDid, from, to),
    readBilledByProviderAndSource(principalDid, from, to),
    readReconciliation({ principalDid, from, to }),
    readLatestRollup(principalDid, from, to),
  ]);

  const byProvider: Record<string, number> = {};
  let incurredTotal = 0;
  for (const row of incurredRows) {
    const amount = toNumber(row.costUsd);
    byProvider[row.provider] = (byProvider[row.provider] ?? 0) + amount;
    incurredTotal += amount;
  }

  const byVendor: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let billedTotal = 0;
  for (const row of billedRows) {
    if (!countsTowardBilledTotal(row)) continue;
    const amount = toNumber(row.billedUsd);
    byVendor[row.provider] = (byVendor[row.provider] ?? 0) + amount;
    bySource[row.source] = (bySource[row.source] ?? 0) + amount;
    billedTotal += amount;
  }

  const drift = reconciliation.reduce((sum, row) => sum + (row.driftUsd ?? 0), 0);

  return {
    did: principalDid,
    window: windowLabel,
    incurred: { total: incurredTotal, byProvider },
    billed: { total: billedTotal, byVendor, bySource },
    drift,
    rollup,
    // USD-only (packages/money FX, #1950, is out of scope) — every figure
    // above is already summed from USD-denominated columns.
    currency: 'USD',
  };
}
