import { NextRequest, NextResponse } from 'next/server';
import { db, identities, challenges, tokens } from '@/src/db';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { randomBytes } from 'crypto';
// TODO: import { verify } from '@noble/ed25519';

/**
 * POST /api/authenticate
 * Submit signed challenge, receive token
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, challengeId, signature } = body;

    if (!id || !challengeId || !signature) {
      return NextResponse.json(
        { error: 'id, challengeId, and signature required' },
        { status: 400 }
      );
    }

    // Get identity
    const [identity] = await db
      .select()
      .from(identities)
      .where(eq(identities.id, id))
      .limit(1);

    if (!identity) {
      return NextResponse.json(
        { error: 'Identity not found' },
        { status: 404 }
      );
    }

    // Get and validate challenge
    const [challenge] = await db
      .select()
      .from(challenges)
      .where(
        and(
          eq(challenges.id, challengeId),
          eq(challenges.identityId, id),
          isNull(challenges.usedAt),
          gt(challenges.expiresAt, new Date())
        )
      )
      .limit(1);

    if (!challenge) {
      return NextResponse.json(
        { error: 'Invalid or expired challenge' },
        { status: 400 }
      );
    }

    // TODO: Verify signature with Ed25519
    // const valid = await verify(signature, challenge.challenge, identity.publicKey);
    // For now, skip verification (INSECURE - implement before production!)
    const valid = true; // PLACEHOLDER

    if (!valid) {
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 401 }
      );
    }

    // Mark challenge as used
    await db
      .update(challenges)
      .set({ usedAt: new Date() })
      .where(eq(challenges.id, challengeId));

    // Generate token
    const tokenId = `imajin_tok_${randomBytes(24).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await db.insert(tokens).values({
      id: tokenId,
      identityId: id,
      expiresAt,
    });

    return NextResponse.json({
      token: tokenId,
      expiresAt: expiresAt.toISOString(),
      identity: {
        id: identity.id,
        type: identity.type,
        name: identity.name,
      },
    });

  } catch (error) {
    console.error('Authenticate error:', error);
    return NextResponse.json(
      { error: 'Failed to authenticate' },
      { status: 500 }
    );
  }
}
