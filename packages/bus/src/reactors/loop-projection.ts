import { randomUUID } from 'node:crypto';
import { createLogger } from '@imajin/logger';
import type { BusEvent, ReactorHandler } from '../types';

const log = createLogger('bus:loop-projection');

const LIFECYCLE_TYPES = new Set(['loop.started', 'loop.progress', 'loop.blocked', 'loop.finished']);
const STEP_TYPES = new Set([
  'step.queued', 'step.updated', 'step.claimed', 'step.started', 'step.progress',
  'step.blocked', 'step.finished', 'step.observed', 'step.attested',
]);

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function observedAt(event: BusEvent): string {
  return typeof event.payload?.at === 'string' ? event.payload.at : (event.timestamp ?? new Date().toISOString());
}

/** The kernel owns step semantics; this boundary only validates persistence prerequisites. */
function validateStepObservation(event: BusEvent, payload: Record<string, unknown>): void {
  const fields = ['loopId', 'stepId', 'kind', 'principal', 'state', 'summary', 'at'];
  const invalidField = fields.find(field => !nonemptyString(payload[field]));
  if (invalidField) throw new Error(`Invalid step observation: ${invalidField} is required`);
  if (!nonemptyString(event.id)) throw new Error('Invalid step observation: stable event.id is required');
  if (![event.issuer, event.subject, event.scope].every(nonemptyString)) {
    throw new Error('Invalid step observation: issuer, subject and scope are required');
  }
  if (!Number.isFinite(Date.parse(payload.at as string))) {
    throw new Error('Invalid step observation: at must be a valid timestamp');
  }
}
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
 * Step observations (#2878) append only to history after locking an existing,
 * same-principal loop. They never advance the loop lifecycle or dispatch work.
 *
 * Raw SQL via @imajin/db — packages/bus must not import apps/kernel (AGENTS.md).
 * Malformed lifecycle envelopes are skipped; malformed steps are rejected.
 * Ownership conflicts and persistence failures throw; the awaited bus chain
 * must propagate these to ingest.
 */
export const loopProjectionReactor: ReactorHandler = async (event) => {
  const stepObservation = STEP_TYPES.has(event.type);
  if (!LIFECYCLE_TYPES.has(event.type) && !stepObservation) return;

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (stepObservation) validateStepObservation(event, payload);
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
  const at = observedAt(event);
  const finishedAt = event.type === 'loop.finished' ? at : null;
  const initialObservation = payload.initialObservation === true;
  const signedCompletion = event.type === 'loop.finished' && Boolean(event.id);

  const { getClient } = await import('@imajin/db');
  const sql = getClient();

  await sql.begin(async (tx) => {
    if (signedCompletion) {
      // Same principal/issuer/loop lock used by signed surface acquisitions.
      const loopLock = JSON.stringify([principal, event.issuer, loopId]);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${loopLock}, 2406))`;
    }
    // The unique loop_id upsert serializes even concurrent first writes.
    // A conflicting principal cannot update any projection field. Older
    // same-principal events are still logged, without regressing "now".
    if (!stepObservation) await tx`
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

    // Lifecycle upserts already hold this lock. Steps must lock an existing
    // row before appending history, serializing with lifecycle writes and
    // deletion/ownership changes without ever creating or updating the loop.
    const owners = await tx`
      SELECT principal FROM kernel.loops WHERE loop_id = ${loopId} FOR UPDATE
    `;
    if (owners[0]?.principal !== principal) throw new LoopOwnershipConflictError();

    // History and projection commit together, or neither does. Keep payload
    // opaque so optional typed output survives without reinterpretation.
    // Steps require the stable signed-ingest id above; only legacy lifecycle
    // publishers may generate a local id.
    await tx`
      INSERT INTO kernel.loop_events
        (id, loop_id, type, issuer, principal, payload, occurred_at)
      VALUES
        (${event.id ?? randomUUID()}, ${loopId}, ${event.type}, ${event.issuer}, ${principal},
         ${JSON.stringify(payload)}::jsonb, ${at}::timestamptz)
      ON CONFLICT (id) DO NOTHING
    `;
    if (signedCompletion) {
      // A failed history/projection write must not release a lease either.
      await tx`
        UPDATE kernel.surface_lease SET released_at = ${at}::timestamptz, updated_at = now()
        WHERE loop_id = ${loopId} AND principal = ${principal} AND issuer = ${event.issuer}
          AND released_at IS NULL AND heartbeat_at <= ${at}::timestamptz
      `;
    }
  });
};
