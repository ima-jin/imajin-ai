import { NextRequest, NextResponse } from 'next/server';
import { generateSecret, generateURI } from 'otplib';
import * as QRCode from 'qrcode';
import { nanoid } from 'nanoid';
import { db } from '@/src/db';
import { mfaMethods } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { encryptSecret } from '@/src/lib/auth/encrypt';
import { corsHeaders } from '@imajin/config';
import { withLogger } from '@imajin/logger';

const ISSUER = 'Imajin';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/mfa/totp/setup
 * Generate a TOTP secret and return the QR code URL.
 * Requires authentication. Call /api/mfa/totp/verify afterwards to activate.
 *
 * Body: { name?: string }
 * Returns: { secret, otpauthUrl, qrCode }
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

    const body = await request.json().catch(() => ({}));
    const name: string = body.name || 'Authenticator App';

    // Remove any unverified pending TOTP setup for this DID (clean state)
    await db
      .delete(mfaMethods)
      .where(
        and(
          eq(mfaMethods.did, session.sub),
          eq(mfaMethods.type, 'totp')
        )
      );

    const secret = generateSecret();
    const accountName = session.handle ?? session.sub;
    const otpauthUrl = generateURI({ issuer: ISSUER, label: accountName, secret });
    const qrCode = await QRCode.toDataURL(otpauthUrl);

    // Store encrypted secret (unverified until /verify is called)
    await db.insert(mfaMethods).values({
      id: `mfa_${nanoid(16)}`,
      did: session.sub,
      type: 'totp',
      secret: encryptSecret(secret),
      name,
    });

    return NextResponse.json({ secret, otpauthUrl, qrCode }, { headers: cors });

  } catch (error) {
    log.error({ err: String(error) }, '[mfa/totp/setup] POST error');
    return NextResponse.json({ error: 'Failed to set up TOTP' }, { status: 500, headers: cors });
  }
});
