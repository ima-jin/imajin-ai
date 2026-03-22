import { NextRequest, NextResponse } from 'next/server';
import { db, pods, podMembers } from '../../../../../src/db/index';
import { emitAttestation } from '../../../../../src/lib/attestations';
import { eq, and, isNull } from 'drizzle-orm';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

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

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession(request);
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const [pod] = await db.select().from(pods).where(eq(pods.id, params.id));
  if (!pod) return NextResponse.json({ error: 'Pod not found' }, { status: 404 });
  if (pod.ownerDid !== session.did) return NextResponse.json({ error: 'Only the owner can add members' }, { status: 403 });
  if (pod.type === 'event') return NextResponse.json({ error: 'Event pods are read-only' }, { status: 403 });

  const body = await request.json();
  if (!body.did) return NextResponse.json({ error: 'did is required' }, { status: 400 });

  // Check if already a member
  const existing = await db
    .select()
    .from(podMembers)
    .where(and(eq(podMembers.podId, params.id), eq(podMembers.did, body.did), isNull(podMembers.removedAt)));

  if (existing.length > 0) {
    return NextResponse.json({ error: 'Already a member' }, { status: 409 });
  }

  const [member] = await db.insert(podMembers).values({
    podId: params.id,
    did: body.did,
    role: 'member',
    addedBy: session.did,
    joinedAt: new Date(),
  }).returning();

  if (session.chainVerified) {
    emitAttestation({
      issuer_did: session.did,
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

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession(request);
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const [pod] = await db.select().from(pods).where(eq(pods.id, params.id));
  if (!pod) return NextResponse.json({ error: 'Pod not found' }, { status: 404 });
  if (pod.ownerDid !== session.did) return NextResponse.json({ error: 'Only the owner can change roles' }, { status: 403 });
  if (pod.type === 'event') return NextResponse.json({ error: 'Event pods are read-only' }, { status: 403 });

  const body = await request.json();
  if (!body.did) return NextResponse.json({ error: 'did is required' }, { status: 400 });
  if (!body.role) return NextResponse.json({ error: 'role is required' }, { status: 400 });

  const [updated] = await db
    .update(podMembers)
    .set({ role: body.role })
    .where(and(eq(podMembers.podId, params.id), eq(podMembers.did, body.did), isNull(podMembers.removedAt)))
    .returning();

  if (!updated) return NextResponse.json({ error: 'Member not found' }, { status: 404 });

  if (session.chainVerified) {
    emitAttestation({
      issuer_did: session.did,
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

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession(request);
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const [pod] = await db.select().from(pods).where(eq(pods.id, params.id));
  if (!pod) return NextResponse.json({ error: 'Pod not found' }, { status: 404 });
  if (pod.ownerDid !== session.did) return NextResponse.json({ error: 'Only the owner can remove members' }, { status: 403 });
  if (pod.type === 'event') return NextResponse.json({ error: 'Event pods are read-only' }, { status: 403 });

  const body = await request.json();
  if (!body.did) return NextResponse.json({ error: 'did is required' }, { status: 400 });
  if (body.did === session.did) return NextResponse.json({ error: 'Cannot remove yourself as owner' }, { status: 400 });

  const [removed] = await db
    .update(podMembers)
    .set({ removedAt: new Date() })
    .where(and(eq(podMembers.podId, params.id), eq(podMembers.did, body.did)))
    .returning();

  if (!removed) return NextResponse.json({ error: 'Member not found' }, { status: 404 });

  if (session.chainVerified) {
    emitAttestation({
      issuer_did: session.did,
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
