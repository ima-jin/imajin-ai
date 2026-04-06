import { NextResponse } from 'next/server';
import { requireAuth } from '@/src/lib/connections/auth';
import { emitAttestation } from '@imajin/auth';
import { db, pods, podMembers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth(request, { verifyChain: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const effectiveDid = auth.identity.actingAs || auth.identity.id;
  const [pod] = await db.select().from(pods).where(eq(pods.id, params.id));
  if (!pod) return NextResponse.json({ error: 'Pod not found' }, { status: 404 });
  if (pod.ownerDid !== effectiveDid) return NextResponse.json({ error: 'Only the owner can add members' }, { status: 403 });

  const body = await request.json();
  if (!body.did) return NextResponse.json({ error: 'did is required' }, { status: 400 });

  const [member] = await db.insert(podMembers).values({
    podId: params.id,
    did: body.did,
    role: body.role || 'member',
    addedBy: auth.identity.id,
    joinedAt: new Date(),
  }).returning();

  if (auth.identity.chainVerified) {
    emitAttestation({
      issuer_did: auth.identity.id,
      subject_did: body.did,
      type: 'pod.member.added',
      context_id: params.id,
      context_type: 'pod',
      payload: { role: member.role },
    }).catch((err: unknown) => {
      console.error('Attestation (pod.member.added) error:', err);
    });
  }

  return NextResponse.json({ member }, { status: 201 });
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth(request, { verifyChain: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const effectiveDid = auth.identity.actingAs || auth.identity.id;
  const [pod] = await db.select().from(pods).where(eq(pods.id, params.id));
  if (!pod) return NextResponse.json({ error: 'Pod not found' }, { status: 404 });
  if (pod.ownerDid !== effectiveDid) return NextResponse.json({ error: 'Only the owner can change roles' }, { status: 403 });

  const body = await request.json();
  if (!body.did) return NextResponse.json({ error: 'did is required' }, { status: 400 });
  if (!body.role) return NextResponse.json({ error: 'role is required' }, { status: 400 });

  const [updated] = await db
    .update(podMembers)
    .set({ role: body.role })
    .where(and(eq(podMembers.podId, params.id), eq(podMembers.did, body.did), isNull(podMembers.removedAt)))
    .returning();

  if (!updated) return NextResponse.json({ error: 'Member not found' }, { status: 404 });

  if (auth.identity.chainVerified) {
    emitAttestation({
      issuer_did: auth.identity.id,
      subject_did: body.did,
      type: 'pod.role.changed',
      context_id: params.id,
      context_type: 'pod',
      payload: { role: body.role },
    }).catch((err: unknown) => {
      console.error('Attestation (pod.role.changed) error:', err);
    });
  }

  return NextResponse.json({ member: updated });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth(request, { verifyChain: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const effectiveDid = auth.identity.actingAs || auth.identity.id;
  const [pod] = await db.select().from(pods).where(eq(pods.id, params.id));
  if (!pod) return NextResponse.json({ error: 'Pod not found' }, { status: 404 });
  if (pod.ownerDid !== effectiveDid) return NextResponse.json({ error: 'Only the owner can remove members' }, { status: 403 });

  const body = await request.json();
  if (!body.did) return NextResponse.json({ error: 'did is required' }, { status: 400 });

  const [removed] = await db
    .update(podMembers)
    .set({ removedAt: new Date() })
    .where(and(eq(podMembers.podId, params.id), eq(podMembers.did, body.did)))
    .returning();

  if (!removed) return NextResponse.json({ error: 'Member not found' }, { status: 404 });

  if (auth.identity.chainVerified) {
    emitAttestation({
      issuer_did: auth.identity.id,
      subject_did: body.did,
      type: 'pod.member.removed',
      context_id: params.id,
      context_type: 'pod',
      payload: {},
    }).catch((err: unknown) => {
      console.error('Attestation (pod.member.removed) error:', err);
    });
  }

  return NextResponse.json({ removed: true });
}
