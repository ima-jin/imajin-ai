/**
 * POST /api/onboard/generate
 *
 * Keypair-based onboarding: public key → DID → identity → session.
 * No signature verification required — possession of the key is asserted client-side.
 * Creates a 'soft' tier identity (can be upgraded later with a real signature).
 *
 * Body: { publicKey: string (hex, 64 chars), name?: string, scopeDid?: string, redirectUrl?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/src/db';
import { identities, credentials, groupControllers } from '@/src/db';
import { didFromPublicKey } from '@/src/lib/auth/crypto';
import { createSessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { emitAttestation } from '@imajin/auth';
import { corsHeaders } from '@imajin/config';
import { rateLimit, getClientIP } from '@/src/lib/auth/rate-limit';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';

const PROFILE_SERVICE_URL = process.env.PROFILE_SERVICE_URL!;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

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
    const { publicKey, name, scopeDid, redirectUrl } = body;

    // Validate publicKey
    if (!publicKey || typeof publicKey !== 'string') {
      return NextResponse.json({ error: 'publicKey required' }, { status: 400, headers: cors });
    }
    if (!/^[0-9a-fA-F]{64}$/.test(publicKey)) {
      return NextResponse.json({ error: 'publicKey must be a 64-char hex string (Ed25519)' }, { status: 400, headers: cors });
    }

    const did = didFromPublicKey(publicKey);

    // Check if DID already exists
    const [existing] = await db
      .select()
      .from(identities)
      .where(eq(identities.id, did))
      .limit(1);

    let identity = existing;
    let created = false;

    if (!identity) {
      // Create new identity
      [identity] = await db
        .insert(identities)
        .values({
          id: did,
          type: 'human',
          publicKey,
          name: name?.trim().slice(0, 100) || null,
          tier: 'soft',
          metadata: { source: 'keypair_onboard' },
        })
        .returning();
      created = true;

      // Insert keypair credential
      await db.insert(credentials).values({
        id: `cred_${nanoid(16)}`,
        did,
        type: 'keypair',
        value: publicKey,
        verifiedAt: new Date(),
      }).onConflictDoNothing();
    }

    // Create session token
    const tier = (identity.tier || 'soft') as 'soft' | 'preliminary' | 'established';
    const sessionToken = await createSessionToken({
      sub: did,
      type: 'human',
      tier,
      handle: identity.handle || undefined,
      name: identity.name || undefined,
    });

    const cookieOptions = getSessionCookieOptions();
    const response = NextResponse.json(
      { did, tier, created, redirectUrl: redirectUrl || null },
      { status: created ? 201 : 200, headers: cors }
    );

    response.cookies.set(cookieOptions.name, sessionToken, cookieOptions.options);

    // If scoped to a forest, add as member and set active forest cookie
    if (scopeDid && typeof scopeDid === 'string') {
      try {
        const [existingMember] = await db
          .select({ removedAt: groupControllers.removedAt })
          .from(groupControllers)
          .where(and(eq(groupControllers.groupDid, scopeDid), eq(groupControllers.controllerDid, did)))
          .limit(1);
        if (!existingMember) {
          await db.insert(groupControllers).values({ groupDid: scopeDid, controllerDid: did, role: 'member', addedBy: scopeDid });
        } else if (existingMember.removedAt) {
          await db.update(groupControllers)
            .set({ removedAt: null, role: 'member', addedBy: scopeDid, addedAt: new Date() })
            .where(and(eq(groupControllers.groupDid, scopeDid), eq(groupControllers.controllerDid, did)));
        }
      } catch (err) {
        console.error('[onboard/generate] Forest member add failed (non-fatal):', err);
      }
      emitAttestation({ issuer_did: scopeDid, subject_did: did, type: 'scope.onboard', context_id: scopeDid, context_type: 'forest' })
        .catch(err => console.error('[onboard/generate] Scope attestation failed (non-fatal):', err));
      response.cookies.set('x-acting-as', scopeDid, { path: '/', maxAge: 31536000, sameSite: 'lax' });
    }

    // Create profile row (fire-and-forget)
    if (created) {
      try {
        await fetch(`${PROFILE_SERVICE_URL}/api/profile`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `${cookieOptions.name}=${sessionToken}`,
          },
          body: JSON.stringify({
            displayName: name?.trim().slice(0, 100) || 'Anonymous',
            displayType: 'human',
          }),
        });
      } catch (err) {
        console.error('[onboard/generate] Profile creation failed (non-fatal):', err);
      }
    }

    return response;

  } catch (error) {
    console.error('[onboard/generate] Error:', error);
    return NextResponse.json({ error: 'Failed to onboard identity' }, { status: 500, headers: cors });
  }
}
