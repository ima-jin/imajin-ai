/**
 * Per-connector spend burn-down (#1923, Phase 3 of #1922).
 *
 * Reads `usage.incurred` (granular token-level records; #1147/#1148's shared
 * Agent Resource-Accounting Layer stream, filtered here by `resource` /
 * `connector_id` since this is the inference-passthrough emitter's own
 * dashboard) grouped by session/turn/agent, alongside the connector's own
 * declared spend cap from `kernel.connectors.spend_cap` (#1924) — the
 * dashboard read the epic's target architecture component 4 calls for.
 *
 * Scope note: this reports a DECLARED-BUDGET burn-down (spend-to-date against
 * the owner's own cap) for every connector uniformly. The epic's "true
 * balances where the provider API allows (Moonshot, OpenAI)" is NOT
 * implemented here — that requires a live per-provider billing-API
 * integration that does not exist anywhere in this codebase yet (no
 * connector currently calls a provider's balance/billing endpoint at all),
 * which is new provider-integration surface beyond a metering-ledger issue.
 * Every provider gets the same, honest declared-budget number instead of a
 * fabricated "true balance" this module cannot actually verify.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db, usageIncurred, type ConnectorRow } from '@/src/db';
import { parseSpendCap, type SpendCap } from './spend-cap';

/** Cap the number of grouped rows returned per breakdown — a dashboard read, not an export. */
const MAX_ROWS = 50;

export interface BurnDownGroupRow {
  key: string | null;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  callCount: number;
}

export interface InferenceBurnDown {
  connectorId: string;
  provider: string;
  ownerDid: string;
  /** The connector's declared spend cap, or `null` when none is set. */
  spendCap: SpendCap | null;
  /** Total spend within the cap's own window (or lifetime, when uncapped). */
  spentUsd: number;
  totalCostUsd: number;
  totalCallCount: number;
  bySession: BurnDownGroupRow[];
  byTurn: BurnDownGroupRow[];
  byAgent: BurnDownGroupRow[];
}

function toNumber(value: string | number | null): number {
  return value === null ? 0 : Number(value);
}

type GroupableColumn =
  | typeof usageIncurred.sessionId
  | typeof usageIncurred.turnId
  | typeof usageIncurred.agentDid;

async function groupBy(connectorId: string, column: GroupableColumn): Promise<BurnDownGroupRow[]> {
  const rows = await db
    .select({
      key: column,
      costUsd: sql<string>`COALESCE(SUM(${usageIncurred.costUsd}), 0)`,
      tokensIn: sql<string>`COALESCE(SUM(${usageIncurred.tokensIn}), 0)`,
      tokensOut: sql<string>`COALESCE(SUM(${usageIncurred.tokensOut}), 0)`,
      callCount: sql<string>`COUNT(*)`,
    })
    .from(usageIncurred)
    .where(eq(usageIncurred.connectorId, connectorId))
    .groupBy(column)
    .orderBy(desc(sql`SUM(${usageIncurred.costUsd})`))
    .limit(MAX_ROWS);

  return rows.map((row) => ({
    key: row.key,
    costUsd: toNumber(row.costUsd),
    tokensIn: toNumber(row.tokensIn),
    tokensOut: toNumber(row.tokensOut),
    callCount: toNumber(row.callCount),
  }));
}

interface TotalsRow {
  totalCostUsd: string;
  totalCallCount: string;
}

async function readTotals(connectorId: string): Promise<TotalsRow> {
  const rows = await db
    .select({
      totalCostUsd: sql<string>`COALESCE(SUM(${usageIncurred.costUsd}), 0)`,
      totalCallCount: sql<string>`COUNT(*)`,
    })
    .from(usageIncurred)
    .where(eq(usageIncurred.connectorId, connectorId));
  return rows[0] ?? { totalCostUsd: '0', totalCallCount: '0' };
}

/** Start of the cap's current window, mirroring `spend-cap.ts`'s own windowing. */
function periodStart(cap: SpendCap, now: Date): Date | undefined {
  if (cap.period === 'daily') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  if (cap.period === 'monthly') {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return undefined;
}

async function readCappedSpend(connectorId: string, cap: SpendCap): Promise<number> {
  const start = periodStart(cap, new Date());
  const conditions = [eq(usageIncurred.connectorId, connectorId)];
  if (start) conditions.push(gte(usageIncurred.createdAt, start));

  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(${usageIncurred.costUsd}), 0)` })
    .from(usageIncurred)
    .where(and(...conditions));
  return toNumber(rows[0]?.total ?? '0');
}

/**
 * Read the burn-down for one connector registration. `registration` may be
 * `undefined` when the owner has never had this provider registered — the
 * read still succeeds (an all-zero burn-down with no cap), since a
 * connector with no rows yet is a legitimate, common state, not an error.
 */
export async function readInferenceBurnDown(
  connectorId: string,
  provider: string,
  ownerDid: string,
  registration: ConnectorRow | undefined,
): Promise<InferenceBurnDown> {
  const cap = parseSpendCap(registration?.spendCap) ?? null;

  const [totals, bySession, byTurn, byAgent] = await Promise.all([
    readTotals(connectorId),
    groupBy(connectorId, usageIncurred.sessionId),
    groupBy(connectorId, usageIncurred.turnId),
    groupBy(connectorId, usageIncurred.agentDid),
  ]);
  // Uncapped: the cap's own "window" is the connector's whole lifetime, which
  // `totals` already computed — no reason to run a second identical query.
  const spentUsd = cap ? await readCappedSpend(connectorId, cap) : toNumber(totals.totalCostUsd);

  return {
    connectorId,
    provider,
    ownerDid,
    spendCap: cap,
    spentUsd,
    totalCostUsd: toNumber(totals.totalCostUsd),
    totalCallCount: toNumber(totals.totalCallCount),
    bySession,
    byTurn,
    byAgent,
  };
}
