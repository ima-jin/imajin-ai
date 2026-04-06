import { NextRequest, NextResponse } from 'next/server';
import { db, identities } from '@/src/db';
import { eq } from 'drizzle-orm';
import { verify, isValidMessageStructure } from '@imajin/auth';

/**
 * POST /api/verify
 * Verify a signed message directly (stateless, no token needed)
 * 
 * Request:
 * {
 *   message: {
 *     from: "did:imajin:xxx",
 *     type: "human" | "agent",
 *     timestamp: number,
 *     payload: any,
 *     signature: "hex-string"
 *   }
 * }
 * 
 * Response:
 * { valid: true, identity: {...} }
 * or
 * { valid: false, error: "reason" }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { message } = body;

    if (!message || typeof message !== 'object') {
      return NextResponse.json(
        { error: 'message object required' },
        { status: 400 }
      );
    }

    // Validate message structure
    if (!isValidMessageStructure(message)) {
      return NextResponse.json({
        valid: false,
        error: 'Invalid message structure',
      });
    }

    const { from, type } = message;

    // Get identity from database
    const [identity] = await db
      .select()
      .from(identities)
      .where(eq(identities.id, from))
      .limit(1);

    if (!identity) {
      return NextResponse.json({
        valid: false,
        error: 'Identity not found',
      });
    }

    // Verify type matches
    if (identity.type !== type) {
      return NextResponse.json({
        valid: false,
        error: 'Type mismatch',
      });
    }

    // Verify signature using @imajin/auth
    const result = await verify(message, identity.publicKey);

    if (!result.valid) {
      return NextResponse.json({
        valid: false,
        error: result.error || 'Invalid signature',
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
    console.error('Verify error:', error);
    return NextResponse.json(
      { error: 'Failed to verify message' },
      { status: 500 }
    );
  }
}
