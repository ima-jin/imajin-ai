/**
 * Incurred-meter recovery on the existing lifecycle sweep (#2972, #3133).
 * Local terminal records are replayed even after completion notification won
 * its publish claim. Descendant observation is scoped to locally recorded
 * kernel dispatches, never an arbitrary-key run scan or a vendor bill pull.
 * Root records follow the existing event-log retention (currently 14 days);
 * meter rows themselves persist independently after that log is pruned.
 * Observation is sequential to respect provider rate limits: one root read
 * plus its descendant pages per unsettled/recently terminal root per tick.
 * Priced roots settle 24 hours after their latest terminal observation;
 * newer dispatch/resume activity reopens lineage observation. It runs after the
 * normal in-flight watch work; no arbitrary key-wide history is scanned.
 */
import { getClient } from '@imajin/db';
import { createLogger } from '@imajin/logger';
import { forEachSequential } from '../async/sequential';
import { getAgentRun, listAgentRuns } from './dispatch';
import { recordWarpRunUsage, WARP_INCURRED_SOURCE, WARP_INCURRED_SINCE, type WarpUsageObservation } from '../usage/warp-incurred';

const log = createLogger('kernel:warp:usage-sweep');
export const WARP_USAGE_SETTLE_MS = 24 * 60 * 60 * 1000;

function observation(value: unknown): WarpUsageObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (typeof payload.runId !== 'string' || typeof payload.createdAt !== 'string') return null;
  return {
    runId: payload.runId,
    state: typeof payload.state === 'string' ? payload.state : null,
    createdAt: payload.createdAt,
    modelId: typeof payload.modelId === 'string' ? payload.modelId : null,
    parentRunId: typeof payload.parentRunId === 'string' ? payload.parentRunId : null,
    requestUsage: payload.requestUsage as WarpUsageObservation['requestUsage'],
  };
}

async function replayTerminalObservations(): Promise<void> {
  const sql = getClient();
  const rows = await sql`
    SELECT subject_did AS "principalDid", payload
    FROM kernel.event_subscription_log
    WHERE event_type IN ('warp.run.completed', 'warp.run.failed')
      AND occurred_at >= ${WARP_INCURRED_SINCE}::timestamptz
    ORDER BY occurred_at, seq
  `;
  await forEachSequential(rows, async (row) => {
    const run = observation(row.payload);
    if (run && typeof row.principalDid === 'string') await recordWarpRunUsage(row.principalDid, run);
  });
}

async function observeRoot(principalDid: string, rootRunId: string): Promise<void> {
  // Re-reading known roots repairs a meter failure even when terminal publish
  // itself failed after its claim, leaving no terminal payload to replay.
  await recordWarpRunUsage(principalDid, await getAgentRun(principalDid, rootRunId));
  const seenCursors = new Set<string>();
  const nextPage = async (cursor?: string): Promise<void> => {
    const page = await listAgentRuns(principalDid, {
      ancestorRunId: rootRunId, limit: 500,
      ...(cursor === undefined ? {} : { cursor }),
    });
    await forEachSequential(page.runs, async (child) => {
      if (child.parentRunId && child.runId !== rootRunId) await recordWarpRunUsage(principalDid, child);
    });
    if (!page.hasNextPage) return;
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) throw new Error('Warp lifecycle pagination unavailable');
    seenCursors.add(page.nextCursor);
    await nextPage(page.nextCursor);
  };
  await nextPage();
}

async function observeKernelRoots(now: Date): Promise<void> {
  const sql = getClient();
  const settleBefore = new Date(now.getTime() - WARP_USAGE_SETTLE_MS);
  const rows = await sql`
    WITH roots AS (
      SELECT subject_did AS principal_did, payload->>'runId' AS run_id,
             MAX(occurred_at) AS dispatched_at
      FROM kernel.event_subscription_log
      WHERE event_type = 'warp.agent.dispatched'
        AND occurred_at >= ${WARP_INCURRED_SINCE}::timestamptz
        AND payload->>'runId' IS NOT NULL
      GROUP BY subject_did, payload->>'runId'
    )
    SELECT roots.principal_did AS "principalDid", roots.run_id AS "runId"
    FROM roots
    LEFT JOIN usage.incurred meter
      ON meter.principal_did = roots.principal_did
      AND meter.source = ${WARP_INCURRED_SOURCE}
      AND meter.external_id = roots.run_id
    LEFT JOIN LATERAL (
      SELECT MAX(occurred_at) AS terminal_at
      FROM kernel.event_subscription_log
      WHERE subject_did = roots.principal_did AND payload->>'runId' = roots.run_id
        AND event_type IN ('warp.run.completed', 'warp.run.failed')
    ) terminal ON TRUE
    WHERE meter.pricing->>'credits' IS NULL
      OR terminal.terminal_at IS NULL
      OR terminal.terminal_at >= ${settleBefore}
      OR roots.dispatched_at > terminal.terminal_at
      OR EXISTS (
        SELECT 1 FROM kernel.event_subscription_log
        WHERE subject_did = roots.principal_did AND payload->>'runId' = roots.run_id
          AND event_type = 'warp.run.resumed' AND occurred_at > terminal.terminal_at
      )
    ORDER BY COALESCE(terminal.terminal_at, roots.dispatched_at), roots.principal_did, roots.run_id
  `;
  await forEachSequential(rows, async (row) => {
    if (typeof row.principalDid !== 'string' || typeof row.runId !== 'string') return;
    try {
      await observeRoot(row.principalDid, row.runId);
    } catch (err) {
      log.warn({ errorType: err instanceof Error ? err.name : typeof err, principalDid: row.principalDid, runId: row.runId }, 'Warp lifecycle usage observation unavailable; next sweep will retry');
    }
  });
}

/** Recovery is independent of normal watch candidate/terminal-publish status. */
export async function sweepWarpIncurredUsage(now: Date = new Date()): Promise<void> {
  try {
    await replayTerminalObservations();
  } catch (err) {
    log.warn({ errorType: err instanceof Error ? err.name : typeof err }, 'Warp terminal usage replay unavailable; next sweep will retry');
  }
  try {
    await observeKernelRoots(now);
  } catch (err) {
    log.warn({ errorType: err instanceof Error ? err.name : typeof err }, 'Warp lifecycle usage roots unavailable; next sweep will retry');
  }
}
