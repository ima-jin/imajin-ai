import { NextRequest, NextResponse } from 'next/server';
import { db, podMembers, pods } from '../../../src/db/index';
import { corsHeaders, corsOptions, withCors } from '@/lib/cors';
import { requireAuth } from '@imajin/auth';
import { eq, and, isNull, ne, sql } from 'drizzle-orm';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const { identity } = authResult;

  // Find 2-person pods I'm in
  const myPodIds = db
    .select({ podId: podMembers.podId })
    .from(podMembers)
    .where(and(eq(podMembers.did, identity.id), isNull(podMembers.removedAt)));

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
      ne(podMembers.did, identity.id),
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
