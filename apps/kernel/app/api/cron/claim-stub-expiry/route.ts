import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, claimStubIndex, identities, attestations, invites } from '@/src/db';
import { getNodeDid } from '@/src/lib/kernel/node-identity';

const log = createLogger('kernel');

/**
 * This route mutates the database and must never be evaluated at build time.
 * See vault-grant-expiry's route for the full rationale.
 */
export const dynamic = 'force-dynamic';

/** Non-terminal attestation statuses eligible to cascade to `lapsed` (#1841 design consideration 4). */
const LAPSABLE_ATTESTATION_STATUSES = ['pending', 'collecting'] as const;

interface SweptStub {
  did: string;
  lapsedAttestationIds: string[];
  lapsedInviteIds: string[];
}

/**
 * Per-DID transaction: tombstones one unclaimed stub and cascades its
 * dependent rows, or is a no-op if the guard conditions no longer hold by
 * the time the transaction runs (lost a race to a concurrent claim, a
 * fresh pending invite, or a concurrent sweep). Returns `null` on a no-op.
 *
 * Guard (design consideration 1 — never expire while reminders may still be
 * in flight): the DID must have no `connections.invites` row with
 * `status = 'pending'`. Re-checked here, inside the transaction, even
 * though the caller already filtered candidates — the invite table isn't
 * locked between the outer scan and this transaction.
 */
async function sweepStub(did: string, now: Date): Promise<SweptStub | null> {
  return db.transaction(async (tx) => {
    const [pendingInvite] = await tx
      .select({ id: invites.id })
      .from(invites)
      .where(and(eq(invites.toDid, did), eq(invites.status, 'pending')))
      .limit(1);
    if (pendingInvite) return null;

    const [identity] = await tx
      .select({ tier: identities.tier })
      .from(identities)
      .where(eq(identities.id, did))
      .limit(1);
    if (identity?.tier !== 'soft') return null;

    // Tombstone, never delete (design consideration 2): stub_status flips
    // in place, email_hmac/email_encrypted are left untouched. The WHERE
    // clause is the atomic CAS — a concurrent claim or sweep loses the race
    // cleanly instead of double-processing.
    const [expired] = await tx
      .update(claimStubIndex)
      .set({ stubStatus: 'expired', expiredAt: now })
      .where(
        and(
          eq(claimStubIndex.did, did),
          eq(claimStubIndex.stubStatus, 'active'),
          isNotNull(claimStubIndex.stubExpiresAt),
          lt(claimStubIndex.stubExpiresAt, now),
        ),
      )
      .returning({ id: claimStubIndex.id });
    if (!expired) return null;

    // Cascade non-terminal attestations whose subject is the swept DID to
    // the new terminal `lapsed` state (design consideration 4) — distinct
    // from `expired`, which already means "this attestation's own TTL
    // passed" (swept separately by /api/cron/attestation-cleanup).
    const lapsedAttestations = await tx
      .update(attestations)
      .set({ attestationStatus: 'lapsed', lapsedAt: now })
      .where(and(eq(attestations.subjectDid, did), inArray(attestations.attestationStatus, LAPSABLE_ATTESTATION_STATUSES)))
      .returning({ id: attestations.id });

    // Defensive cascade for pending invites targeting the DID. In steady
    // state this set is empty — the guard above already excludes any DID
    // with a pending invite — but this covers the race between that check
    // and this transaction committing.
    const lapsedInvites = await tx
      .update(invites)
      .set({ status: 'lapsed', lapsedAt: now })
      .where(and(eq(invites.toDid, did), eq(invites.status, 'pending')))
      .returning({ id: invites.id });

    return {
      did,
      lapsedAttestationIds: lapsedAttestations.map((row) => row.id),
      lapsedInviteIds: lapsedInvites.map((row) => row.id),
    };
  });
}

/**
 * GET /api/cron/claim-stub-expiry — sweep unclaimed stubs past their TTL (#1841).
 *
 * Vercel Cron job (schedule: "0 0 * * *" — daily). Registered in vercel.json.
 * Protected by Authorization: Bearer {CRON_SECRET}, same convention as every
 * other cron route.
 *
 * Ratified policy (proposal comment on #1841, 2026-08-31): tombstone (never
 * delete) an unclaimed stub once `stub_expires_at` has passed, provided no
 * `connections.invites` row is still `pending` against it. Cascades pending/
 * collecting attestations and pending invites targeting the DID to the new
 * terminal `lapsed` state, and publishes `identity.stub.lapsed` per swept DID
 * so a future reminder-ladder consumer can cancel any last-second send.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const now = new Date();

    // Candidate active stubs past their TTL (idx_claim_stub_index_expiry).
    // The remaining guards (tier, no pending invite) are re-checked per-DID
    // inside sweepStub's transaction.
    const candidates = await db
      .select({ did: claimStubIndex.did })
      .from(claimStubIndex)
      .where(
        and(
          eq(claimStubIndex.stubStatus, 'active'),
          isNotNull(claimStubIndex.stubExpiresAt),
          lt(claimStubIndex.stubExpiresAt, now),
        ),
      );

    const swept: SweptStub[] = [];
    for (const candidate of candidates) {
      const result = await sweepStub(candidate.did, now);
      if (result) swept.push(result);
    }

    if (swept.length > 0) {
      const nodeDid = await getNodeDid();
      for (const stub of swept) {
        publish('identity.stub.lapsed', {
          issuer: nodeDid,
          subject: stub.did,
          scope: 'auth',
          payload: {
            did: stub.did,
            lapsedAttestationIds: stub.lapsedAttestationIds,
            lapsedInviteIds: stub.lapsedInviteIds,
            context_id: stub.did,
            context_type: 'identity.stub',
          },
        }).catch((err: unknown) => {
          log.error(
            { err: String(err), did: stub.did },
            'Bus publish error for identity.stub.lapsed (claim-stub expiry sweep)',
          );
        });
      }
    }

    log.info({ swept: swept.length }, 'Claim-stub expiry sweep complete');

    return NextResponse.json({
      ok: true,
      swept: swept.length,
      dids: swept.map((s) => s.did),
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Claim-stub expiry sweep failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
