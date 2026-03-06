import { NextRequest, NextResponse } from 'next/server';
import { db, podMembers, pods } from '../../../src/db/index';
import { corsHeaders, corsOptions, withCors } from '@/lib/cors';
import { eq, and, isNull, ne, sql } from 'drizzle-orm';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

async function getSession(request: NextRequest) {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      headers: { Cookie: request.headers.get('cookie') || '' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const session = await getSession(request);
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: cors });
  }

  // Find 2-person pods I'm in
  const myPodIds = db
    .select({ podId: podMembers.podId })
    .from(podMembers)
    .where(and(eq(podMembers.did, session.did), isNull(podMembers.removedAt)));

  const twoPersonPods = await db
    .select({ podId: podMembers.podId })
    .from(podMembers)
    .where(and(isNull(podMembers.removedAt), sql`${podMembers.podId} IN (${myPodIds})`))
    .groupBy(podMembers.podId)
    .having(sql`count(*) = 2`);

  if (twoPersonPods.length === 0) {
    return withCors(NextResponse.json({ connections: [] }), request);
  }

  const podIds = twoPersonPods.map((p) => p.podId);

  // Get other members + pod info
  const connections = await db
    .select({
      did: podMembers.did,
      podId: podMembers.podId,
      joinedAt: podMembers.joinedAt,
      podName: pods.name,
    })
    .from(podMembers)
    .innerJoin(pods, eq(pods.id, podMembers.podId))
    .where(and(
      isNull(podMembers.removedAt),
      ne(podMembers.did, session.did),
      sql`${podMembers.podId} IN (${sql.join(podIds.map(id => sql`${id}`), sql`, `)})`
    ));

  // Resolve handles from auth service
  const resolved = await Promise.all(
    connections.map(async (conn) => {
      try {
        const lookupRes = await fetch(`${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(conn.did)}`);
        if (lookupRes.ok) {
          const data = await lookupRes.json();
          const identity = data.identity || data;
          return { ...conn, handle: identity.handle || null, name: identity.name || null };
        }
      } catch {}
      return { ...conn, handle: null, name: null };
    })
  );

  return withCors(NextResponse.json({ connections: resolved }), request);
}
