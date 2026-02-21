import { NextRequest, NextResponse } from 'next/server';
import { db, profiles, connections } from '@/src/db';
import { eq } from 'drizzle-orm';
import { createHash } from 'crypto';

/**
 * POST /api/soft-register
 * 
 * Creates a guest identity from email/phone.
 * Used at event checkout for minimal friction.
 * 
 * Same email = same guest DID (deterministic)
 * Can be claimed later by verifying ownership.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, phone, source, sourceId } = body;

    if (!email && !phone) {
      return NextResponse.json(
        { error: 'Email or phone required' },
        { status: 400 }
      );
    }

    // Generate deterministic DID from email/phone
    const identifier = email || phone;
    const hash = createHash('sha256')
      .update(`imajin:guest:${identifier.toLowerCase().trim()}`)
      .digest('hex');
    const did = `did:imajin:guest:${hash.slice(0, 32)}`;

    // Check if guest profile exists
    const [existing] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.did, did))
      .limit(1);

    if (existing) {
      // Already exists - just add connection if source provided
      if (source && sourceId) {
        await db.insert(connections).values({
          id: `conn_${Date.now().toString(36)}`,
          fromDid: did,
          toDid: sourceId, // e.g., event DID
          trustLevel: 0,
          source,
          sourceId,
        }).onConflictDoNothing();
      }

      return NextResponse.json({
        did,
        isNew: false,
        displayName: existing.displayName,
      });
    }

    // Create guest profile
    const displayName = email 
      ? email.split('@')[0] 
      : `Guest ${hash.slice(0, 6)}`;

    await db.insert(profiles).values({
      did,
      displayName,
      displayType: 'human',
      metadata: {
        isGuest: true,
        email: email || undefined,
        phone: phone || undefined,
        registeredAt: new Date().toISOString(),
      },
    });

    // Create connection to source if provided
    if (source && sourceId) {
      await db.insert(connections).values({
        id: `conn_${Date.now().toString(36)}`,
        fromDid: did,
        toDid: sourceId,
        trustLevel: 0,
        source,
        sourceId,
      });
    }

    return NextResponse.json({
      did,
      isNew: true,
      displayName,
    });

  } catch (error) {
    console.error('Soft register error:', error);
    return NextResponse.json(
      { error: 'Failed to create guest identity' },
      { status: 500 }
    );
  }
}
