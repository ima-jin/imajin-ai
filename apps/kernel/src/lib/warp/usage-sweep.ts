/**
 * Incurred-meter recovery on the existing lifecycle sweep (#2972).
 * Local terminal records are replayed even after completion notification won
 * its publish claim. Descendant observation is scoped to locally recorded
 * kernel dispatches, never an arbitrary-key run scan or a vendor bill pull.
 * Root records follow the existing event-log retention (currently 14 days);
 * meter rows themselves persist independently after that log is pruned.
 * Observation is sequential to respect provider rate limits: one root read
 * plus its descendant pages per retained root per tick. It runs after the
 * normal in-flight watch work; no arbitrary key-wide history is scanned.
 */
import { getClient } from '@imajin/db';
import { createLogger } from '@imajin/logger';
import { forEachSequential } from '../async/sequential';
import { getAgentRun, listAgentRuns } from './dispatch';
import { recordWarpRunUsage, WARP_INCURRED_SINCE, type WarpUsageObservation } from '../usage/warp-incurred';

const log = createLogger('kernel:warp:usage-sweep');

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

async function observeKernelRoots(): Promise<void> {
  const sql = getClient();
  const rows = await sql`
    SELECT DISTINCT subject_did AS "principalDid", payload->>'runId' AS "runId"
    FROM kernel.event_subscription_log
    WHERE event_type = 'warp.agent.dispatched'
      AND occurred_at >= ${WARP_INCURRED_SINCE}::timestamptz
      AND payload->>'runId' IS NOT NULL
  `;
  await forEachSequential(rows, async (row) => {
    if (typeof row.principalDid !== 'string' || typeof row.runId !== 'string') return;
    try {
      await observeRoot(row.principalDid, row.runId);
    } catch {
      log.warn({ principalDid: row.principalDid, runId: row.runId }, 'Warp lifecycle usage observation unavailable; next sweep will retry');
    }
  });
}

/** Recovery is independent of normal watch candidate/terminal-publish status. */
export async function sweepWarpIncurredUsage(): Promise<void> {
  try {
    await replayTerminalObservations();
  } catch {
    log.warn({}, 'Warp terminal usage replay unavailable; next sweep will retry');
  }
  try {
    await observeKernelRoots();
  } catch {
    log.warn({}, 'Warp lifecycle usage roots unavailable; next sweep will retry');
  }
}
