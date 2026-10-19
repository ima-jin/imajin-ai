/**
 * Warp's counterparty statement, one line per terminal run (#2972).
 *
 * Uses the dispatch/list client (and therefore the same sealed per-DID key).
 * Never retains prompts, titles, provider errors or arbitrary run metadata.
 * A resumed run is re-read from the fixed cutoff, not a moving day window.
 * Its cumulative credits stay attributed to its original creation time.
 * Writes target the inherited usage.billed_warp_runs relation so parent reads
 * include runs without changing the old parent bucket uniqueness/upsert seam.
 */
import { createHash } from 'node:crypto';
import { getClient } from '@imajin/db';
import {
  isTerminalRunState,
  listAgentRuns,
  type WarpAgentRun,
  type WarpRunUsage,
} from '@/src/lib/warp/dispatch';
import { WarpApiError } from '@/src/lib/warp/errors';
import { BillingApiError } from './types';
import { forEachSequential } from '@/src/lib/async/sequential';

export const WARP_BILLED_SINCE = '2026-10-19T00:00:00.000Z';
/** Operator config via the existing admin config route: { usd: 100, credits: 6500 }. */
export const WARP_CREDIT_RATE_CONFIG = 'usage.warp.credit-rate';
export const DEFAULT_WARP_CREDIT_RATE = { usd: 100, credits: 6500 } as const;

export interface WarpCreditRate {
  usd: number;
  credits: number;
}

export interface WarpBilledRun {
  runId: string;
  createdAt: Date;
  updatedAt: Date;
  model: string | null;
  parentRunId: string | null;
  requestUsage: WarpRunUsage;
  credits: number;
}

function validRate(value: unknown): value is WarpCreditRate {
  if (value === null || typeof value !== 'object') return false;
  const rate = value as WarpCreditRate;
  return Number.isFinite(rate.usd) && rate.usd > 0
    && Number.isFinite(rate.credits) && rate.credits > 0;
}

async function loadCreditRate(): Promise<WarpCreditRate> {
  const sql = getClient();
  const [row] = await sql`
    SELECT value FROM registry.node_config WHERE key = ${WARP_CREDIT_RATE_CONFIG}
  `;
  const rate: unknown = row?.value ?? DEFAULT_WARP_CREDIT_RATE;
  if (!validRate(rate)) throw new Error('Invalid Warp billing credit rate');
  return rate;
}

function billedRun(run: WarpAgentRun, now: Date): WarpBilledRun | null {
  if (!isTerminalRunState(run.state) || run.requestUsage === null) return null;
  const createdAt = new Date(run.createdAt ?? '');
  if (!Number.isFinite(createdAt.getTime())
    || createdAt < new Date(WARP_BILLED_SINCE) || createdAt >= now) return null;
  const { inferenceCost, computeCost, platformCost } = run.requestUsage;
  const costs = [inferenceCost, computeCost, platformCost];
  // Missing usage is unknown, never invented zero spend. Some child runs have
  // null compute/platform components; the reported numeric components bill.
  if (costs.every((cost) => cost === null)) return null;
  if (costs.some((cost) => cost !== null && (!Number.isFinite(cost) || cost < 0))) {
    throw new Error('Invalid Warp billing usage');
  }
  const credits = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  if (!Number.isFinite(credits)) throw new Error('Invalid Warp billing usage');
  const updatedAt = new Date(run.updatedAt ?? run.createdAt ?? '');
  return {
    runId: run.runId,
    createdAt,
    updatedAt: Number.isFinite(updatedAt.getTime()) && updatedAt >= createdAt ? updatedAt : createdAt,
    model: run.modelId,
    parentRunId: run.parentRunId,
    requestUsage: run.requestUsage,
    credits,
  };
}
function mergeBilledRun(runs: Map<string, WarpBilledRun>, run: WarpAgentRun, now: Date): void {
  const line = billedRun(run, now);
  if (line && line.credits > (runs.get(line.runId)?.credits ?? -1)) runs.set(line.runId, line);
}

/** Complete list, including terminal children without an environment. */
export async function readWarpBilledRuns(principalDid: string, now = new Date()): Promise<WarpBilledRun[]> {
  try {
    const runs = new Map<string, WarpBilledRun>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await listAgentRuns(principalDid, {
        createdAfter: WARP_BILLED_SINCE,
        limit: 500,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const run of page.runs) {
        mergeBilledRun(runs, run, now);
      }
      if (!page.hasNextPage) break;
      if (!page.nextCursor || cursors.has(page.nextCursor)) {
        throw new Error('Invalid Warp billing pagination');
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor);
    return [...runs.values()];
  } catch (error) {
    // Warp problem detail and transport exceptions can echo credentials.
    throw new BillingApiError('warp', error instanceof WarpApiError ? error.status : 502, 'Warp billed usage unavailable');
  }
}

/** Principal-scoped deterministic identity; never overload model with a run ID. */
export function warpBilledId(principalDid: string, runId: string): string {
  return `billed_warp_${createHash('sha256').update(JSON.stringify([principalDid, runId])).digest('hex')}`;
}

/**
 * Atomic insert-or-grow: ON CONFLICT locks the stored row before checking the
 * credits. Concurrent/stale passes cannot decrease it or replace its rate.
 * An identical pass changes nothing, including raw/fetched_at/period_end.
 */
export async function ingestWarpBilledUsage(principalDid: string, now = new Date()): Promise<number> {
  try {
    const lines = await readWarpBilledRuns(principalDid, now);
    if (lines.length === 0) return 0;
    const rate = await loadCreditRate();
    const sql = getClient();
    let rowsWritten = 0;
    await forEachSequential(lines, async (line) => {
      const raw = {
        runId: line.runId, parentRunId: line.parentRunId,
        requestUsage: { ...line.requestUsage }, credits: line.credits, creditRate: { ...rate },
      };
      const rows = await sql`
        INSERT INTO usage.billed_warp_runs
          (id, principal_did, provider, source, currency, period_start, period_end,
           granularity, model, billed_usd, raw, fetched_at)
        VALUES
          (${warpBilledId(principalDid, line.runId)}, ${principalDid}, 'warp', 'api', 'USD',
           ${line.createdAt}, ${line.updatedAt}, 'run', ${line.model},
           ${line.credits}::numeric * ${rate.usd}::numeric / ${rate.credits}::numeric,
           ${sql.json(raw)}, now())
        ON CONFLICT (id) DO UPDATE SET
          period_end = GREATEST(usage.billed_warp_runs.period_end, EXCLUDED.period_end),
          billed_usd = round(
            (EXCLUDED.raw->>'credits')::numeric
            * (usage.billed_warp_runs.raw->'creditRate'->>'usd')::numeric
            / (usage.billed_warp_runs.raw->'creditRate'->>'credits')::numeric, 8),
          raw = jsonb_set(EXCLUDED.raw, '{creditRate}', usage.billed_warp_runs.raw->'creditRate'),
          fetched_at = EXCLUDED.fetched_at
        WHERE usage.billed_warp_runs.provider = 'warp'
          AND usage.billed_warp_runs.source = 'api'
          AND usage.billed_warp_runs.granularity = 'run'
          AND (EXCLUDED.raw->>'credits')::numeric > (usage.billed_warp_runs.raw->>'credits')::numeric
        RETURNING id
      `;
      rowsWritten += rows.length;
    });
    return rowsWritten;
  } catch (error) {
    if (error instanceof BillingApiError) throw error;
    throw new BillingApiError('warp', 502, 'Warp billed usage unavailable');
  }
}
