import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { db, storedKeys } from '@/src/db';
import { eq } from 'drizzle-orm';
import { verifySessionToken, getSessionCookieOptions } from '@/lib/jwt';
import { corsHeaders } from '@imajin/config';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/stored-keys
 * Store a client-side encrypted private key.
 * Requires authentication. The server never sees the plaintext key.
 *
 * Body: {
 *   encryptedKey: string,    // AES-256-GCM ciphertext (client-side encrypted, base64)
 *   salt: string,            // PBKDF2 salt (base64)
 *   keyDerivation?: string,  // defaults to "pbkdf2"
 * }
 * Returns: { id: string, stored: true }
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
    const { encryptedKey, salt, keyDerivation } = body;

    if (!encryptedKey || !salt) {
      return NextResponse.json(
        { error: 'encryptedKey and salt are required' },
        { status: 400, headers: cors }
      );
    }

    // Upsert: one stored key per DID
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
          lastUsedAt: new Date(),
        })
        .where(eq(storedKeys.id, existing[0].id));

      return NextResponse.json({ id: existing[0].id, stored: true }, { headers: cors });
    }

    const id = `key_${nanoid(16)}`;
    await db.insert(storedKeys).values({
      id,
      did: session.sub,
      encryptedKey,
      salt,
      keyDerivation: keyDerivation ?? 'pbkdf2',
    });

    return NextResponse.json({ id, stored: true }, { headers: cors });

  } catch (error) {
    console.error('[stored-keys] POST error:', error);
    return NextResponse.json({ error: 'Failed to store key' }, { status: 500, headers: cors });
  }
}
