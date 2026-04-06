import { NextRequest, NextResponse } from 'next/server';
import { db, identities } from '@/src/db';
import { eq, or } from 'drizzle-orm';
import { didFromPublicKey, verifySignature } from '@/src/lib/auth/crypto';
import { createSessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { rateLimit, getClientIP } from '@/src/lib/kernel/rate-limit';

const CONNECTIONS_SERVICE_URL = process.env.CONNECTIONS_SERVICE_URL!;
const PROFILE_SERVICE_URL = process.env.PROFILE_SERVICE_URL!;

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
  const ip = getClientIP(request);
  const rl = rateLimit(ip, 5, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  try {
    const body = await request.json();
    const { publicKey, handle, name, type, signature, inviteCode, email, phone, optInUpdates } = body;

    // Validate required fields
    if (!publicKey || typeof publicKey !== 'string') {
      return NextResponse.json(
        { error: 'publicKey required (Ed25519 hex)' },
        { status: 400 }
      );
    }

    // Valid identity types
    const validTypes = ['human', 'agent', 'presence', 'org', 'device', 'service', 'event'];
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
        // Same key - return existing identity (login-via-register flow)
        let existingDfosLinked = false;
        if (body.dfosChain) {
          try {
            const { verifyClientChain, storeDfosChain } = await import('@/lib/dfos');
            const verified = await verifyClientChain(body.dfosChain, publicKey);
            if (verified) {
              existingDfosLinked = await storeDfosChain(existing[0].id, verified);
            }
          } catch (err) {
            console.error(`[register] DFOS bridge failed for ${existing[0].id}:`, err);
          }
        }

        const token = await createSessionToken({
          sub: existing[0].id,
          handle: existing[0].handle || undefined,
          type: existing[0].type,
          name: existing[0].name || undefined,
          tier: (existing[0].tier as 'soft' | 'preliminary' | 'established') || 'preliminary',
        });

        const cookieConfig = getSessionCookieOptions();
        const response = NextResponse.json({
          did: existing[0].id,
          handle: existing[0].handle,
          type: existing[0].type,
          created: false,
          message: 'Identity already exists',
          dfosChainLinked: existingDfosLinked,
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

    // Require invite code for new registrations (skip in dev with DISABLE_INVITE_GATE=true)
    // Service-to-service registrations (events, agents, etc.) bypass the invite gate
    const inviteGateDisabled = process.env.NEXT_PUBLIC_DISABLE_INVITE_GATE === 'true';
    const isServiceRegistration = type && type !== 'human';
    let inviteData: { fromDid: string; fromHandle?: string } | null = null;

    if (!inviteGateDisabled && !isServiceRegistration) {
      if (!inviteCode) {
        return NextResponse.json(
          { error: 'Imajin is invite-only. You need an invite code to register.' },
          { status: 403 }
        );
      }

      // Validate invite code against connections service
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
        tier: 'preliminary',
      })
      .returning();

    // Store DFOS chain if provided
    let dfosChainLinked = false;
    if (body.dfosChain) {
      try {
        const { verifyClientChain, storeDfosChain } = await import('@/lib/dfos');
        const verified = await verifyClientChain(body.dfosChain, publicKey);
        if (verified) {
          dfosChainLinked = await storeDfosChain(identity.id, verified);
        } else {
          console.warn(`[register] DFOS chain verification failed for ${identity.id} — skipping`);
        }
      } catch (err) {
        console.error(`[register] DFOS chain storage failed for ${identity.id}:`, err);
        // Non-fatal — registration still succeeds
      }
    }

    // Create session token
    const token = await createSessionToken({
      sub: identity.id,
      handle: identity.handle || undefined,
      type: identity.type,
      name: identity.name || undefined,
      tier: 'preliminary', // registrations with public keys are preliminary DIDs
    });

    // Set cookie first so the accept call is authenticated
    const cookieConfig = getSessionCookieOptions();
    const response = NextResponse.json({
      did: identity.id,
      handle: identity.handle,
      type: identity.type,
      created: true,
      inviteAccepted: false,
      dfosChainLinked,
    }, { status: 201 });

    response.cookies.set(cookieConfig.name, token, cookieConfig.options);

    // Create profile row so the user is visible/discoverable
    try {
      const displayType = ['human', 'agent', 'presence'].includes(type) ? type : 'human';
      await fetch(`${PROFILE_SERVICE_URL}/api/profile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${cookieConfig.name}=${token}`,
        },
        body: JSON.stringify({
          displayName: name?.trim().slice(0, 100) || handle || 'Anonymous',
          displayType,
          handle: handle || undefined,
          email: email?.trim() || undefined,
          phone: phone?.trim() || undefined,
          optInUpdates: optInUpdates || false,
        }),
      });
    } catch (err) {
      console.error('Profile creation failed (non-fatal):', err);
      // Non-fatal — user can still use the platform, profile can be created later
    }

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
        dfosChainLinked,
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
