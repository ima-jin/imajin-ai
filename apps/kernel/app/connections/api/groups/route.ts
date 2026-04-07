import { NextRequest, NextResponse } from 'next/server';
import { db, pods, podMembers } from '@/src/db';
import { eq, and, isNull, inArray, sql, ne } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { corsHeaders, corsOptions } from '@imajin/config';
import { getSessionFromCookies } from '@/src/lib/kernel/session';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const session = await getSessionFromCookies(request.headers.get('cookie'));
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: cors });
  }

  // Get all pods the user is a member of (excluding personal/connection pods)
  const memberPodIds = await db
    .select({ podId: podMembers.podId })
    .from(podMembers)
    .where(and(eq(podMembers.did, session.did), isNull(podMembers.removedAt)));

  if (memberPodIds.length === 0) {
    return NextResponse.json({ pods: [] }, { headers: cors });
  }

  const podIds = memberPodIds.map((r) => r.podId);

  // Fetch pods with type shared or event (not personal connection pods)
  const groupPods = await db
    .select()
    .from(pods)
    .where(and(
      inArray(pods.id, podIds),
      ne(pods.type, 'personal')
    ));

  // Get member counts for each pod
  const counts = await db
    .select({ podId: podMembers.podId, count: sql<number>`count(*)::int` })
    .from(podMembers)
    .where(and(inArray(podMembers.podId, podIds), isNull(podMembers.removedAt)))
    .groupBy(podMembers.podId);

  const countMap = new Map(counts.map((c) => [c.podId, c.count]));

  const result = groupPods.map((pod) => ({
    ...pod,
    memberCount: countMap.get(pod.id) ?? 0,
  }));

  return NextResponse.json({ pods: result }, { headers: cors });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);
  const session = await getSessionFromCookies(request.headers.get('cookie'));
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: cors });
  }

  const body = await request.json();
  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400, headers: cors });
  }

  const id = generateId('pod_');
  const now = new Date();

  const [pod] = await db.insert(pods).values({
    id,
    name: body.name.trim(),
    description: body.description?.trim() || null,
    avatar: null,
    ownerDid: session.did,
    type: 'shared',
    visibility: 'private',
    conversationDid: body.conversationDid || null,
    createdAt: now,
    updatedAt: now,
  }).returning();

  // Add creator as owner
  await db.insert(podMembers).values({
    podId: id,
    did: session.did,
    role: 'owner',
    addedBy: session.did,
    joinedAt: now,
  });

  // Add additional members if provided
  const memberDids: string[] = body.memberDids || [];
  for (const did of memberDids) {
    if (did !== session.did) {
      await db.insert(podMembers).values({
        podId: id,
        did,
        role: 'member',
        addedBy: session.did,
        joinedAt: now,
      });
    }
  }

  const memberCount = 1 + memberDids.filter(d => d !== session.did).length;

  return NextResponse.json({ pod: { ...pod, memberCount } }, { status: 201, headers: cors });
}
