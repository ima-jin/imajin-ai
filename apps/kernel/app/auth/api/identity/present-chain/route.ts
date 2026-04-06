import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { verifyChainLog } from '@/src/lib/auth/chain-providers';
import { getIdentityByDfosDid, storeDfosChain } from '@/src/lib/auth/dfos';
import { db, identities, credentials } from '@/src/db';
import { createSessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { didFromPublicKey } from '@/src/lib/auth/crypto';
import { randomUUID } from 'crypto';
import { rateLimit, getClientIP } from '@/src/lib/auth/rate-limit';

/**
 * POST /api/identity/present-chain
 * An external user presents their chain log.
 * Auth verifies it, creates a did:imajin alias, returns a session.
 *
 * Request:  { chainLog: string[], provider?: string }
 * Response: { identity: { id, tier: 'preliminary', chainVerified: true }, created: boolean }
 *
 * Trust tier: 'preliminary' — chain proves keypair ownership, not standing on this network.
 */
export async function POST(request: NextRequest) {
  const ip = getClientIP(request);
  const rl = rateLimit(ip, 10, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } }
    );
  }

  try {
    const body = await request.json();
    const { chainLog } = body as { chainLog: string[]; provider?: string };

    if (!chainLog || !Array.isArray(chainLog) || chainLog.length === 0) {
      return NextResponse.json(
        { error: 'chainLog must be a non-empty array' },
        { status: 400 }
      );
    }

    // 1. Verify chain cryptographically via provider abstraction
    const result = await verifyChainLog(chainLog);
    if (!result.valid || !result.did || !result.publicKeyHex) {
      return NextResponse.json(
        { error: result.error ?? 'Chain verification failed' },
        { status: 422 }
      );
    }

    const chainDid = result.did;
    const publicKeyHex = result.publicKeyHex;

    // 2. Check if this chain DID already has a did:imajin alias → return existing session
    const existing = await getIdentityByDfosDid(chainDid);
    if (existing) {
      const token = await createSessionToken({
        sub: existing.imajinDid,
        type: existing.type,
        tier: existing.tier as 'soft' | 'preliminary' | 'established',
      });

      const cookieConfig = getSessionCookieOptions();
      const response = NextResponse.json({
        identity: {
          id: existing.imajinDid,
          tier: existing.tier,
          chainVerified: true,
        },
        created: false,
      });
      response.cookies.set(cookieConfig.name, token, cookieConfig.options);
      return response;
    }

    // 3. Check if the public key is already registered locally (same key, no chain yet)
    const [existingByKey] = await db
      .select({ id: identities.id, type: identities.type, tier: identities.tier })
      .from(identities)
      .where(eq(identities.publicKey, publicKeyHex))
      .limit(1);

    if (existingByKey) {
      // Key already registered — link chain to it and return session
      await storeDfosChain(existingByKey.id, {
        did: chainDid,
        log: chainLog,
        headCid: chainLog[chainLog.length - 1],
      });

      const token = await createSessionToken({
        sub: existingByKey.id,
        type: existingByKey.type,
        tier: existingByKey.tier as 'soft' | 'preliminary' | 'established',
      });

      const cookieConfig = getSessionCookieOptions();
      const response = NextResponse.json({
        identity: {
          id: existingByKey.id,
          tier: existingByKey.tier,
          chainVerified: true,
        },
        created: false,
      });
      response.cookies.set(cookieConfig.name, token, cookieConfig.options);
      return response;
    }

    // 4. New external chain identity — create did:imajin alias
    const imajinDid = didFromPublicKey(publicKeyHex);

    const [identity] = await db
      .insert(identities)
      .values({
        id: imajinDid,
        type: 'human',
        publicKey: publicKeyHex,
        tier: 'preliminary', // chain proves keypair, not standing on this network
      })
      .returning();

    // Store credential link
    const credId = `cred_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await db.insert(credentials).values({
      id: credId,
      did: imajinDid,
      type: 'keypair',
      value: publicKeyHex,
      verifiedAt: new Date(),
    });

    // Link chain to identity
    await storeDfosChain(identity.id, {
      did: chainDid,
      log: chainLog,
      headCid: chainLog[chainLog.length - 1],
    });

    // 5. Create session
    const token = await createSessionToken({
      sub: identity.id,
      type: identity.type,
      tier: 'preliminary',
    });

    const cookieConfig = getSessionCookieOptions();
    const response = NextResponse.json({
      identity: {
        id: identity.id,
        tier: 'preliminary',
        chainVerified: true,
      },
      created: true,
    }, { status: 201 });
    response.cookies.set(cookieConfig.name, token, cookieConfig.options);
    return response;

  } catch (error) {
    console.error('[present-chain] Error:', error);
    return NextResponse.json(
      { error: 'Internal error' },
      { status: 500 }
    );
  }
}
