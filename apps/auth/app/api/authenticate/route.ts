import { NextRequest, NextResponse } from 'next/server';
import { db, identities, challenges, tokens } from '@/src/db';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { verify as verifySignature, hexToBytes, stringToBytes } from '@imajin/auth';

/**
 * POST /api/authenticate
 * Submit signed challenge, receive token
 * 
 * Request:
 * {
 *   id: "did:imajin:xxx",
 *   challengeId: "uuid",
 *   signature: "hex-string" (signature of the challenge string)
 * }
 * 
 * Response:
 * {
 *   token: "imajin_tok_xxx",
 *   expiresAt: "ISO-8601",
 *   identity: { id, type, name }
 * }
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

    // Verify signature
    // The signature should be over the challenge string directly
    const { verify } = await import('@imajin/auth');
    
    // For challenge-response, we verify a raw signature over the challenge string
    // Not a full SignedMessage - just signature(challenge, privateKey)
    const isValid = await verifyRawSignature(
      signature,
      challenge.challenge,
      identity.publicKey
    );

    if (!isValid) {
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

/**
 * Verify a raw Ed25519 signature (not a SignedMessage)
 * Used for challenge-response authentication
 */
async function verifyRawSignature(
  signatureHex: string,
  message: string,
  publicKeyHex: string
): Promise<boolean> {
  try {
    // Import the low-level verify function
    const { verify } = await import('@noble/ed25519');
    const { sha512 } = await import('@noble/hashes/sha512');
    const ed = await import('@noble/ed25519');
    
    // Configure sha512 (required for @noble/ed25519 v2)
    ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
    
    // Convert hex strings to bytes
    const signature = hexToBytes(signatureHex);
    const publicKey = hexToBytes(publicKeyHex);
    const messageBytes = new TextEncoder().encode(message);
    
    return ed.verify(signature, messageBytes, publicKey);
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

// Helper to convert hex to bytes (inline to avoid import issues)
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
