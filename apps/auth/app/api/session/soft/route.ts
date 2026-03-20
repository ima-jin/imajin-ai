import { NextRequest, NextResponse } from 'next/server';
import { createSessionToken, getSessionCookieOptions } from '@/lib/jwt';
import { emitSessionAttestation } from '@/lib/emit-session-attestation';
import { db } from '@/src/db';
import { rateLimit, getClientIP } from '@/src/lib/rate-limit';
import { identities, credentials } from '@/src/db/schema';
import { eq, and } from 'drizzle-orm';
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

    // Check if a credential already exists for this email (prevents duplicate DIDs)
    const [existingCred] = await db
      .select({ did: credentials.did })
      .from(credentials)
      .where(and(eq(credentials.type, 'email'), eq(credentials.value, normalizedEmail)))
      .limit(1);

    let identity: typeof identities.$inferSelect[];

    if (existingCred?.did) {
      identity = await db
        .select()
        .from(identities)
        .where(eq(identities.id, existingCred.did))
        .limit(1);

      // Update name if provided
      if (name && identity.length > 0) {
        const [updated] = await db
          .update(identities)
          .set({ name: name.trim(), updatedAt: new Date() })
          .where(eq(identities.id, existingCred.did))
          .returning();
        identity = [updated];
      }
    } else {
      // Mint a new stable DID
      const did = `did:imajin:${nanoid(16)}`;
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

      // Insert email credential
      await db.insert(credentials).values({
        id: `cred_${nanoid(16)}`,
        did,
        type: 'email',
        value: normalizedEmail,
        verifiedAt: new Date(),
      });

      identity = [newIdentity];
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

    emitSessionAttestation({
      did: identity[0].id,
      method: "email_soft",
      tier: "soft",
      userAgent: request.headers.get("user-agent"),
    }).catch(err => console.error("Session attestation error:", err));

    return response;

  } catch (error) {
    console.error('Soft session error:', error);
    return NextResponse.json(
      { error: 'Failed to create soft session' },
      { status: 500, headers: cors }
    );
  }
}
