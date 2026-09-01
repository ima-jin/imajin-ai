import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';
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
 * a one-time recovery code plus a fresh, locally-generated public key.
 * On success, this authorizes a #401-style rotation to that new key —
 * the user is never handed key material, and neither is the server ever
 * given any.
 *
 * Deliberately NOT session-authenticated: that's the entire point of
 * recovery. Protected instead by per-DID and per-IP rate limiting,
 * constant-time code comparison, and an append-only audit trail of every
 * attempt (see src/lib/auth/recovery-codes.ts).
 *
 * Body: { did: string, code: string, newPublicKey: string (hex) }
 * Returns: { did, rotated: true, sessionsInvalidated: true, chainDeprecated, disclosure }
 */
export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);
  const ip = getClientIP(request);

  try {
    const body = await request.json().catch(() => ({}));
    const { did, code, newPublicKey } = body as { did?: string; code?: string; newPublicKey?: string };

    if (!did || typeof did !== 'string' || !code || typeof code !== 'string' || !newPublicKey || typeof newPublicKey !== 'string') {
      return NextResponse.json(
        { error: 'did, code, and newPublicKey are all required' },
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
