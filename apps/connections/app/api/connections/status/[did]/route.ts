import { NextRequest, NextResponse } from 'next/server';
import { db, connections } from '../../../../../src/db/index';
import { corsHeaders, corsOptions } from '@/lib/cors';
import { eq, or, and, isNull } from 'drizzle-orm';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /api/connections/status/:did
 *
 * Returns graph membership status for a DID.
 * A user is "in graph" if they have at least one accepted connection.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { did: string } }
) {
  const cors = corsHeaders(request);
  const { did } = params;

  if (!did) {
    return NextResponse.json({ error: 'DID is required' }, { status: 400, headers: cors });
  }

  try {
    const rows = await db
      .select({ didA: connections.didA })
      .from(connections)
      .where(
        and(
          or(eq(connections.didA, did), eq(connections.didB, did)),
          isNull(connections.disconnectedAt)
        )
      );

    const connectionCount = rows.length;
    const inGraph = connectionCount > 0;

    return NextResponse.json({ inGraph, connectionCount }, { headers: cors });
  } catch (error) {
    console.error('Failed to check graph status:', error);
    return NextResponse.json(
      { error: 'Failed to check graph status' },
      { status: 500, headers: cors }
    );
  }
}
