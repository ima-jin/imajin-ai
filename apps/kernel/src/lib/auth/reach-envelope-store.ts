import { getClient } from '@imajin/db';
import type { ReachEnvelope } from '@/src/db/schemas/reach';
import type { PreparedMechanicalAttestation } from './emit-mechanical-attestation';

export type { ReachEnvelope } from '@/src/db/schemas/reach';

export interface PersistReachEnvelopeParams extends Omit<ReachEnvelope, 'claimVerified'> {
  dailyCap: number | null;
  perSenderDailyCap?: number;
  deliveryAttestation: PreparedMechanicalAttestation;
}

export type PersistReachEnvelopeResult =
  | { stored: true; reachId: string; replayed?: boolean; signedEvent: Record<string, unknown>; published: boolean }
  | { stored: false; reason: 'rate_limited' | 'blocked' };

type ReachTransaction = Pick<ReturnType<typeof getClient>, 'unsafe'>;

async function lockPrincipal(tx: ReachTransaction, principalDid: string): Promise<void> {
  await tx.unsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`reach:${principalDid}`]);
}

function validCap(cap: number): boolean {
  return Number.isSafeInteger(cap) && cap >= 0;
}

/**
 * Called only after admission, publication policy and deliver-mode checks.
 * The caller signs the delivery before this write and publishes only a new
 * committed delivery. No raw envelope content is emitted into the audit log.
 *
 * Every delivery and sender-block write takes the same principal lock. In
 * READ COMMITTED each subsequent statement sees the last lock holder's commit.
 * These tables contain deliveries only, so legacy asks never consume caps.
 */
export function persistReachEnvelope(params: PersistReachEnvelopeParams): Promise<PersistReachEnvelopeResult> {
  const { dailyCap, perSenderDailyCap = 25, deliveryAttestation, ...content } = params;
  if ((dailyCap !== null && !validCap(dailyCap)) || !validCap(perSenderDailyCap)) {
    return Promise.reject(new Error('Reach delivery caps must be non-negative safe integers'));
  }
  const envelope: ReachEnvelope = { ...content, claimVerified: false };
  if (deliveryAttestation.id !== `att_reach_${params.reachId}`
    || deliveryAttestation.subjectDid !== params.principalDid || deliveryAttestation.type !== 'agent.reach') {
    return Promise.reject(new Error('Delivery attestation must bind the reach id and principal'));
  }
  return getClient().begin('isolation level read committed', async (tx): Promise<PersistReachEnvelopeResult> => {
    await lockPrincipal(tx, params.principalDid);
    const blocked = await tx.unsafe(
      'SELECT 1 FROM auth.reach_sender_blocks WHERE principal_did = $1 AND requester_did = $2',
      [params.principalDid, params.requesterDid],
    );
    if (blocked.length) return { stored: false, reason: 'blocked' };

    const existing = await tx.unsafe<{ reach_id: string; envelope: ReachEnvelope; published_at: Date | null }[]>(
      'SELECT reach_id, envelope, published_at FROM auth.reach_envelopes WHERE principal_did = $1 AND requester_did = $2 AND transcript_hash = $3',
      [params.principalDid, params.requesterDid, params.transcriptHash],
    );
    if (existing.length) return {
      stored: true, reachId: existing[0].reach_id, replayed: true,
      signedEvent: existing[0].envelope.signedEvent, published: existing[0].published_at !== null,
    };

    // UTC calendar-day quotas are independent of session timezone and of
    // request-issued time. Use statement time after acquiring the lock.
    const [counts] = await tx.unsafe<{ principal_count: string; sender_count: string }[]>(`
      SELECT count(*) AS principal_count,
             count(*) FILTER (WHERE requester_did = $2) AS sender_count
      FROM auth.reach_envelopes
      WHERE principal_did = $1
        AND created_at >= date_trunc('day', statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND created_at < (date_trunc('day', statement_timestamp() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'
    `, [params.principalDid, params.requesterDid]);
    if ((dailyCap !== null && Number(counts.principal_count) >= dailyCap) || Number(counts.sender_count) >= perSenderDailyCap) {
      return { stored: false, reason: 'rate_limited' };
    }

    await tx.unsafe(`
      INSERT INTO auth.reach_envelopes
        (reach_id, principal_did, requester_did, transcript_hash, envelope, created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, statement_timestamp())
    `, [params.reachId, params.principalDid, params.requesterDid, params.transcriptHash, JSON.stringify(envelope)]);
    await tx.unsafe(`
      INSERT INTO auth.attestations
        (id, issuer_did, subject_did, type, context_id, context_type, payload, signature, cid, attestation_status, issued_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
    `, [
      deliveryAttestation.id, deliveryAttestation.issuerDid, deliveryAttestation.subjectDid, deliveryAttestation.type,
      deliveryAttestation.contextId, deliveryAttestation.contextType, JSON.stringify(deliveryAttestation.payload),
      deliveryAttestation.signature, deliveryAttestation.cid, deliveryAttestation.attestationStatus,
      deliveryAttestation.issuedAt.toISOString(),
    ]);
    return { stored: true, reachId: params.reachId, signedEvent: envelope.signedEvent, published: false };
  });
}
/** Only acknowledge successful bus publication; a pending event survives for caller retries. */
export async function markReachPublished(params: { principalDid: string; reachId: string }): Promise<void> {
  await getClient().unsafe(`
    UPDATE auth.reach_envelopes SET published_at = COALESCE(published_at, statement_timestamp())
    WHERE principal_did = $1 AND reach_id = $2
  `, [params.principalDid, params.reachId]);
}

/** principalDid must come from the authenticated owner, never the foreign sender. */
export async function getReachEnvelope(params: { principalDid: string; reachId: string }): Promise<ReachEnvelope | null> {
  const [row] = await getClient().unsafe<{ envelope: ReachEnvelope }[]>(
    'SELECT envelope FROM auth.reach_envelopes WHERE principal_did = $1 AND reach_id = $2',
    [params.principalDid, params.reachId],
  );
  return row?.envelope ?? null;
}

/** Owner-scoped inbox seam for #2597, newest delivery first. */
export async function listReachEnvelopes(params: {
  principalDid: string;
  limit?: number;
  offset?: number;
}): Promise<ReachEnvelope[]> {
  const limit = Math.min(100, Math.max(1, Math.trunc(params.limit ?? 25)));
  const offset = Math.max(0, Math.trunc(params.offset ?? 0));
  if (!Number.isFinite(limit) || !Number.isFinite(offset)) throw new Error('Invalid reach pagination');
  const rows = await getClient().unsafe<{ envelope: ReachEnvelope }[]>(`
    SELECT envelope FROM auth.reach_envelopes WHERE principal_did = $1
    ORDER BY created_at DESC, reach_id DESC LIMIT $2 OFFSET $3
  `, [params.principalDid, limit, offset]);
  return rows.map((row) => row.envelope);
}

/** Shares the delivery lock so a committed block prevents the next delivery. */
export async function blockReachSender(params: { principalDid: string; requesterDid: string }): Promise<void> {
  await getClient().begin('isolation level read committed', async (tx) => {
    await lockPrincipal(tx, params.principalDid);
    await tx.unsafe(`
      INSERT INTO auth.reach_sender_blocks (principal_did, requester_did)
      VALUES ($1, $2) ON CONFLICT (principal_did, requester_did) DO NOTHING
    `, [params.principalDid, params.requesterDid]);
  });
}
