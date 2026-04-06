import { NextRequest, NextResponse } from 'next/server';
import { db, identities, storedKeys, mfaMethods } from '@/src/db';
import { eq, and, isNotNull } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { rateLimit, getClientIP } from '@/src/lib/auth/rate-limit';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/account/methods?handle=xxx (or ?did=xxx)
 * Public endpoint to look up auth methods for an identity.
 * Optional: includeKey=true to include encrypted blob for password login.
 *
 * Returns:
 * {
 *   did: string,
 *   hasStoredKey: boolean,
 *   encryptedKey?: string,
 *   salt?: string,
 *   keyDerivation?: string,
 *   mfaMethods: string[]
 * }
 */
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 20, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const handle = searchParams.get('handle');
    const did = searchParams.get('did');
    const includeKey = searchParams.get('includeKey') === 'true';

    if (!handle && !did) {
      return NextResponse.json({ error: 'handle or did required' }, { status: 400, headers: cors });
    }

    // Find identity
    let identity;
    if (did) {
      const results = await db
        .select()
        .from(identities)
        .where(eq(identities.id, did))
        .limit(1);
      identity = results[0];
    } else if (handle) {
      const results = await db
        .select()
        .from(identities)
        .where(eq(identities.handle, handle.toLowerCase().replace(/^@/, '')))
        .limit(1);
      identity = results[0];
    }

    if (!identity) {
      return NextResponse.json({ error: 'Identity not found' }, { status: 404, headers: cors });
    }

    // Check for stored key
    const keyRows = await db
      .select()
      .from(storedKeys)
      .where(eq(storedKeys.did, identity.id))
      .limit(1);

    const hasStoredKey = keyRows.length > 0;

    // Get active (verified) MFA methods
    const mfaRows = await db
      .select({ type: mfaMethods.type })
      .from(mfaMethods)
      .where(
        and(
          eq(mfaMethods.did, identity.id),
          isNotNull(mfaMethods.verifiedAt)
        )
      );

    const activeMfaMethods = mfaRows.map((r: { type: string }) => r.type);

    const response: Record<string, unknown> = {
      did: identity.id,
      hasStoredKey,
      mfaMethods: activeMfaMethods,
    };

    if (includeKey && hasStoredKey && keyRows[0]) {
      response.encryptedKey = keyRows[0].encryptedKey;
      response.salt = keyRows[0].salt;
      response.keyDerivation = keyRows[0].keyDerivation;
    }

    return NextResponse.json(response, { headers: cors });

  } catch (error) {
    console.error('[account/methods] GET error:', error);
    return NextResponse.json({ error: 'Failed to retrieve account methods' }, { status: 500, headers: cors });
  }
}
