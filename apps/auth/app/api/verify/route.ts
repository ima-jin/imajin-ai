import { NextRequest, NextResponse } from 'next/server';
import { db, identities } from '@/src/db';
import { eq } from 'drizzle-orm';
// TODO: import { verify } from '@noble/ed25519';

/**
 * POST /api/verify
 * Verify a signed message directly (stateless, no token needed)
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

    const { from, type, timestamp, payload, signature } = message;

    // Validate message structure
    if (!from || !type || !timestamp || !signature) {
      return NextResponse.json(
        { error: 'Invalid message structure' },
        { status: 400 }
      );
    }

    // Check timestamp (5 minute window)
    const age = Date.now() - timestamp;
    if (age > 5 * 60 * 1000) {
      return NextResponse.json({
        valid: false,
        error: 'Message expired',
      });
    }
    if (age < -30 * 1000) {
      return NextResponse.json({
        valid: false,
        error: 'Timestamp in future',
      });
    }

    // Get identity
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

    // TODO: Verify signature
    // const { signature: sig, ...rest } = message;
    // const canonical = JSON.stringify(rest, Object.keys(rest).sort());
    // const valid = await verify(sig, canonical, identity.publicKey);
    const valid = true; // PLACEHOLDER - implement before production!

    if (!valid) {
      return NextResponse.json({
        valid: false,
        error: 'Invalid signature',
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
