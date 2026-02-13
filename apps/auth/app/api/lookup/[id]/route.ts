import { NextRequest, NextResponse } from 'next/server';
import { db, identities } from '@/src/db';
import { eq } from 'drizzle-orm';

/**
 * GET /api/lookup/:id
 * Look up identity by DID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json(
        { error: 'id required' },
        { status: 400 }
      );
    }

    // Decode URI component (DIDs may have colons)
    const decodedId = decodeURIComponent(id);

    const [identity] = await db
      .select({
        id: identities.id,
        type: identities.type,
        name: identities.name,
        avatarUrl: identities.avatarUrl,
        metadata: identities.metadata,
        createdAt: identities.createdAt,
      })
      .from(identities)
      .where(eq(identities.id, decodedId))
      .limit(1);

    if (!identity) {
      return NextResponse.json(
        { error: 'Identity not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ identity });

  } catch (error) {
    console.error('Lookup error:', error);
    return NextResponse.json(
      { error: 'Failed to lookup identity' },
      { status: 500 }
    );
  }
}
