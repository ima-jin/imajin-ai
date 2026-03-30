import { NextRequest, NextResponse } from 'next/server';
import { db, identities, challenges } from '@/src/db';
import { eq } from 'drizzle-orm';
import { generateChallenge } from '@/lib/crypto';
import { randomUUID } from 'crypto';
import { rateLimit, getClientIP } from '@/src/lib/rate-limit';
import { hasDfosChain } from '@/lib/dfos';

/**
 * POST /api/login/challenge
 * Request a challenge to sign for login
 * 
 * Body: {
 *   handle?: string,
 *   did?: string
 * }
 * 
 * Returns: {
 *   challengeId: string,
 *   challenge: string (hex),
 *   expiresAt: string (ISO)
 * }
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
    const { handle, did } = body;

    if (!handle && !did) {
      return NextResponse.json(
        { error: 'handle or did required' },
        { status: 400 }
      );
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
        .where(eq(identities.handle, handle.toLowerCase()))
        .limit(1);
      identity = results[0];
    }

    if (!identity) {
      return NextResponse.json(
        { error: 'Identity not found' },
        { status: 404 }
      );
    }

    // Generate challenge
    const challengeId = `chl_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const challenge = generateChallenge();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // Store challenge
    await db.insert(challenges).values({
      id: challengeId,
      identityId: identity.id,
      challenge,
      expiresAt,
    });

    // Tell the client whether they need to create + submit a DFOS genesis chain.
    // If false, the client should include dfosChain in the /login/verify request.
    const hasChain = await hasDfosChain(identity.id);

    return NextResponse.json({
      challengeId,
      challenge,
      expiresAt: expiresAt.toISOString(),
      hasDfosChain: hasChain,
    });

  } catch (error) {
    console.error('Challenge error:', error);
    return NextResponse.json(
      { error: 'Failed to create challenge' },
      { status: 500 }
    );
  }
}
