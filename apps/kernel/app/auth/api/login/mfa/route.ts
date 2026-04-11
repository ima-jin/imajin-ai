import { NextRequest, NextResponse } from 'next/server';
import { verify as totpVerify } from 'otplib';
import { db, identities, mfaMethods } from '@/src/db';
import { eq, and, isNotNull } from 'drizzle-orm';
import { verifyMfaChallengeToken, createSessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { decryptSecret } from '@/src/lib/auth/encrypt';
import { verifyEmailMfaCode } from '@/src/lib/auth/email-mfa-codes';
import { emitSessionAttestation } from '@/src/lib/auth/emit-session-attestation';
import { corsHeaders } from '@imajin/config';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/login/mfa
 * Complete MFA challenge and create a session.
 *
 * Body: {
 *   challengeToken: string,
 *   method: 'totp' | 'email',
 *   code: string,
 *   trustDevice?: boolean
 * }
 *
 * Returns: { did, handle, type }
 * Also sets session cookie.
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  try {
    const body = await request.json();
    const { challengeToken, method, code, trustDevice } = body;

    if (!challengeToken || !method || !code) {
      return NextResponse.json(
        { error: 'challengeToken, method, and code are required' },
        { status: 400, headers: cors }
      );
    }

    // Verify challenge token
    const challenge = await verifyMfaChallengeToken(challengeToken);
    if (!challenge) {
      return NextResponse.json(
        { error: 'Invalid or expired challenge token' },
        { status: 401, headers: cors }
      );
    }

    if (!challenge.methods.includes(method)) {
      return NextResponse.json(
        { error: 'Method not available for this challenge' },
        { status: 400, headers: cors }
      );
    }

    // Load identity
    const identityRows = await db
      .select()
      .from(identities)
      .where(eq(identities.id, challenge.sub))
      .limit(1);

    const identity = identityRows[0];
    if (!identity) {
      return NextResponse.json({ error: 'Identity not found' }, { status: 404, headers: cors });
    }

    // Verify MFA code
    let mfaValid = false;

    if (method === 'totp') {
      const methodRows = await db
        .select()
        .from(mfaMethods)
        .where(
          and(
            eq(mfaMethods.did, identity.id),
            eq(mfaMethods.type, 'totp'),
            isNotNull(mfaMethods.verifiedAt)
          )
        )
        .limit(1);

      if (methodRows.length > 0) {
        const secret = decryptSecret(methodRows[0].secret);
        const result = await totpVerify({ token: code, secret });
        mfaValid = result.valid;

        if (mfaValid) {
          // Update last used
          await db
            .update(mfaMethods)
            .set({ lastUsedAt: new Date() })
            .where(eq(mfaMethods.id, methodRows[0].id));
        }
      }
    } else if (method === 'email') {
      mfaValid = verifyEmailMfaCode(identity.id, code);
    }

    if (!mfaValid) {
      return NextResponse.json({ error: 'Invalid MFA code' }, { status: 401, headers: cors });
    }

    // Create session
    const token = await createSessionToken({
      sub: identity.id,
      handle: identity.handle || undefined,
      type: identity.type,
      name: identity.name || undefined,
      tier: (identity.tier as 'soft' | 'preliminary' | 'established') || 'preliminary',
    });

    const cookieConfig = getSessionCookieOptions();
    const response = NextResponse.json({
      did: identity.id,
      handle: identity.handle,
      type: identity.type,
      name: identity.name,
    }, { headers: cors });

    response.cookies.set(cookieConfig.name, token, cookieConfig.options);

    emitSessionAttestation({
      did: identity.id,
      method: 'keypair',
      tier: identity.tier || 'preliminary',
      userAgent: request.headers.get('user-agent'),
    }).catch(err => log.error({ err: String(err) }, 'Session attestation error'));

    import('@/src/lib/auth/log-device').then(({ logDevice }) => {
      const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim()
        ?? request.headers.get('x-real-ip');
      const userAgent = request.headers.get('user-agent');
      return logDevice({ did: identity.id, ip: ip ?? null, userAgent });
    }).catch(err => log.error({ err: String(err) }, '[mfa] Device log failed'));

    return response;

  } catch (error) {
    log.error({ err: String(error) }, '[login/mfa] POST error');
    return NextResponse.json({ error: 'Failed to complete MFA' }, { status: 500, headers: cors });
  }
}
