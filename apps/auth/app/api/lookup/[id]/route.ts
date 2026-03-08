import { NextRequest, NextResponse } from 'next/server';
import { db, identities } from '@/src/db';
import { eq } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/lookup/:id
 * Look up identity by DID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);
  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json(
        { error: 'id required' },
        { status: 400, headers: cors }
      );
    }

    // Decode URI component (DIDs may have colons)
    const decodedId = decodeURIComponent(id);

    const [identity] = await db
      .select({
        id: identities.id,
        type: identities.type,
        handle: identities.handle,
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
        { status: 404, headers: cors }
      );
    }

    // Return identity fields at top level for backward compatibility
    return NextResponse.json({
      did: identity.id,
      handle: identity.handle,
      name: identity.name,
      type: identity.type,
      avatarUrl: identity.avatarUrl,
      metadata: identity.metadata,
      createdAt: identity.createdAt,
    }, { headers: cors });

  } catch (error) {
    console.error('Lookup error:', error);
    return NextResponse.json(
      { error: 'Failed to lookup identity' },
      { status: 500, headers: cors }
    );
  }
}
