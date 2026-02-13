import { NextRequest, NextResponse } from 'next/server';
import { db, identities, tokens } from '@/src/db';
import { eq, and, isNull, gt } from 'drizzle-orm';

/**
 * POST /api/validate
 * Validate a token and return identity (for apps)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token } = body;

    if (!token || typeof token !== 'string') {
      return NextResponse.json(
        { error: 'token required' },
        { status: 400 }
      );
    }

    // Look up token
    const [tokenRecord] = await db
      .select()
      .from(tokens)
      .where(
        and(
          eq(tokens.id, token),
          isNull(tokens.revokedAt),
          gt(tokens.expiresAt, new Date())
        )
      )
      .limit(1);

    if (!tokenRecord) {
      return NextResponse.json({
        valid: false,
        error: 'Invalid or expired token',
      });
    }

    // Update last used
    await db
      .update(tokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(tokens.id, token));

    // Get identity
    const [identity] = await db
      .select()
      .from(identities)
      .where(eq(identities.id, tokenRecord.identityId))
      .limit(1);

    if (!identity) {
      return NextResponse.json({
        valid: false,
        error: 'Identity not found',
      });
    }

    return NextResponse.json({
      valid: true,
      identity: {
        id: identity.id,
        type: identity.type,
        name: identity.name,
        metadata: identity.metadata,
      },
    });

  } catch (error) {
    console.error('Validate error:', error);
    return NextResponse.json(
      { error: 'Failed to validate token' },
      { status: 500 }
    );
  }
}
