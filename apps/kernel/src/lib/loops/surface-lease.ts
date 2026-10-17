import { createHash } from 'node:crypto';
import { canonicalize } from '@imajin/auth';
import { getClient } from '@imajin/db';
import type { LoopEventPayload } from '@imajin/bus';
import { isSurfaceEventType, type LoopIngestRequest } from './types';

export const SURFACE_LEASE_TTL_MS = 15 * 60 * 1000;
export function loopObservationId(request: LoopIngestRequest): string {
  return `signed-loop:${createHash('sha256').update(canonicalize(request)).digest('hex')}`;
}

/**
 * Called only after signature + principal authorization. The acquisition's
 * signature and exact payload remain auditable, independently of heartbeats.
 * One transaction-scoped lock serializes all observations of the same URI,
 * including the initially absent row. This is a projection lock, NOT a gate
 * on either loop's work.
 */
export async function projectSurfaceLease(
  request: LoopIngestRequest,
  payload: LoopEventPayload = request.payload,
  canKeepProof = true,
): Promise<string | null> {
  const { type, publisherDid, signature } = request;
  if (type === 'loop.started' || type === 'loop.blocked' || type === 'loop.finished') return null;
  const sql = getClient();
  const id = loopObservationId(request);
  const evidence = JSON.stringify(isSurfaceEventType(type) ? {
    ...payload,
    observedConflictingLoopId: null,
    evidence: { publisherDid, signature, ...(canKeepProof ? { signedPayload: request.payload } : { redacted: true }) },
  } : payload);
  const loopLock = canonicalize([payload.principal, publisherDid, payload.loopId]);
  if (!isSurfaceEventType(type)) {
    if (type === 'loop.progress') {
      await sql`
        UPDATE kernel.surface_lease
        SET heartbeat_at = ${payload.at}::timestamptz,
            expires_at = ${payload.at}::timestamptz + interval '15 minutes', updated_at = now()
        WHERE loop_id = ${payload.loopId} AND principal = ${payload.principal} AND issuer = ${publisherDid}
          AND released_at IS NULL AND expires_at > now()
          AND heartbeat_at < ${payload.at}::timestamptz
      `;
    }
    return null;
  }

  // Stable signed-observation id: retries cannot replay an old acquisition
  // after release/expiry, nor create duplicate history or conflict warnings.
  const surface = payload.surface as string;
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${loopLock}, 2406))`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${surface}, 2405))`;
    await tx`SELECT surface FROM kernel.surface_lease WHERE surface = ${surface} FOR UPDATE`;
    const inserted = await tx`
      INSERT INTO kernel.loop_events (id, loop_id, type, issuer, principal, payload, occurred_at)
      VALUES (${id}, ${payload.loopId}, ${type}, ${publisherDid}, ${payload.principal},
              ${evidence}::jsonb, ${payload.at}::timestamptz)
      ON CONFLICT (id) DO NOTHING RETURNING id
    `;
    if (inserted.length === 0) {
      if (type !== 'surface.acquired') return null;
      const prior = await tx`
        SELECT payload->>'observedConflictingLoopId' AS conflicting_loop_id
        FROM kernel.loop_events WHERE id = ${id}
      `;
      return (prior[0]?.conflicting_loop_id as string | undefined) ?? null;
    }
    if (type === 'surface.conflicted') return null;

    if (type === 'surface.released') {
      await tx`
        UPDATE kernel.surface_lease SET released_at = ${payload.at}::timestamptz, updated_at = now()
        WHERE surface = ${surface} AND loop_id = ${payload.loopId}
          AND principal = ${payload.principal} AND issuer = ${publisherDid}
          AND released_at IS NULL AND heartbeat_at <= ${payload.at}::timestamptz
      `;
      return null;
    }
    // Signed events may arrive out of order, even before a holder row exists.
    const ended = await tx`
      SELECT id FROM kernel.loop_events
      WHERE loop_id = ${payload.loopId} AND principal = ${payload.principal} AND issuer = ${publisherDid}
        AND occurred_at >= ${payload.at}::timestamptz
        AND (type = 'loop.finished' OR (type = 'surface.released' AND payload->>'surface' = ${surface}))
      LIMIT 1
    `;
    if (ended.length > 0) return null;

    const holders = await tx`
      SELECT loop_id FROM kernel.surface_lease
      WHERE surface = ${surface} AND released_at IS NULL AND expires_at > now()
        AND loop_id <> ${payload.loopId}
    `;
    if (holders[0]) {
      const conflictingLoopId = holders[0].loop_id as string;
      await tx`
        UPDATE kernel.loop_events
        SET payload = payload || jsonb_build_object('observedConflictingLoopId', ${conflictingLoopId}::text)
        WHERE id = ${id}
      `;
      return conflictingLoopId;
    }

    await tx`
      INSERT INTO kernel.surface_lease
        (surface, loop_id, principal, issuer, signature, signed_payload, acquired_at, heartbeat_at, expires_at)
      VALUES (${surface}, ${payload.loopId}, ${payload.principal}, ${publisherDid},
              ${JSON.stringify(signature)}::jsonb, ${JSON.stringify(canKeepProof ? request.payload : payload)}::jsonb,
              ${payload.at}::timestamptz, ${payload.at}::timestamptz,
              ${payload.at}::timestamptz + interval '15 minutes')
      ON CONFLICT (surface) DO UPDATE SET
        loop_id = EXCLUDED.loop_id, principal = EXCLUDED.principal, issuer = EXCLUDED.issuer,
        signature = EXCLUDED.signature, signed_payload = EXCLUDED.signed_payload,
        acquired_at = EXCLUDED.acquired_at, heartbeat_at = EXCLUDED.heartbeat_at,
        expires_at = EXCLUDED.expires_at, released_at = NULL, updated_at = now()
      WHERE EXCLUDED.acquired_at > GREATEST(kernel.surface_lease.heartbeat_at, kernel.surface_lease.released_at)
        AND (kernel.surface_lease.released_at IS NOT NULL OR kernel.surface_lease.expires_at <= now()
             OR (kernel.surface_lease.loop_id = EXCLUDED.loop_id
                 AND kernel.surface_lease.principal = EXCLUDED.principal
                 AND kernel.surface_lease.issuer = EXCLUDED.issuer))
    `;
    return null;
  });
}
