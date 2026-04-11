import { NextRequest, NextResponse } from 'next/server';
import { verify as totpVerify } from 'otplib';
import { nanoid } from 'nanoid';
import { db } from '@/src/db';
import { storedKeys, mfaMethods } from '@/src/db';
import { eq, and, isNotNull } from 'drizzle-orm';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { decryptSecret } from '@/src/lib/auth/encrypt';
import { corsHeaders } from '@imajin/config';
import { withLogger } from '@imajin/logger';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/keys/store
 * Store a client-side encrypted private key.
 * Requires authentication + active TOTP verification.
 * The server never sees the plaintext key — encryption happens client-side.
 *
 * Body: {
 *   encryptedKey: string,    // AES-256-GCM ciphertext (client-side encrypted)
 *   salt: string,            // PBKDF2 salt used client-side
 *   totpCode: string,        // Active TOTP code for MFA gate
 *   keyDerivation?: string,  // defaults to "pbkdf2"
 *   deviceFingerprint?: string
 * }
 * Returns: { id: string, stored: true }
 */
export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  try {
    const cookieConfig = getSessionCookieOptions();
    const token = request.cookies.get(cookieConfig.name)?.value;
    if (!token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: cors });
    }
    const session = await verifySessionToken(token);
    if (!session) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401, headers: cors });
    }

    const body = await request.json();
    const { encryptedKey, salt, totpCode, keyDerivation, deviceFingerprint } = body;

    if (!encryptedKey || !salt || !totpCode) {
      return NextResponse.json(
        { error: 'encryptedKey, salt, and totpCode are required' },
        { status: 400, headers: cors }
      );
    }

    // MFA gate: verify TOTP before allowing key storage
    const methods = await db
      .select()
      .from(mfaMethods)
      .where(
        and(
          eq(mfaMethods.did, session.sub),
          eq(mfaMethods.type, 'totp'),
          isNotNull(mfaMethods.verifiedAt)
        )
      )
      .limit(1);

    if (methods.length === 0) {
      return NextResponse.json(
        { error: 'MFA required. Set up TOTP first via /api/mfa/totp/setup.' },
        { status: 403, headers: cors }
      );
    }

    const mfaSecret = decryptSecret(methods[0].secret);
    const mfaResult = await totpVerify({ token: totpCode, secret: mfaSecret });
    if (!mfaResult.valid) {
      return NextResponse.json({ error: 'Invalid TOTP code' }, { status: 401, headers: cors });
    }

    // Upsert: one stored key per DID (unique constraint on did)
    const existing = await db
      .select({ id: storedKeys.id })
      .from(storedKeys)
      .where(eq(storedKeys.did, session.sub))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(storedKeys)
        .set({
          encryptedKey,
          salt,
          keyDerivation: keyDerivation ?? 'pbkdf2',
          deviceFingerprint: deviceFingerprint ?? null,
          lastUsedAt: new Date(),
        })
        .where(eq(storedKeys.id, existing[0].id));

      // Update MFA last used
      await db
        .update(mfaMethods)
        .set({ lastUsedAt: new Date() })
        .where(eq(mfaMethods.id, methods[0].id));

      return NextResponse.json({ id: existing[0].id, stored: true }, { headers: cors });
    }

    const id = `key_${nanoid(16)}`;
    await db.insert(storedKeys).values({
      id,
      did: session.sub,
      encryptedKey,
      salt,
      keyDerivation: keyDerivation ?? 'pbkdf2',
      deviceFingerprint: deviceFingerprint ?? null,
    });

    await db
      .update(mfaMethods)
      .set({ lastUsedAt: new Date() })
      .where(eq(mfaMethods.id, methods[0].id));

    return NextResponse.json({ id, stored: true }, { headers: cors });

  } catch (error) {
    log.error({ err: String(error) }, '[keys/store] POST error');
    return NextResponse.json({ error: 'Failed to store key' }, { status: 500, headers: cors });
  }
});
