import { NextRequest, NextResponse } from 'next/server';
import { db, connections } from '../../../../src/db/index';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';

/**
 * DELETE /api/connections/:did - Disconnect from a connection
 * Sets disconnected_at on the connections row.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity } = authResult;
  const effectiveDid = identity.actingAs || identity.id;

  const { did: targetDid } = await params;

  // Sort DIDs lexically to find the connection row
  const [didA, didB] = [effectiveDid, targetDid].sort((a, b) => a.localeCompare(b));

  const result = await db
    .update(connections)
    .set({ disconnectedAt: new Date() })
    .where(and(eq(connections.didA, didA), eq(connections.didB, didB)))
    .returning();

  if (result.length === 0) {
    return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
  }

  return NextResponse.json({ disconnected: true });
}
