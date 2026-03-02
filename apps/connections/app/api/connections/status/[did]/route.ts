import { NextRequest, NextResponse } from 'next/server';
import { db, podMembers } from '../../../../../src/db/index';
import { eq, and, isNull, sql } from 'drizzle-orm';

/**
 * GET /api/connections/status/:did
 *
 * Returns graph membership status for a DID.
 * A user is "in graph" if they have at least one accepted connection
 * (i.e., they are in a 2-person pod)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { did: string } }
) {
  const { did } = params;

  if (!did) {
    return NextResponse.json({ error: 'DID is required' }, { status: 400 });
  }

  try {
    // Find all pods this user is in (not removed)
    const userPodIds = db
      .select({ podId: podMembers.podId })
      .from(podMembers)
      .where(and(eq(podMembers.did, did), isNull(podMembers.removedAt)));

    // Find 2-person pods (connections)
    const twoPersonPods = await db
      .select({ podId: podMembers.podId })
      .from(podMembers)
      .where(and(isNull(podMembers.removedAt), sql`${podMembers.podId} IN (${userPodIds})`))
      .groupBy(podMembers.podId)
      .having(sql`count(*) = 2`);

    const connectionCount = twoPersonPods.length;
    const inGraph = connectionCount > 0;

    return NextResponse.json({
      inGraph,
      connectionCount,
    });
  } catch (error) {
    console.error('Failed to check graph status:', error);
    return NextResponse.json(
      { error: 'Failed to check graph status' },
      { status: 500 }
    );
  }
}
