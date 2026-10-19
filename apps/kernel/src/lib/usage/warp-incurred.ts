/**
 * Kernel Warp lifecycle meter (#2972), not a provider-billing reader.
 *
 * One cumulative incurred row per run. Resumed growth keeps the stored rate
 * and original run creation time (including when a resume crosses weeks).
 * Canonical adapter:warp/runId identity also dedupes legacy external adapters;
 * an existing adapter row without this meter's pricing is never repriced.
 * Do not also report the same run under a different external-emitter source.
 * Missing/malformed usage remains visible as a degraded unpriced terminal row,
 * with a frozen rate ready for a later known observation; it is never zero.
 */
import { createHash } from 'node:crypto';
import { getClient } from '@imajin/db';
import { createLogger } from '@imajin/logger';
import type { WarpRunUsage } from '@/src/lib/warp/dispatch';

const log = createLogger('kernel:usage:warp-incurred');
export const WARP_INCURRED_SOURCE = 'adapter:warp';
export const WARP_INCURRED_SINCE = '2026-10-19T00:00:00.000Z';
export const WARP_CREDIT_RATE_CONFIG = 'usage.warp.credit-rate';
const DEFAULT_RATE = { usd: 100, credits: 6500 };
const RESOURCE = 'external:warp/run';

export interface WarpUsageObservation {
  runId: string;
  state: string | null;
  createdAt: string | null;
  modelId: string | null;
  parentRunId: string | null;
  requestUsage: WarpRunUsage | null;
}

function safeUsageComponents(usage: WarpRunUsage | null) {
  const safe = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  return {
    inferenceCost: safe(usage?.inferenceCost),
    computeCost: safe(usage?.computeCost),
    platformCost: safe(usage?.platformCost),
  };
}
interface CreditRate { usd: number; credits: number }
interface MeterRow {
  id: string;
  quantity: string | null;
  cost_usd: string | null;
  pricing: { credits: number | null; creditRate: CreditRate; previousCredits: number | null; previousCostUsd: number | null };
}

/** Unknown usage is not free; malformed non-null components invalidate it. */
export function warpRunCredits(run: WarpUsageObservation): number | null {
  if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.state ?? '') || !run.requestUsage) return null;
  const { inferenceCost, computeCost, platformCost } = run.requestUsage;
  const costs = [inferenceCost, computeCost, platformCost];
  if (costs.every(cost => cost === null)) return null;
  if (costs.some(cost => cost !== null && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0))) return null;
  const total = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  return Number.isFinite(total) && total < 1e18 ? total : null;
}

async function creditRate(): Promise<CreditRate> {
  const sql = getClient();
  const [row] = await sql`SELECT value FROM registry.node_config WHERE key = ${WARP_CREDIT_RATE_CONFIG}`;
  const value = row?.value ?? DEFAULT_RATE;
  if (typeof value !== 'object' || !value || Array.isArray(value)) throw new Error('Warp meter unavailable');
  const rate = value as CreditRate;
  if (!Number.isFinite(rate.usd) || rate.usd <= 0 || !Number.isFinite(rate.credits) || rate.credits <= 0) {
    throw new Error('Warp meter unavailable');
  }
  return { usd: rate.usd, credits: rate.credits };
}

async function publishChange(principalDid: string, run: WarpUsageObservation, row: MeterRow): Promise<void> {
  try {
    const { publishUsageIncurred } = await import('@/src/lib/inference/usage-ledger');
    await publishUsageIncurred({
      usageId: row.id, principalDid, resource: RESOURCE, source: WARP_INCURRED_SOURCE,
      quantity: row.pricing.credits === null ? undefined : Number(row.pricing.credits) - Number(row.pricing.previousCredits ?? 0),
      unit: 'warp-credits',
      costUsd: row.cost_usd === null ? undefined : Number(row.cost_usd) - Number(row.pricing.previousCostUsd ?? 0),
      sessionId: run.runId, externalId: run.runId, warpRunId: run.runId,
      metadata: {
        kind: 'cumulative-run-meter-delta', cumulativeCredits: row.pricing.credits,
        cumulativeCostUsd: row.cost_usd === null ? null : Number(row.cost_usd), creditRate: row.pricing.creditRate,
        runCreatedAt: run.createdAt, parentRunId: run.parentRunId,
      },
    });
  } catch {
    log.warn({ runId: run.runId, principalDid }, 'Warp incurred event unavailable; ledger already written');
  }
}

/** Fail-open for completion; durable lifecycle replay retries failed writes. */
export async function recordWarpRunUsage(principalDid: string, run: WarpUsageObservation): Promise<boolean> {
  const credits = warpRunCredits(run);
  const createdAt = new Date(run.createdAt ?? '');
  if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.state ?? '') || !run.runId || !Number.isFinite(createdAt.getTime())
    || createdAt < new Date(WARP_INCURRED_SINCE)) return false;
  try {
    const rate = await creditRate();
    const sql = getClient();
    const id = `usage_warp_${createHash('sha256').update(run.runId).digest('hex')}`;
    const pricing = {
      meter: 'kernel-warp-watch', creditRate: { usd: rate.usd, credits: rate.credits }, previousCredits: 0, previousCostUsd: 0,
      credits,
      requestUsage: safeUsageComponents(run.requestUsage),
      parentRunId: run.parentRunId,
    };
    const rows = await sql`
      INSERT INTO usage.incurred
        (id, principal_did, source, resource, provider, model, session_id, external_id,
         quantity, unit, cost_usd, pricing, created_at)
      VALUES
        (${id}, ${principalDid}, ${WARP_INCURRED_SOURCE}, ${RESOURCE}, 'warp', ${run.modelId ?? 'unknown'},
         ${run.runId}, ${run.runId}, ${credits}::numeric, 'warp-credits',
         ${credits}::numeric * ${rate.usd}::numeric / ${rate.credits}::numeric,
         ${sql.json(pricing)}, ${createdAt})
      ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL
      DO UPDATE SET
        quantity = EXCLUDED.quantity,
        cost_usd = round((EXCLUDED.pricing->>'credits')::numeric
          * (usage.incurred.pricing->'creditRate'->>'usd')::numeric
          / (usage.incurred.pricing->'creditRate'->>'credits')::numeric, 8),
        pricing = jsonb_set(
          jsonb_set(
            jsonb_set(EXCLUDED.pricing, '{creditRate}', usage.incurred.pricing->'creditRate'),
            '{previousCredits}', usage.incurred.pricing->'credits'),
          '{previousCostUsd}', COALESCE(to_jsonb(usage.incurred.cost_usd), 'null'::jsonb))
      WHERE usage.incurred.principal_did = EXCLUDED.principal_did
        AND usage.incurred.pricing->>'meter' = 'kernel-warp-watch'
        AND EXCLUDED.pricing->>'credits' IS NOT NULL
        AND (usage.incurred.pricing->>'credits' IS NULL
          OR (EXCLUDED.pricing->>'credits')::numeric > (usage.incurred.pricing->>'credits')::numeric)
      RETURNING id, quantity, cost_usd, pricing
    `;
    const row = rows[0] as unknown as MeterRow | undefined;
    if (!row) return false;
    await publishChange(principalDid, run, row);
    return true;
  } catch {
    log.warn({ runId: run.runId, principalDid }, 'Warp incurred meter unavailable; lifecycle replay will retry');
    return false;
  }
}
