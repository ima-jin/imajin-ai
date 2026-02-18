import { NextRequest, NextResponse } from 'next/server';
import { db, identities } from '@/src/db';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';

/**
 * POST /api/register
 * Register a new identity with a public key
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { publicKey, type, name, metadata } = body;

    // Validate required fields
    if (!publicKey || typeof publicKey !== 'string') {
      return NextResponse.json(
        { error: 'publicKey required (Ed25519 hex)' },
        { status: 400 }
      );
    }

    // Valid identity types per docs/IDENTITY.md
    const validTypes = ['human', 'agent', 'event', 'presence', 'org'];
    if (!type || !validTypes.includes(type)) {
      return NextResponse.json(
        { error: `type required: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }

    // Check if publicKey already registered
    const existing = await db
      .select()
      .from(identities)
      .where(eq(identities.publicKey, publicKey))
      .limit(1);

    if (existing.length > 0) {
      return NextResponse.json({
        id: existing[0].id,
        type: existing[0].type,
        created: false,
        message: 'Identity already exists',
      });
    }

    // Generate DID from public key
    const id = `did:imajin:${publicKey.slice(0, 16)}`;

    // Create identity
    const [identity] = await db
      .insert(identities)
      .values({
        id,
        type,
        publicKey,
        name: name?.trim().slice(0, 100) || null,
        metadata: metadata || {},
      })
      .returning();

    return NextResponse.json({
      id: identity.id,
      type: identity.type,
      created: true,
    }, { status: 201 });

  } catch (error) {
    console.error('Register error:', error);
    return NextResponse.json(
      { error: 'Failed to register identity' },
      { status: 500 }
    );
  }
}
