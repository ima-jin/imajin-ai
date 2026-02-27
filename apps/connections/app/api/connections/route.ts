import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { db, podMembers, pods } from '@/db';
import { eq, and, isNull, ne, sql } from 'drizzle-orm';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // Find people who share a 2-person pod with me
  // Step 1: Get pods I'm in that have exactly 2 active members
  const myPodIds = db
    .select({ podId: podMembers.podId })
    .from(podMembers)
    .where(and(eq(podMembers.did, auth.identity.id), isNull(podMembers.removedAt)));

  const twoPersonPods = await db
    .select({ podId: podMembers.podId })
    .from(podMembers)
    .where(and(isNull(podMembers.removedAt), sql`${podMembers.podId} IN (${myPodIds})`))
    .groupBy(podMembers.podId)
    .having(sql`count(*) = 2`);

  if (twoPersonPods.length === 0) {
    return NextResponse.json({ connections: [] });
  }

  const podIds = twoPersonPods.map((p) => p.podId);

  // Step 2: Get the other members from those pods
  const connections = await db
    .select({ did: podMembers.did, podId: podMembers.podId })
    .from(podMembers)
    .where(and(
      isNull(podMembers.removedAt),
      ne(podMembers.did, auth.identity.id),
      sql`${podMembers.podId} IN (${sql.join(podIds.map(id => sql`${id}`), sql`, `)})`
    ));

  return NextResponse.json({ connections });
}
