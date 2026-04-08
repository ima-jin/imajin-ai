import { db } from '@/src/db';
import { identities, attestations, connections } from '@/src/db';
import { emitAttestation } from '@imajin/auth';
import { eq, or, and, isNull, count, sql } from 'drizzle-orm';

const platformDid = process.env.RELAY_DID || process.env.AUTH_DID || '';

/**
 * Checks whether a DID is eligible for preliminary verification.
 * - Must currently be 'soft' tier
 * - Must have a handle
 * - Must have ≥1 active connection to a human with tier 'preliminary' or 'established'
 *
 * If eligible, emits `identity.verified.preliminary` and upgrades tier to 'preliminary'.
 */
export async function checkPreliminaryEligibility(did: string): Promise<void> {
  const [identity] = await db
    .select({ tier: identities.tier, handle: identities.handle })
    .from(identities)
    .where(eq(identities.id, did))
    .limit(1);

  if (!identity || identity.tier !== 'soft') return;
  if (!identity.handle) return;

  // Check for ≥1 active connection to a preliminary+ human
  const qualifiedConnections = await db
    .selectDistinct({ partnerDid: identities.id })
    .from(connections)
    .innerJoin(
      identities,
      or(
        and(eq(connections.didA, did), eq(identities.id, connections.didB)),
        and(eq(connections.didB, did), eq(identities.id, connections.didA))
      )
    )
    .where(
      and(
        isNull(connections.disconnectedAt),
        eq(identities.type, 'human'),
        or(eq(identities.tier, 'preliminary'), eq(identities.tier, 'established'))
      )
    )
    .limit(1);

  if (qualifiedConnections.length === 0) return;

  // Atomic CAS — only upgrade if still 'soft', prevents double emission on concurrent events
  const [upgraded] = await db
    .update(identities)
    .set({ tier: 'preliminary', updatedAt: new Date() })
    .where(and(eq(identities.id, did), eq(identities.tier, 'soft')))
    .returning({ id: identities.id });

  if (!upgraded) return; // Already upgraded by concurrent event

  emitAttestation({
    issuer_did: platformDid,
    subject_did: did,
    type: 'identity.verified.preliminary',
    context_id: did,
    context_type: 'identity',
  }).catch((err) => console.error('[verification] preliminary emit error:', err));
}

/**
 * Checks whether a DID is eligible for hard (established) verification.
 * - Must currently be 'preliminary' tier
 * - Must have ≥25 active person connections
 * - Must have ≥1 event.attendance attestation
 * - Must have claimed handle ≥4 weeks ago
 *
 * If eligible, emits `identity.verified.hard` and upgrades tier to 'established'.
 */
export async function checkHardEligibility(did: string): Promise<void> {
  const [identity] = await db
    .select({ tier: identities.tier, handleClaimedAt: identities.handleClaimedAt })
    .from(identities)
    .where(eq(identities.id, did))
    .limit(1);

  if (!identity || identity.tier !== 'preliminary') return;

  // Check handle claimed ≥4 weeks ago
  if (!identity.handleClaimedAt) return;
  const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
  if (identity.handleClaimedAt > fourWeeksAgo) return;

  // Check ≥25 active person connections (SQL count, not JS)
  const [{ total }] = await db
    .select({ total: count() })
    .from(connections)
    .innerJoin(
      identities,
      or(
        and(eq(connections.didA, did), eq(identities.id, connections.didB)),
        and(eq(connections.didB, did), eq(identities.id, connections.didA))
      )
    )
    .where(and(isNull(connections.disconnectedAt), eq(identities.type, 'human')));

  if (total < 25) return;

  // Check ≥1 event.attendance attestation for this DID
  const [attendanceRow] = await db
    .select({ id: attestations.id })
    .from(attestations)
    .where(
      and(eq(attestations.subjectDid, did), eq(attestations.type, 'event.attendance'))
    )
    .limit(1);

  if (!attendanceRow) return;

  // Atomic CAS — only upgrade if still 'preliminary', prevents double emission
  const [upgraded] = await db
    .update(identities)
    .set({ tier: 'established', updatedAt: new Date() })
    .where(and(eq(identities.id, did), eq(identities.tier, 'preliminary')))
    .returning({ id: identities.id });

  if (!upgraded) return; // Already upgraded by concurrent event

  emitAttestation({
    issuer_did: platformDid,
    subject_did: did,
    type: 'identity.verified.hard',
    context_id: did,
    context_type: 'identity',
  }).catch((err) => console.error('[verification] hard emit error:', err));
}
