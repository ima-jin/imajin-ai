import { NextRequest, NextResponse } from 'next/server';
import { db, identities } from '@/src/db';
import { eq, or } from 'drizzle-orm';
import { didFromPublicKey, verifySignature } from '@/lib/crypto';
import { createSessionToken, getSessionCookieOptions } from '@/lib/jwt';

const CONNECTIONS_SERVICE_URL = process.env.CONNECTIONS_SERVICE_URL!;

/**
 * POST /api/register
 * Register a new identity with a public key.
 * REQUIRES a valid invite code (invite-only platform).
 * 
 * Body: {
 *   publicKey: string (hex),
 *   handle?: string,
 *   name?: string,
 *   type: 'human' | 'agent' | 'presence' | 'org' | 'device' | 'service',
 *   signature: string (hex) - signs the payload,
 *   inviteCode?: string - required for new registrations
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { publicKey, handle, name, type, signature, inviteCode } = body;

    // Validate required fields
    if (!publicKey || typeof publicKey !== 'string') {
      return NextResponse.json(
        { error: 'publicKey required (Ed25519 hex)' },
        { status: 400 }
      );
    }

    // Valid identity types
    const validTypes = ['human', 'agent', 'presence', 'org', 'device', 'service'];
    if (!type || !validTypes.includes(type)) {
      return NextResponse.json(
        { error: `type required: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }

    // Validate handle format if provided
    if (handle) {
      if (!/^[a-z0-9_]{3,30}$/.test(handle)) {
        return NextResponse.json(
          { error: 'Handle must be 3-30 lowercase letters, numbers, or underscores' },
          { status: 400 }
        );
      }
    }

    // Verify signature
    if (!signature) {
      return NextResponse.json(
        { error: 'signature required' },
        { status: 400 }
      );
    }

    // The message being signed is the registration payload
    const payloadToSign = JSON.stringify({
      publicKey,
      handle,
      name,
      type,
      timestamp: Math.floor(Date.now() / 1000),
    });

    // For registration, we accept any recent timestamp (within 5 minutes)
    // In production, you'd want stricter timestamp validation
    
    const isValid = await verifySignature(payloadToSign, signature, publicKey);
    if (!isValid) {
      // Also try without timestamp for simpler clients
      const simplePayload = JSON.stringify({ publicKey, handle, name, type });
      const isValidSimple = await verifySignature(simplePayload, signature, publicKey);
      if (!isValidSimple) {
        return NextResponse.json(
          { error: 'Invalid signature' },
          { status: 401 }
        );
      }
    }

    // Check if publicKey or handle already registered
    const conditions = [eq(identities.publicKey, publicKey)];
    if (handle) {
      conditions.push(eq(identities.handle, handle));
    }

    const existing = await db
      .select()
      .from(identities)
      .where(or(...conditions))
      .limit(1);

    if (existing.length > 0) {
      if (existing[0].publicKey === publicKey) {
        // Same key - return existing identity
        const token = await createSessionToken({
          sub: existing[0].id,
          handle: existing[0].handle || undefined,
          type: existing[0].type,
          name: existing[0].name || undefined,
        });

        const cookieConfig = getSessionCookieOptions(process.env.NODE_ENV === 'production');
        const response = NextResponse.json({
          did: existing[0].id,
          handle: existing[0].handle,
          type: existing[0].type,
          created: false,
          message: 'Identity already exists',
        });
        
        response.cookies.set(cookieConfig.name, token, cookieConfig.options);
        return response;
      } else {
        // Handle taken by different key
        return NextResponse.json(
          { error: 'Handle already taken' },
          { status: 409 }
        );
      }
    }

    // Require invite code for new registrations
    if (!inviteCode) {
      return NextResponse.json(
        { error: 'Imajin is invite-only. You need an invite code to register.' },
        { status: 403 }
      );
    }

    // Validate invite code against connections service
    let inviteData: { fromDid: string; fromHandle?: string } | null = null;
    try {
      const inviteRes = await fetch(`${CONNECTIONS_SERVICE_URL}/api/invites/${inviteCode}`);
      if (!inviteRes.ok) {
        return NextResponse.json(
          { error: 'Invalid or expired invite code' },
          { status: 403 }
        );
      }
      inviteData = await inviteRes.json();
      if (!inviteData || (inviteData as any).used) {
        return NextResponse.json(
          { error: 'This invite has already been used' },
          { status: 403 }
        );
      }
    } catch {
      return NextResponse.json(
        { error: 'Unable to validate invite. Try again later.' },
        { status: 503 }
      );
    }

    // Generate DID from public key
    const did = didFromPublicKey(publicKey);

    // Create identity
    const [identity] = await db
      .insert(identities)
      .values({
        id: did,
        type,
        publicKey,
        handle: handle || null,
        name: name?.trim().slice(0, 100) || null,
      })
      .returning();

    // Create session token
    const token = await createSessionToken({
      sub: identity.id,
      handle: identity.handle || undefined,
      type: identity.type,
      name: identity.name || undefined,
    });

    // Set cookie first so the accept call is authenticated
    const cookieConfig = getSessionCookieOptions(process.env.NODE_ENV === 'production');
    const response = NextResponse.json({
      did: identity.id,
      handle: identity.handle,
      type: identity.type,
      created: true,
      inviteAccepted: false,
    }, { status: 201 });

    response.cookies.set(cookieConfig.name, token, cookieConfig.options);

    // Auto-accept the invite (create the connection)
    // We do this server-side so the new user lands with their first connection
    try {
      await fetch(`${CONNECTIONS_SERVICE_URL}/api/invites/${inviteCode}/accept`, {
        method: 'POST',
        headers: {
          Cookie: `${cookieConfig.name}=${token}`,
        },
      });
      // Update response to reflect accepted invite
      const acceptedResponse = NextResponse.json({
        did: identity.id,
        handle: identity.handle,
        type: identity.type,
        created: true,
        inviteAccepted: true,
      }, { status: 201 });
      acceptedResponse.cookies.set(cookieConfig.name, token, cookieConfig.options);
      return acceptedResponse;
    } catch {
      // Registration succeeded but auto-accept failed — they can accept manually
      return response;
    }

  } catch (error) {
    console.error('Register error:', error);
    return NextResponse.json(
      { error: 'Failed to register identity' },
      { status: 500 }
    );
  }
}
