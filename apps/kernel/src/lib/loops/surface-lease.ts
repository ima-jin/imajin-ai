import { createHash } from 'node:crypto';
import { canonicalize } from '@imajin/auth';
import { getClient } from '@imajin/db';
import type { LoopEventPayload } from '@imajin/bus';
import type { TransactionSql } from 'postgres';
import { isSurfaceEventType, type LoopIngestRequest } from './types';
export { SURFACE_LEASE_TTL_MS } from './surface-lease-policy';

export interface SurfaceConflict {
  loopId: string;
  holderDid?: string;
}
export function loopObservationId(request: LoopIngestRequest): string {
  return `signed-loop:${createHash('sha256').update(canonicalize(request)).digest('hex')}`;
}

async function requireStepOwner(tx: TransactionSql, surface: string, payload: LoopEventPayload): Promise<void> {
  if (!surface.startsWith('step:')) return;
  const owner = await tx`
    SELECT l.loop_id FROM kernel.loops l
    WHERE l.loop_id = ${payload.loopId} AND l.principal = ${payload.principal}
      AND EXISTS (
        SELECT 1 FROM kernel.loop_events e
        WHERE e.loop_id = l.loop_id AND e.principal = l.principal
          AND e.type = 'step.queued' AND e.payload->>'stepId' = ${surface.slice(5)}
          AND e.occurred_at <= ${payload.at}::timestamptz
      )
    FOR UPDATE OF l
  `;
  if (owner.length === 0) {
    throw Object.assign(new Error('Step requires its owning loop and declaration'), { code: 'loop_owner_conflict' });
  }
}

async function priorConflict(tx: TransactionSql, id: string): Promise<SurfaceConflict | null> {
  const prior = await tx`
    SELECT payload->>'observedConflictingLoopId' AS loop_id,
           payload->>'observedConflictingHolderDid' AS holder_did
    FROM kernel.loop_events WHERE id = ${id}
  `;
  if (!prior[0]?.loop_id) return null;
  return {
    loopId: prior[0].loop_id as string,
    ...(prior[0].holder_did ? { holderDid: prior[0].holder_did as string } : {}),
  };
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
): Promise<SurfaceConflict | null> {
  const { type, publisherDid, signature } = request;
  if (type === 'loop.started' || type === 'loop.blocked' || type === 'loop.finished') return null;
  const sql = getClient();
  const id = loopObservationId(request);
  const evidence = JSON.stringify(isSurfaceEventType(type) ? {
    ...payload,
    observedConflictingLoopId: null,
    observedConflictingHolderDid: null,
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
          AND surface NOT LIKE 'step:%'
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
    await requireStepOwner(tx, surface, payload);
    await tx`SELECT surface FROM kernel.surface_lease WHERE surface = ${surface} FOR UPDATE`;
    const inserted = await tx`
      INSERT INTO kernel.loop_events (id, loop_id, type, issuer, principal, payload, occurred_at)
      VALUES (${id}, ${payload.loopId}, ${type}, ${publisherDid}, ${payload.principal},
              ${evidence}::jsonb, ${payload.at}::timestamptz)
      ON CONFLICT (id) DO NOTHING RETURNING id
    `;
    if (inserted.length === 0) {
      return type === 'surface.acquired' ? priorConflict(tx, id) : null;
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
      SELECT loop_id, principal, issuer FROM kernel.surface_lease
      WHERE surface = ${surface} AND released_at IS NULL AND expires_at > now()
        AND (loop_id <> ${payload.loopId}
             OR (${surface.startsWith('step:')} AND (issuer <> ${publisherDid} OR principal <> ${payload.principal})))
    `;
    if (holders[0]) {
      const conflictingLoopId = holders[0].loop_id as string;
      // A global surface may collide across principals; do not expose that DID.
      const holderDid = holders[0].principal === payload.principal ? holders[0].issuer as string : null;
      await tx`
        UPDATE kernel.loop_events
        SET payload = payload || jsonb_build_object(
          'observedConflictingLoopId', ${conflictingLoopId}::text,
          'observedConflictingHolderDid', ${holderDid}::text)
        WHERE id = ${id}
      `;
      return { loopId: conflictingLoopId, ...(holderDid ? { holderDid } : {}) };
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
