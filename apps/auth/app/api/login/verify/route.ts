import { NextRequest, NextResponse } from 'next/server';
import { db, identities, challenges } from '@/src/db';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { verifySignature } from '@/lib/crypto';
import { createSessionToken, getSessionCookieOptions } from '@/lib/jwt';
import { emitSessionAttestation } from '@/lib/emit-session-attestation';

/**
 * POST /api/login/verify
 * Verify a signed challenge and create a session
 * 
 * Body: {
 *   challengeId: string,
 *   signature: string (hex)
 * }
 * 
 * Returns: {
 *   did: string,
 *   handle: string,
 *   type: string
 * }
 * 
 * Also sets session cookie
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { challengeId, signature } = body;

    if (!challengeId || !signature) {
      return NextResponse.json(
        { error: 'challengeId and signature required' },
        { status: 400 }
      );
    }

    // Find challenge (not used, not expired)
    const challengeResults = await db
      .select()
      .from(challenges)
      .where(
        and(
          eq(challenges.id, challengeId),
          isNull(challenges.usedAt),
          gt(challenges.expiresAt, new Date())
        )
      )
      .limit(1);

    const challenge = challengeResults[0];
    if (!challenge) {
      return NextResponse.json(
        { error: 'Challenge not found, expired, or already used' },
        { status: 400 }
      );
    }

    // Get identity
    const identityResults = await db
      .select()
      .from(identities)
      .where(eq(identities.id, challenge.identityId!))
      .limit(1);

    const identity = identityResults[0];
    if (!identity) {
      return NextResponse.json(
        { error: 'Identity not found' },
        { status: 404 }
      );
    }

    // Verify signature
    const isValid = await verifySignature(
      challenge.challenge,
      signature,
      identity.publicKey
    );

    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 401 }
      );
    }

    // Mark challenge as used
    await db
      .update(challenges)
      .set({ usedAt: new Date() })
      .where(eq(challenges.id, challengeId));

    // Store DFOS chain if provided (login-time bridging)
    if (body.dfosChain) {
      try {
        const { verifyClientChain, storeDfosChain } = await import('@/lib/dfos');
        const verified = await verifyClientChain(body.dfosChain, identity.publicKey);
        if (verified) {
          await storeDfosChain(identity.id, verified);
        }
      } catch (err) {
        console.error(`[login] DFOS bridge failed for ${identity.id}:`, err);
      }
    }

    // Create session token
    const token = await createSessionToken({
      sub: identity.id,
      handle: identity.handle || undefined,
      type: identity.type,
      name: identity.name || undefined,
      tier: (identity.tier as 'soft' | 'preliminary' | 'established') || 'preliminary',
    });

    // Set cookie and return
    const cookieConfig = getSessionCookieOptions();
    const response = NextResponse.json({
      did: identity.id,
      handle: identity.handle,
      type: identity.type,
      name: identity.name,
    });

    response.cookies.set(cookieConfig.name, token, cookieConfig.options);

    emitSessionAttestation({
      did: identity.id,
      method: "keypair",
      tier: identity.tier || "preliminary",
      userAgent: request.headers.get("user-agent"),
    }).catch(err => console.error("Session attestation error:", err));

    return response;

  } catch (error) {
    console.error('Verify error:', error);
    return NextResponse.json(
      { error: 'Failed to verify challenge' },
      { status: 500 }
    );
  }
}
