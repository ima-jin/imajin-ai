import { NextRequest, NextResponse } from 'next/server';
import { db, podMembers, pods } from '../../../src/db/index';
import { eq, and, isNull, ne, sql } from 'drizzle-orm';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

function withCors(response: NextResponse, request: NextRequest): NextResponse {
  const origin = request.headers.get('origin') || '';
  if (origin.endsWith('.imajin.ai') || origin === 'https://imajin.ai') {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return response;
}

export async function OPTIONS(request: NextRequest) {
  const res = new NextResponse(null, { status: 204 });
  const origin = request.headers.get('origin') || '';
  if (origin.endsWith('.imajin.ai') || origin === 'https://imajin.ai') {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Access-Control-Allow-Credentials', 'true');
    res.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  return res;
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
  const session = await getSession(request);
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
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

  return withCors(NextResponse.json({ connections }), request);
}
