import { NextRequest, NextResponse } from 'next/server';
import { db, identities, challenges } from '@/src/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { corsHeaders, rateLimit, getClientIP } from '@imajin/config';
import { generateChallenge } from '@/src/lib/auth/crypto';
import { CHALLENGE_TTL } from '@imajin/auth';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /auth/api/recovery-codes/challenge?did=...
 *
 * Step one of the recovery ceremony (#1250 Phase 1 hardening): before a
 * caller can redeem a recovery code, they must prove possession of the
 * fresh, locally-generated key they want to rotate to. This issues a
 * short-lived challenge tied to `did`, signed by the NEW key (not any key
 * currently on file) and submitted alongside the code as `proofOfNewKey` to
 * POST /auth/api/recovery-codes/verify.
 *
 * Deliberately unauthenticated — same reasoning as /auth/api/login/challenge
 * and /auth/api/recovery-codes/verify: the caller has no working key.
 * Rate limited per-DID and per-IP, same posture as the redeem endpoint,
 * since this is still part of the account-takeover surface.
 */
export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);
  const ip = getClientIP(request);

  try {
    const { searchParams } = new URL(request.url);
    const did = searchParams.get('did');

    if (!did) {
      return NextResponse.json({ error: 'did required' }, { status: 400, headers: cors });
    }

    const didLimit = rateLimit(`recovery:challenge:did:${did}`, 10, 15 * 60_000);
    const ipLimit = rateLimit(`recovery:challenge:ip:${ip}`, 30, 15 * 60_000);
    if (didLimit.limited || ipLimit.limited) {
      const retryAfter = Math.max(didLimit.retryAfter, ipLimit.retryAfter);
      return NextResponse.json(
        { error: 'Too many requests', retryAfter },
        { status: 429, headers: { ...cors, 'Retry-After': String(retryAfter) } },
      );
    }

    const [identity] = await db.select().from(identities).where(eq(identities.id, did)).limit(1);
    if (!identity) {
      return NextResponse.json({ error: 'Identity not found' }, { status: 404, headers: cors });
    }
    if (identity.tier === 'soft') {
      return NextResponse.json(
        { error: 'Recovery codes require a self-custody identity' },
        { status: 403, headers: cors },
      );
    }

    const challengeId = `rchl_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const challenge = generateChallenge();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL);

    await db.insert(challenges).values({
      id: challengeId,
      identityId: did,
      challenge,
      expiresAt,
    });

    return NextResponse.json({ challengeId, challenge, expiresAt: expiresAt.toISOString() }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, '[recovery-codes/challenge] GET error');
    return NextResponse.json({ error: 'Failed to create challenge' }, { status: 500, headers: cors });
  }
});
