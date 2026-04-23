import { NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { requireGraphMember } from '@/src/lib/kernel/require-graph-member';
import { publish } from '@imajin/bus';
import { generateId } from '@/src/lib/kernel/id';
import { db, pods, podMembers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

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
  publish('pod.created', {
    issuer: auth.identity.id,
    subject: effectiveDid,
    scope: 'connections',
    payload: { context_id: pod.id, context_type: 'pod', name: pod.name, type: pod.type },
  }).catch((err: unknown) => log.error({ err: String(err) }, 'Attestation emit error'));

  return NextResponse.json({ pod }, { status: 201 });
}
