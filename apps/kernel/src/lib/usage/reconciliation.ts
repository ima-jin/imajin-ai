/**
 * Computed-vs-billed reconciliation read model (#1076 Stage 1).
 *
 * `usage.incurred` is OUR meter (what we computed); `usage.billed` is the
 * COUNTERPARTY'S STATEMENT (what the provider says we were actually
 * charged) — see migrations/0122_usage_billed.sql for the full framing
 * note. This module answers the read the two exist to make possible: for a
 * given principal/provider/day/model, how far apart are they, in dollars
 * and (where both sides know it) tokens. The drift is the deliverable — a
 * mispriced rate card, a leaking key, or an unmetered surface all show up
 * here as a non-zero gap. No settlement, no `pay.transactions` write: this
 * is a read-only comparison.
 */
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db, usageIncurred, usageBilled } from '@/src/db';

export interface ReconciliationRow {
  provider: string;
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  /** `null` when this row represents an org-wide (non-per-model) billed line with no computed counterpart. */
  model: string | null;
  computedUsd: number | null;
  billedUsd: number | null;
  /** `billedUsd - computedUsd`, or `null` when either side is missing. */
  driftUsd: number | null;
  /** `driftUsd / computedUsd * 100`, or `null` when `computedUsd` is missing or zero. */
  driftPct: number | null;
  computedTokensIn: number | null;
  computedTokensOut: number | null;
  billedTokensIn: number | null;
  billedTokensOut: number | null;
}

export interface ReconciliationQuery {
  principalDid: string;
  provider?: string;
  /** Inclusive lower bound on the calendar day. */
  from?: Date;
  /** Exclusive upper bound on the calendar day. */
  to?: Date;
}

function toNumberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

interface ComputedRow {
  date: string;
  provider: string;
  model: string | null;
  costUsd: string | null;
  tokensIn: string | null;
  tokensOut: string | null;
}

async function readComputed(query: ReconciliationQuery): Promise<ComputedRow[]> {
  const conditions = [eq(usageIncurred.principalDid, query.principalDid)];
  if (query.provider) conditions.push(eq(usageIncurred.provider, query.provider));
  if (query.from) conditions.push(gte(usageIncurred.createdAt, query.from));
  if (query.to) conditions.push(lt(usageIncurred.createdAt, query.to));

  return db
    .select({
      date: sql<string>`to_char(date_trunc('day', ${usageIncurred.createdAt}), 'YYYY-MM-DD')`,
      provider: usageIncurred.provider,
      model: usageIncurred.model,
      costUsd: sql<string>`SUM(${usageIncurred.costUsd})`,
      tokensIn: sql<string>`SUM(${usageIncurred.tokensIn})`,
      tokensOut: sql<string>`SUM(${usageIncurred.tokensOut})`,
    })
    .from(usageIncurred)
    .where(and(...conditions))
    .groupBy(sql`date_trunc('day', ${usageIncurred.createdAt})`, usageIncurred.provider, usageIncurred.model);
}

interface BilledRow {
  date: string;
  provider: string;
  model: string | null;
  billedUsd: string | null;
  tokensIn: string | null;
  tokensOut: string | null;
}

async function readBilled(query: ReconciliationQuery): Promise<BilledRow[]> {
  // Only day-granularity rows participate in the per-day comparison — the
  // month-to-date row is a separate, coarser bucket that would double-count
  // against the same days if included here.
  const conditions = [eq(usageBilled.principalDid, query.principalDid), eq(usageBilled.granularity, 'day')];
  if (query.provider) conditions.push(eq(usageBilled.provider, query.provider));
  if (query.from) conditions.push(gte(usageBilled.periodStart, query.from));
  if (query.to) conditions.push(lt(usageBilled.periodStart, query.to));

  return db
    .select({
      date: sql<string>`to_char(date_trunc('day', ${usageBilled.periodStart}), 'YYYY-MM-DD')`,
      provider: usageBilled.provider,
      model: usageBilled.model,
      billedUsd: sql<string>`SUM(${usageBilled.billedUsd})`,
      tokensIn: sql<string>`SUM(${usageBilled.tokensIn})`,
      tokensOut: sql<string>`SUM(${usageBilled.tokensOut})`,
    })
    .from(usageBilled)
    .where(and(...conditions))
    .groupBy(sql`date_trunc('day', ${usageBilled.periodStart})`, usageBilled.provider, usageBilled.model);
}

function key(date: string, provider: string, model: string | null): string {
  return `${date}\u0000${provider}\u0000${model ?? ''}`;
}

/** Reconcile `usage.incurred` against `usage.billed` for one principal, grouped by (day, provider, model). */
export async function readReconciliation(query: ReconciliationQuery): Promise<ReconciliationRow[]> {
  const [computed, billed] = await Promise.all([readComputed(query), readBilled(query)]);

  const rows = new Map<string, ReconciliationRow>();

  for (const row of computed) {
    rows.set(key(row.date, row.provider, row.model), {
      provider: row.provider,
      date: row.date,
      model: row.model,
      computedUsd: toNumberOrNull(row.costUsd),
      billedUsd: null,
      driftUsd: null,
      driftPct: null,
      computedTokensIn: toNumberOrNull(row.tokensIn),
      computedTokensOut: toNumberOrNull(row.tokensOut),
      billedTokensIn: null,
      billedTokensOut: null,
    });
  }

  for (const row of billed) {
    const k = key(row.date, row.provider, row.model);
    const existing = rows.get(k);
    const billedUsd = toNumberOrNull(row.billedUsd);
    const billedTokensIn = toNumberOrNull(row.tokensIn);
    const billedTokensOut = toNumberOrNull(row.tokensOut);
    if (existing) {
      existing.billedUsd = billedUsd;
      existing.billedTokensIn = billedTokensIn;
      existing.billedTokensOut = billedTokensOut;
    } else {
      rows.set(k, {
        provider: row.provider,
        date: row.date,
        model: row.model,
        computedUsd: null,
        billedUsd,
        driftUsd: null,
        driftPct: null,
        computedTokensIn: null,
        computedTokensOut: null,
        billedTokensIn,
        billedTokensOut,
      });
    }
  }

  for (const row of rows.values()) {
    if (row.computedUsd !== null && row.billedUsd !== null) {
      row.driftUsd = row.billedUsd - row.computedUsd;
      row.driftPct = row.computedUsd !== 0 ? (row.driftUsd / row.computedUsd) * 100 : null;
    }
  }

  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider) || (a.model ?? '').localeCompare(b.model ?? ''));
}
