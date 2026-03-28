import { NextResponse } from 'next/server';
import { requireAuth, requireGraphMember } from '@/lib/auth';
import { emitAttestation } from '@imajin/auth';
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
  const auth = await requireGraphMember(request);
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

  // Fire and forget — never block the response
  emitAttestation({
    issuer_did: auth.identity.id,
    subject_did: auth.identity.id,
    type: 'pod.created',
    context_id: pod.id,
    context_type: 'pod',
    payload: { name: pod.name, type: pod.type },
  }).catch((err: unknown) => console.error('Attestation emit error:', err));

  return NextResponse.json({ pod }, { status: 201 });
}
