import { NextRequest, NextResponse } from 'next/server';
import { db, identities } from '@/src/db';
import { eq } from 'drizzle-orm';

function corsHeaders(request: NextRequest) {
  const origin = request.headers.get('origin') || '';
  const allowed = origin.endsWith('.imajin.ai') || origin === 'https://imajin.ai';
  return {
    'Access-Control-Allow-Origin': allowed ? origin : '',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

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

    return NextResponse.json({ identity }, { headers: cors });

  } catch (error) {
    console.error('Lookup error:', error);
    return NextResponse.json(
      { error: 'Failed to lookup identity' },
      { status: 500, headers: cors }
    );
  }
}
