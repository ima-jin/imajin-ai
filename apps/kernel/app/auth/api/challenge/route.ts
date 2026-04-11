import { NextRequest, NextResponse } from 'next/server';
import { db, identities, challenges } from '@/src/db';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { CHALLENGE_TTL } from '@imajin/auth';
import { withLogger } from '@imajin/logger';

/**
 * POST /api/challenge
 * Get a challenge to sign for authentication
 */
export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  try {
    const body = await request.json();
    const { id } = body;

    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        { error: 'id required (DID)' },
        { status: 400 }
      );
    }

    // Verify identity exists
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

    // Generate challenge
    const challengeId = `ch_${randomBytes(16).toString('hex')}`;
    const challenge = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL);

    // Store challenge
    await db.insert(challenges).values({
      id: challengeId,
      identityId: id,
      challenge,
      expiresAt,
    });

    return NextResponse.json({
      challengeId,
      challenge,
      expiresAt: expiresAt.toISOString(),
    });

  } catch (error) {
    log.error({ err: String(error) }, 'Challenge error');
    return NextResponse.json(
      { error: 'Failed to create challenge' },
      { status: 500 }
    );
  }
});
