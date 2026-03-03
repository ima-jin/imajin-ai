import { NextRequest, NextResponse } from 'next/server';
import { createSessionToken, getSessionCookieOptions } from '@/lib/jwt';
import { db } from '@/src/db';
import { identities } from '@/src/db/schema';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

function corsHeaders(request: NextRequest) {
  const origin = request.headers.get('origin') || '';
  // Allow any *.imajin.ai subdomain
  const allowed = origin.endsWith('.imajin.ai') || origin === 'https://imajin.ai';
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

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

    const cookieConfig = getSessionCookieOptions(process.env.NODE_ENV === 'production');
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
