import { randomUUID } from 'node:crypto';
import { createLogger } from '@imajin/logger';
import type { ReactorHandler } from '../types';

const log = createLogger('bus:loop-projection');

const LIFECYCLE_TYPES = new Set(['loop.started', 'loop.progress', 'loop.blocked', 'loop.finished']);
export class LoopOwnershipConflictError extends Error {
  readonly code = 'loop_owner_conflict';

  constructor() {
    super('Loop belongs to a different principal');
    this.name = 'LoopOwnershipConflictError';
  }
}

/**
 * #2295 — kernel loop registry projection.
 *
 * Materializes the `loop.started|progress|blocked|finished` common envelope
 * onto two tables:
 *   - `kernel.loop_events` — immutable per-transition history, one row per
 *     lifecycle event actually ingested (`GET /api/loops/:loopId`'s event
 *     history).
 *   - `kernel.loops` — current-state-per-loopId projection, upserted so a
 *     reader never has to window-function over the event log to find "now".
 *     `parent_loop_id` is what the ancestor lineage query (recursive CTE in
 *     `GET /api/loops?ancestor=`) walks.
 *
 * Mirrors `supply-recorder`'s #1136 dedicated-projection-reactor pattern —
 * wired `await: true` in `bus_chain_configs` so `POST /api/loops` sees its
 * own write immediately (read-after-write).
 *
 * Raw SQL via @imajin/db — packages/bus must not import apps/kernel (AGENTS.md).
 * Malformed envelopes are skipped. Ownership conflicts and persistence
 * failures throw; the awaited bus chain must propagate these to ingest.
 */
export const loopProjectionReactor: ReactorHandler = async (event) => {
  if (!LIFECYCLE_TYPES.has(event.type)) return;

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const loopId = typeof payload.loopId === 'string' ? payload.loopId : null;
  if (!loopId) {
    log.warn({ event: event.type }, 'loop event without loopId; skipping projection');
    return;
  }

  const kind = typeof payload.kind === 'string' ? payload.kind : null;
  const principal = typeof payload.principal === 'string' ? payload.principal : null;
  const state = typeof payload.state === 'string' ? payload.state : null;
  const summary = typeof payload.summary === 'string' ? payload.summary : null;
  if (!kind || !principal || !state || !summary) {
    log.warn({ event: event.type, loopId }, 'loop event missing required envelope fields; skipping projection');
    return;
  }

  const parentLoopId = typeof payload.parentLoopId === 'string' ? payload.parentLoopId : null;
  const refs = (payload.refs && typeof payload.refs === 'object') ? payload.refs : {};
  const at = typeof payload.at === 'string' ? payload.at : (event.timestamp ?? new Date().toISOString());
  const finishedAt = event.type === 'loop.finished' ? at : null;
  const initialObservation = payload.initialObservation === true;

  const { getClient } = await import('@imajin/db');
  const sql = getClient();

  await sql.begin(async (tx) => {
    // The unique loop_id upsert serializes even concurrent first writes.
    // A conflicting principal cannot update any projection field. Older
    // same-principal events are still logged, without regressing "now".
    await tx`
    INSERT INTO kernel.loops
      (loop_id, kind, principal, parent_loop_id, refs, state, summary, last_event_type, started_at, last_seen_at, finished_at)
    VALUES
      (${loopId}, ${kind}, ${principal}, ${parentLoopId}, ${JSON.stringify(refs)}::jsonb, ${state}, ${summary},
       ${event.type}, ${at}::timestamptz, ${at}::timestamptz, ${finishedAt}::timestamptz)
    ON CONFLICT (loop_id) DO UPDATE SET
      kind = EXCLUDED.kind,
      parent_loop_id = COALESCE(EXCLUDED.parent_loop_id, kernel.loops.parent_loop_id),
      refs = kernel.loops.refs || EXCLUDED.refs,
      state = EXCLUDED.state,
      summary = EXCLUDED.summary,
      last_event_type = EXCLUDED.last_event_type,
      last_seen_at = EXCLUDED.last_seen_at,
      finished_at = CASE
        WHEN EXCLUDED.last_event_type = 'loop.started' THEN NULL
        ELSE COALESCE(EXCLUDED.finished_at, kernel.loops.finished_at)
      END,
      updated_at = now()
    WHERE kernel.loops.principal = EXCLUDED.principal
      AND kernel.loops.last_seen_at <= EXCLUDED.last_seen_at
      AND NOT ${initialObservation}
    `;

    // The upsert holds the row lock until commit, including when its WHERE
    // condition failed. Check ownership separately: no RETURNING rows can
    // also mean an older, otherwise valid event.
    const owners = await tx`
      SELECT principal FROM kernel.loops WHERE loop_id = ${loopId} FOR UPDATE
    `;
    if (owners[0]?.principal !== principal) throw new LoopOwnershipConflictError();

    // History and projection commit together, or neither does. Keep payload
    // opaque so optional typed output survives without reinterpretation.
    await tx`
      INSERT INTO kernel.loop_events
        (id, loop_id, type, issuer, principal, payload, occurred_at)
      VALUES
        (${event.id ?? randomUUID()}, ${loopId}, ${event.type}, ${event.issuer}, ${principal},
         ${JSON.stringify(payload)}::jsonb, ${at}::timestamptz)
      ON CONFLICT (id) DO NOTHING
    `;
  });
};
