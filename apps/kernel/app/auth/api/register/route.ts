import { NextRequest, NextResponse } from 'next/server';
import { db, identities, profiles } from '@/src/db';
import { eq, or } from 'drizzle-orm';
import { didFromPublicKey } from '@/src/lib/auth/crypto';
import { createSessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { rateLimit, getClientIP } from '@imajin/config';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { createLogger } from '@imajin/logger';
import * as bus from '@imajin/bus';
import {
  autoAcceptInvite,
  linkDfosChainSafe,
  resolveInviteCode,
  subscribeEmailToMailingList,
  verifyRegistrationSignature,
} from '@/src/lib/auth/register';

const log = createLogger('kernel');

/**
 * POST /api/register
 * Register a new identity with a public key.
 * REQUIRES a valid invite code (invite-only platform).
 *
 * Body: {
 *   publicKey: string (hex),
 *   handle?: string,
 *   name?: string,
 *   scope?: 'actor' | 'family' | 'community' | 'business' (default: 'actor'),
 *   subtype?: string (default: 'human' for actor scope),
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
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    );
  }

  try {
    const body = await request.json();
    const {
      publicKey, handle, name,
      scope: rawScope, subtype: rawSubtype,
      signature, inviteCode, email, phone, optInUpdates,
    } = body;
    const scope = rawScope || 'actor';
    const subtype = rawSubtype || (scope === 'actor' ? 'human' : null);

    if (!publicKey || typeof publicKey !== 'string') {
      return NextResponse.json({ error: 'publicKey required (Ed25519 hex)' }, { status: 400 });
    }

    const VALID_SCOPES = ['actor', 'family', 'community', 'business'];
    if (!VALID_SCOPES.includes(scope)) {
      return NextResponse.json(
        { error: `scope must be one of: ${VALID_SCOPES.join(', ')}` },
        { status: 400 },
      );
    }

    if (handle && !/^[a-z0-9_]{3,30}$/.test(handle)) {
      return NextResponse.json(
        { error: 'Handle must be 3-30 lowercase letters, numbers, or underscores' },
        { status: 400 },
      );
    }

    if (!signature) {
      return NextResponse.json({ error: 'signature required' }, { status: 400 });
    }

    const isValid = await verifyRegistrationSignature(
      publicKey, handle, name, scope, subtype, rawSubtype, signature,
    );
    if (!isValid) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    // Check if publicKey or handle already registered
    const conditions = [eq(identities.publicKey, publicKey)];
    if (handle) conditions.push(eq(identities.handle, handle));

    const existing = await db.select().from(identities).where(or(...conditions)).limit(1);

    if (existing.length > 0) {
      if (existing[0].publicKey !== publicKey) {
        return NextResponse.json({ error: 'Handle already taken' }, { status: 409 });
      }
      // Same key — login-via-register flow
      return loginViaRegister(existing[0], body, publicKey);
    }

    // Require invite code for new registrations (skip in dev with DISABLE_INVITE_GATE=true)
    // Service-to-service registrations (events, agents, etc.) bypass the invite gate.
    const inviteGateDisabled = process.env.NEXT_PUBLIC_DISABLE_INVITE_GATE === 'true';
    const isServiceRegistration = scope !== 'actor' || (subtype && subtype !== 'human');
    const inviteResult = await resolveInviteCode(inviteCode, isServiceRegistration, inviteGateDisabled);
    if (!inviteResult.ok) {
      return NextResponse.json({ error: inviteResult.error }, { status: inviteResult.status });
    }
    const { inviteData } = inviteResult;

    // Create identity
    const did = didFromPublicKey(publicKey);
    const [identity] = await db
      .insert(identities)
      .values({
        id: did, scope, subtype: subtype || null, publicKey,
        handle: handle || null, name: name?.trim().slice(0, 100) || null, tier: 'preliminary',
      })
      .returning();

    // Store DFOS chain if provided (non-fatal)
    const dfosChainLinked = body.dfosChain
      ? await linkDfosChainSafe(identity.id, body.dfosChain, publicKey)
      : false;

    // Create session token
    const token = await createSessionToken({
      sub: identity.id,
      handle: identity.handle || undefined,
      scope: identity.scope,
      subtype: identity.subtype || undefined,
      name: identity.name || undefined,
      tier: 'preliminary',
    });

    const cookieConfig = getSessionCookieOptions();
    const platformDid = await getNodeDid();

    bus.publish('identity.created', {
      issuer: identity.id, subject: identity.id, scope: 'auth',
      payload: { tier: 'preliminary', scope: identity.scope, subtype: identity.subtype,
                 context_id: identity.id, context_type: 'identity' },
    });
    bus.publish('identity.verified.preliminary', {
      issuer: platformDid, subject: identity.id, scope: 'auth',
      payload: { tier: 'preliminary', scope: identity.scope, subtype: identity.subtype,
                 context_id: identity.id, context_type: 'identity' },
    });

    // Create profile row (non-fatal)
    try {
      await db.insert(profiles).values({
        did: identity.id,
        displayName: name?.trim().slice(0, 100) || handle || 'Anonymous',
        handle: handle || null,
        contactEmail: email?.trim() || null,
        phone: phone?.trim() || null,
        metadata: { optInUpdates: optInUpdates || false },
      }).onConflictDoNothing();
    } catch (err) {
      log.error({ err: String(err) }, 'Profile creation failed (non-fatal)');
    }

    // Subscribe to mailing list — fire and forget
    if (optInUpdates && email && typeof email === 'string' && email.trim()) {
      subscribeEmailToMailingList(email, identity.id, request.url);
    }

    // Auto-accept invite: create the connection so the new user lands with a first contact.
    if (inviteData && inviteCode) {
      const accepted = await autoAcceptInvite({ inviteData, inviteCode, identity });
      if (accepted.ok) {
        const acceptedResponse = NextResponse.json({
          did: identity.id, handle: identity.handle,
          scope: identity.scope, subtype: identity.subtype,
          created: true, inviteAccepted: true, dfosChainLinked,
        }, { status: 201 });
        acceptedResponse.cookies.set(cookieConfig.name, token, cookieConfig.options);
        return acceptedResponse;
      }
      log.error({ err: String(accepted.error) }, '[register] Auto-accept failed (non-fatal)');
    }

    const response = NextResponse.json({
      did: identity.id, handle: identity.handle,
      scope: identity.scope, subtype: identity.subtype,
      created: true, inviteAccepted: false, dfosChainLinked,
    }, { status: 201 });
    response.cookies.set(cookieConfig.name, token, cookieConfig.options);
    return response;

  } catch (error) {
    log.error({ err: String(error) }, 'Register error');
    return NextResponse.json({ error: 'Failed to register identity' }, { status: 500 });
  }
}

/** Handle the case where the same public key re-registers (login-via-register flow). */
async function loginViaRegister(
  existing: typeof identities.$inferSelect,
  body: Record<string, unknown>,
  publicKey: string,
): Promise<NextResponse> {
  const dfosChainLinked = body.dfosChain
    ? await linkDfosChainSafe(existing.id, body.dfosChain, publicKey)
    : false;

  const token = await createSessionToken({
    sub: existing.id,
    handle: existing.handle || undefined,
    scope: existing.scope,
    subtype: existing.subtype || undefined,
    name: existing.name || undefined,
    tier: (existing.tier as 'soft' | 'preliminary' | 'established') || 'preliminary',
  });

  const cookieConfig = getSessionCookieOptions();
  const response = NextResponse.json({
    did: existing.id, handle: existing.handle,
    scope: existing.scope, subtype: existing.subtype,
    created: false, message: 'Identity already exists',
    dfosChainLinked,
  });
  response.cookies.set(cookieConfig.name, token, cookieConfig.options);
  return response;
}
