import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { generateId } from '@/lib/id';
import { db, pods, podMembers } from '@/db';
import { eq, and, isNull } from 'drizzle-orm';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const myPods = await db
    .select({ pod: pods })
    .from(podMembers)
    .innerJoin(pods, eq(pods.id, podMembers.podId))
    .where(and(eq(podMembers.did, auth.identity.id), isNull(podMembers.removedAt)));

  return NextResponse.json({ pods: myPods.map((r) => r.pod) });
}

export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json();
  const id = generateId('pod_');
  const now = new Date();

  const [pod] = await db.insert(pods).values({
    id,
    name: body.name,
    description: body.description || null,
    avatar: body.avatar || null,
    ownerDid: auth.identity.id,
    type: body.type || 'personal',
    visibility: body.visibility || 'private',
    createdAt: now,
    updatedAt: now,
  }).returning();

  await db.insert(podMembers).values({
    podId: id,
    did: auth.identity.id,
    role: 'owner',
    addedBy: auth.identity.id,
    joinedAt: now,
  });

  return NextResponse.json({ pod }, { status: 201 });
}
