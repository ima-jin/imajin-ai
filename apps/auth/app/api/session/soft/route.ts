import { NextRequest, NextResponse } from 'next/server';
import { createSessionToken, getSessionCookieOptions } from '@/lib/jwt';
import { db } from '@/src/db';
import { rateLimit, getClientIP } from '@/src/lib/rate-limit';
import { identities } from '@/src/db/schema';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { corsHeaders } from '@imajin/config';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/session/soft
 * Create a soft DID session from email (no keypair needed)
 *
 * Body: {
 *   email: string,
 *   name?: string
 * }
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 10, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  try {
    const body = await request.json();
    const { email, name } = body;

    // Validate email
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json(
        { error: 'Valid email required' },
        { status: 400, headers: cors }
      );
    }

    // Normalize email to lowercase
    const normalizedEmail = email.toLowerCase().trim();

    // Create did:email:xxx format (replace @ and . with _)
    const emailSlug = normalizedEmail.replace(/@/g, '_at_').replace(/\./g, '_');
    const did = `did:email:${emailSlug}`;

    // Check if identity already exists
    let identity = await db
      .select()
      .from(identities)
      .where(eq(identities.id, did))
      .limit(1);

    if (identity.length === 0) {
      // Create new soft DID identity
      // For soft DIDs, we use a placeholder public key
      const placeholderKey = `soft_${nanoid(32)}`;

      const [newIdentity] = await db
        .insert(identities)
        .values({
          id: did,
          type: 'human',
          publicKey: placeholderKey,
          handle: null,
          name: name?.trim() || null,
          metadata: { email: normalizedEmail, tier: 'soft' },
        })
        .returning();

      identity = [newIdentity];
    } else {
      // Update name if provided
      if (name) {
        const [updated] = await db
          .update(identities)
          .set({
            name: name.trim(),
            updatedAt: new Date(),
          })
          .where(eq(identities.id, did))
          .returning();

        identity = [updated];
      }
    }

    // Create session token with tier information
    const token = await createSessionToken({
      sub: identity[0].id,
      handle: identity[0].handle || undefined,
      type: identity[0].type,
      name: identity[0].name || undefined,
      tier: 'soft',
    });

    const cookieConfig = getSessionCookieOptions();
    const response = NextResponse.json({
      did: identity[0].id,
      handle: identity[0].handle,
      type: identity[0].type,
      name: identity[0].name,
      tier: 'soft',
    }, { headers: cors });

    response.cookies.set(cookieConfig.name, token, cookieConfig.options);
    return response;

  } catch (error) {
    console.error('Soft session error:', error);
    return NextResponse.json(
      { error: 'Failed to create soft session' },
      { status: 500, headers: cors }
    );
  }
}
