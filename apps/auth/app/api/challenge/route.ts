import { NextRequest, NextResponse } from 'next/server';
import { db, identities, challenges } from '@/src/db';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';

/**
 * POST /api/challenge
 * Get a challenge to sign for authentication
 */
export async function POST(request: NextRequest) {
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
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

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
    console.error('Challenge error:', error);
    return NextResponse.json(
      { error: 'Failed to create challenge' },
      { status: 500 }
    );
  }
}
