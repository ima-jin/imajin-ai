/**
 * Clock-rollup for the `usage.incurred` primitive (#1148).
 *
 * Daily cron (see app/api/cron/usage-rollup/route.ts) that reads every
 * `usage.incurred` row in a window, groups it by (principal_did, resource,
 * source) — resource-blind: it never branches on what any given `resource`
 * string actually means, it only sums what the rows already carry — and
 * emits ONE signed `usage.rollup` attestation per (principalDid, window)
 * carrying the per-resource/source breakdown plus a total costEstimateUsd.
 *
 * Signed on the agent (node) DID, same issuer/subject shape as
 * `usage.incurred` itself: `issuer` = this node's own DID (the meter),
 * `subject` = the principal the usage is attributed to.
 *
 * Grain: DAILY. #1147 left daily-vs-hourly TBD; daily matches
 * `pay.balance_rollups`'s existing cadence and every other kernel cron in
 * vercel.json, so it is the deliberate default here (documented in the PR
 * as a decision for review, not re-litigated per emitter).
 *
 * Idempotency: best-effort. Each rollup's `context_id` is
 * `usage-rollup:{principalDid}:{windowStart's UTC date}`; a re-run of the
 * same window skips any principal that already has a `usage.rollup`
 * attestation with that context_id. There is a race if the cron fires twice
 * in close succession before the first run's attestation write lands —
 * acceptable for a daily sweep, the same class of race
 * `connector-registry-store.ts` already accepts for the shadow registry
 * ("a usage row must never fail to write because a projection row raced it").
 */
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, usageIncurred, attestations } from '@/src/db';
import { getNodeDid } from '@/src/lib/kernel/node-identity';

const log = createLogger('kernel:usage-rollup');

export interface UsageRollupBreakdownRow {
  resource: string;
  source: string;
  quantity: number | null;
  unit: string | null;
  costEstimateUsd: number;
}

export interface UsageRollupResult {
  principalDid: string;
  contextId: string;
  totalCostEstimateUsd: number;
  breakdown: UsageRollupBreakdownRow[];
  /** True when a `usage.rollup` attestation for this (principal, window) already existed. */
  skipped: boolean;
}

interface GroupedUsageRow {
  principalDid: string;
  resource: string;
  source: string;
  quantity: string | null;
  unit: string | null;
  costUsd: string | null;
}

function toNumber(value: string | number | null): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function toNumberOrNull(value: string | number | null): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** `context_id` for one (principal, window) rollup — also the idempotency key. */
export function contextIdFor(principalDid: string, windowStart: Date): string {
  return `usage-rollup:${principalDid}:${windowStart.toISOString().slice(0, 10)}`;
}

async function readGroupedUsage(windowStart: Date, windowEnd: Date): Promise<GroupedUsageRow[]> {
  return db
    .select({
      principalDid: usageIncurred.principalDid,
      resource: usageIncurred.resource,
      source: usageIncurred.source,
      quantity: sql<string | null>`SUM(${usageIncurred.quantity})`,
      unit: sql<string | null>`MAX(${usageIncurred.unit})`,
      costUsd: sql<string | null>`SUM(${usageIncurred.costUsd})`,
    })
    .from(usageIncurred)
    .where(and(gte(usageIncurred.createdAt, windowStart), lt(usageIncurred.createdAt, windowEnd)))
    .groupBy(usageIncurred.principalDid, usageIncurred.resource, usageIncurred.source);
}

async function alreadyRolledUp(contextId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: attestations.id })
    .from(attestations)
    .where(and(eq(attestations.type, 'usage.rollup'), eq(attestations.contextId, contextId)))
    .limit(1);
  return Boolean(existing);
}

/**
 * Run the clock-rollup for one window `[windowStart, windowEnd)`. Returns
 * one result per principal that had `usage.incurred` rows in the window,
 * whether or not a new attestation was actually published for it.
 */
export async function runUsageRollup(windowStart: Date, windowEnd: Date): Promise<UsageRollupResult[]> {
  const rows = await readGroupedUsage(windowStart, windowEnd);
  if (rows.length === 0) return [];

  const byPrincipal = new Map<string, GroupedUsageRow[]>();
  for (const row of rows) {
    const list = byPrincipal.get(row.principalDid) ?? [];
    list.push(row);
    byPrincipal.set(row.principalDid, list);
  }

  const nodeDid = await getNodeDid();
  const results: UsageRollupResult[] = [];

  for (const [principalDid, principalRows] of byPrincipal) {
    const contextId = contextIdFor(principalDid, windowStart);
    const breakdown: UsageRollupBreakdownRow[] = principalRows.map((row) => ({
      resource: row.resource,
      source: row.source,
      quantity: toNumberOrNull(row.quantity),
      unit: row.unit,
      costEstimateUsd: toNumber(row.costUsd),
    }));
    const totalCostEstimateUsd = breakdown.reduce((sum, row) => sum + row.costEstimateUsd, 0);

    if (await alreadyRolledUp(contextId)) {
      results.push({ principalDid, contextId, totalCostEstimateUsd, breakdown, skipped: true });
      continue;
    }

    try {
      await publish('usage.rollup', {
        issuer: nodeDid,
        subject: principalDid,
        scope: 'usage',
        payload: {
          attestationClass: 'system',
          issuerDid: nodeDid,
          actingFor: principalDid,
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          totalCostEstimateUsd,
          breakdown,
          source: 'usage-rollup-cron',
          context_id: contextId,
          context_type: 'usage.rollup',
        },
      });
    } catch (err) {
      log.error({ err: String(err), principalDid, contextId }, 'usage.rollup publish failed');
    }

    results.push({ principalDid, contextId, totalCostEstimateUsd, breakdown, skipped: false });
  }

  return results;
}

/** Start/end of the previous full UTC day — the daily cron's default window. */
export function previousUtcDayWindow(now: Date): { windowStart: Date; windowEnd: Date } {
  const windowEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
  return { windowStart, windowEnd };
}
