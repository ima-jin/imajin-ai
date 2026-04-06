import { NextRequest, NextResponse } from 'next/server';
import { verify as totpVerify } from 'otplib';
import { db } from '@/src/db';
import { storedKeys, mfaMethods } from '@/src/db';
import { eq, and, isNotNull } from 'drizzle-orm';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { decryptSecret } from '@/src/lib/auth/encrypt';
import { corsHeaders } from '@imajin/config';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/keys/retrieve
 * Return the stored encrypted private key after MFA verification.
 * The key is returned as-is (still client-side encrypted) — server never sees plaintext.
 *
 * Body: { totpCode: string }
 * Returns: { encryptedKey, salt, keyDerivation }
 */
export async function POST(request: NextRequest) {
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
    const { totpCode } = body;
    if (!totpCode) {
      return NextResponse.json({ error: 'totpCode required' }, { status: 400, headers: cors });
    }

    // MFA gate
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
      return NextResponse.json({ error: 'No active MFA method found' }, { status: 403, headers: cors });
    }

    const mfaSecret = decryptSecret(methods[0].secret);
    const mfaResult = await totpVerify({ token: totpCode, secret: mfaSecret });
    if (!mfaResult.valid) {
      return NextResponse.json({ error: 'Invalid TOTP code' }, { status: 401, headers: cors });
    }

    // Fetch the stored key
    const keys = await db
      .select()
      .from(storedKeys)
      .where(eq(storedKeys.did, session.sub))
      .limit(1);

    if (keys.length === 0) {
      return NextResponse.json({ error: 'No stored key found' }, { status: 404, headers: cors });
    }

    const key = keys[0];

    // Update usage timestamps
    await db
      .update(storedKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(storedKeys.id, key.id));
    await db
      .update(mfaMethods)
      .set({ lastUsedAt: new Date() })
      .where(eq(mfaMethods.id, methods[0].id));

    return NextResponse.json(
      { encryptedKey: key.encryptedKey, salt: key.salt, keyDerivation: key.keyDerivation },
      { headers: cors }
    );

  } catch (error) {
    console.error('[keys/retrieve] POST error:', error);
    return NextResponse.json({ error: 'Failed to retrieve key' }, { status: 500, headers: cors });
  }
}
