import { NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { requireGraphMember } from '@/src/lib/kernel/require-graph-member';
import { emitAttestation } from '@imajin/auth';
import { generateId } from '@/src/lib/kernel/id';
import { db, pods, podMembers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';

export async function GET(request: Request) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const did = auth.identity.actingAs || auth.identity.id;

  const myPods = await db
    .select({ pod: pods })
    .from(podMembers)
    .innerJoin(pods, eq(pods.id, podMembers.podId))
    .where(and(eq(podMembers.did, did), isNull(podMembers.removedAt)));

  return NextResponse.json({ pods: myPods.map((r) => r.pod) });
}

export async function POST(request: Request) {
  const auth = await requireGraphMember(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json();
  const id = generateId('pod_');
  const now = new Date().toISOString();
  const effectiveDid = auth.identity.actingAs || auth.identity.id;

  const [pod] = await db.insert(pods).values({
    id,
    name: body.name,
    description: body.description || null,
    avatar: body.avatar || null,
    ownerDid: effectiveDid,
    type: body.type || 'personal',
    visibility: body.visibility || 'private',
    createdAt: now,
    updatedAt: now,
  }).returning();

  await db.insert(podMembers).values({
    podId: id,
    did: effectiveDid,
    role: 'owner',
    addedBy: auth.identity.id,
    joinedAt: now,
  });

  // Fire and forget — never block the response
  emitAttestation({
    issuer_did: auth.identity.id,
    subject_did: effectiveDid,
    type: 'pod.created',
    context_id: pod.id,
    context_type: 'pod',
    payload: { name: pod.name, type: pod.type },
  }).catch((err: unknown) => console.error('Attestation emit error:', err));

  return NextResponse.json({ pod }, { status: 201 });
}
