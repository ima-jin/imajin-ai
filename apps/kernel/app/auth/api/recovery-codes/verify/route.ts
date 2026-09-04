import { NextRequest, NextResponse } from 'next/server';
import { db, challenges } from '@/src/db';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { corsHeaders, rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { verifySignature } from '@/src/lib/auth/crypto';
import { redeemRecoveryCode, logRecoveryAttempt } from '@/src/lib/auth/recovery-codes';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

// Generic, information-non-leaking error for every failure mode that could
// otherwise act as a DID/code-existence oracle. Distinct outcomes are still
// captured internally via the audit log (logRecoveryAttempt).
const GENERIC_ERROR = 'Invalid recovery code';

/**
 * POST /auth/api/recovery-codes/verify
 *
 * The recovery ceremony (#1250 Phase 1): a user with NO working key submits
 * a one-time recovery code, a fresh, locally-generated public key, and
 * `proofOfNewKey` — a signature by that new key's private half over a
 * challenge obtained from GET /auth/api/recovery-codes/challenge. On
 * success, this authorizes a #401-style rotation to the new key — the user
 * is never handed key material, and neither is the server ever given any.
 *
 * Deliberately NOT session-authenticated: that's the entire point of
 * recovery. Protected instead by per-DID and per-IP rate limiting,
 * constant-time code comparison, proof of possession of the new key, and an
 * append-only audit trail of every attempt (see src/lib/auth/recovery-codes.ts).
 *
 * Body: { did: string, code: string, newPublicKey: string (hex), challengeId: string, proofOfNewKey: string (hex signature) }
 * Returns: { did, rotated: true, sessionsInvalidated: true, chainDeprecated, disclosure }
 */
export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);
  const ip = getClientIP(request);

  try {
    const body = await request.json().catch(() => ({}));
    const { did, code, newPublicKey, challengeId, proofOfNewKey } = body as {
      did?: string; code?: string; newPublicKey?: string; challengeId?: string; proofOfNewKey?: string;
    };

    if (
      !did || typeof did !== 'string' ||
      !code || typeof code !== 'string' ||
      !newPublicKey || typeof newPublicKey !== 'string' ||
      !challengeId || typeof challengeId !== 'string' ||
      !proofOfNewKey || typeof proofOfNewKey !== 'string'
    ) {
      return NextResponse.json(
        { error: 'did, code, newPublicKey, challengeId, and proofOfNewKey are all required' },
        { status: 400, headers: cors },
      );
    }

    // Anti-takeover: recovery is THE account-takeover surface. Rate limit
    // both per-DID (a targeted attack on one account) and per-IP (a
    // credential-stuffing sweep across many DIDs).
    const didLimit = rateLimit(`recovery:verify:did:${did}`, 5, 15 * 60_000);
    const ipLimit = rateLimit(`recovery:verify:ip:${ip}`, 20, 15 * 60_000);
    if (didLimit.limited || ipLimit.limited) {
      await logRecoveryAttempt({ did, ip, outcome: 'rate_limited' });
      const retryAfter = Math.max(didLimit.retryAfter, ipLimit.retryAfter);
      return NextResponse.json(
        { error: 'Too many recovery attempts', retryAfter },
        { status: 429, headers: { ...cors, 'Retry-After': String(retryAfter) } },
      );
    }

    // Proof of possession of the new key: the challenge must exist, be
    // unused, unexpired, and issued for this exact DID.
    const [challenge] = await db
      .select()
      .from(challenges)
      .where(
        and(
          eq(challenges.id, challengeId),
          eq(challenges.identityId, did),
          isNull(challenges.usedAt),
          gt(challenges.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!challenge) {
      await logRecoveryAttempt({ did, ip, outcome: 'invalid_challenge' });
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 401, headers: cors });
    }

    const proofValid = await verifySignature(challenge.challenge, proofOfNewKey, newPublicKey);
    if (!proofValid) {
      await logRecoveryAttempt({ did, ip, outcome: 'invalid_proof' });
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 401, headers: cors });
    }

    // Single-use, same as any other challenge in this codebase.
    await db.update(challenges).set({ usedAt: new Date() }).where(eq(challenges.id, challengeId));

    const result = await redeemRecoveryCode({ did, code, newPublicKeyHex: newPublicKey, ip });

    if (!result.ok) {
      const status = result.reason === 'invalid_public_key' ? 400 : result.reason === 'public_key_conflict' ? 409 : 401;
      return NextResponse.json({ error: GENERIC_ERROR }, { status, headers: cors });
    }

    return NextResponse.json(
      {
        did,
        rotated: true,
        sessionsInvalidated: result.sessionsInvalidated,
        chainDeprecated: result.chainDeprecated,
        disclosure: result.disclosure,
      },
      { headers: cors },
    );
  } catch (error) {
    log.error({ err: String(error) }, '[recovery-codes/verify] POST error');
    return NextResponse.json({ error: 'Failed to process recovery request' }, { status: 500, headers: cors });
  }
});
