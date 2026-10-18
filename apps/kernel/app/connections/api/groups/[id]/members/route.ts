import { NextRequest, NextResponse } from 'next/server';
import { db, pods, podMembers } from '@/src/db';
import { publish } from '@imajin/bus';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth, resolveEffectiveDid } from '@imajin/auth';
import { getSessionForDid } from '@/src/lib/kernel/session';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');
async function resolveMemberAuth(request: NextRequest) {
  const auth = await resolveEffectiveDid(request, { scope: 'connections:write' });
  if (!auth.ok) return auth;

  const session = await getSessionForDid(auth.effectiveDid);
  if (!session) return { ok: false as const, error: 'Not authenticated', status: 401 };

  // Effective DID owns the action; retain the authenticated controller separately
  // so an org-issued attestation does not erase who performed the operation.
  let actorDid: string | undefined;
  if (auth.via === 'session') {
    const caller = await requireAuth(request);
    if ('error' in caller) return { ok: false as const, error: caller.error, status: caller.status };
    if (caller.identity.id !== auth.effectiveDid) actorDid = caller.identity.id;
  }
  return { ...auth, chainVerified: session.chainVerified, actor: actorDid ? { actorDid } : {} };
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await resolveMemberAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const [pod] = await db.select().from(pods).where(eq(pods.id, params.id));
  if (!pod) return NextResponse.json({ error: 'Pod not found' }, { status: 404 });
  if (pod.ownerDid !== auth.effectiveDid) return NextResponse.json({ error: 'Only the owner can add members' }, { status: 403 });
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
    addedBy: auth.effectiveDid,
    joinedAt: new Date().toISOString(),
  }).returning();

  if (auth.chainVerified) {
    publish('pod.member.added', {
      issuer: auth.effectiveDid,
      subject: body.did,
      scope: 'connections',
      payload: { context_id: params.id, context_type: 'pod', role: member.role, ...auth.actor },
    }).catch((err: unknown) => {
      log.error({ err: String(err) }, 'Attestation (pod.member.added) error');
    });
  }

  return NextResponse.json({ member }, { status: 201 });
}

export async function PATCH(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await resolveEffectiveDid(request, { scope: 'connections:write' });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const [pod] = await db.select().from(pods).where(eq(pods.id, params.id));
  if (!pod) return NextResponse.json({ error: 'Pod not found' }, { status: 404 });
  if (pod.ownerDid !== auth.effectiveDid) return NextResponse.json({ error: 'Only the owner can change roles' }, { status: 403 });
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
    publish('pod.role.changed', {
      issuer: auth.effectiveDid,
      subject: body.did,
      scope: 'connections',
      payload: { context_id: params.id, context_type: 'pod', role: body.role, ...auth.actor },
    }).catch((err: unknown) => {
      log.error({ err: String(err) }, 'Attestation (pod.role.changed) error');
    });
  }

  return NextResponse.json({ member: updated });
}

export async function DELETE(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await resolveEffectiveDid(request, { scope: 'connections:write' });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const [pod] = await db.select().from(pods).where(eq(pods.id, params.id));
  if (!pod) return NextResponse.json({ error: 'Pod not found' }, { status: 404 });
  if (pod.ownerDid !== auth.effectiveDid) return NextResponse.json({ error: 'Only the owner can remove members' }, { status: 403 });
  if (pod.type === 'event') return NextResponse.json({ error: 'Event pods are read-only' }, { status: 403 });

  const body = await request.json();
  if (!body.did) return NextResponse.json({ error: 'did is required' }, { status: 400 });
  if (body.did === auth.effectiveDid) return NextResponse.json({ error: 'Cannot remove yourself as owner' }, { status: 400 });

  const [removed] = await db
    .update(podMembers)
    .set({ removedAt: new Date().toISOString() })
    .where(and(eq(podMembers.podId, params.id), eq(podMembers.did, body.did)))
    .returning();

  if (!removed) return NextResponse.json({ error: 'Member not found' }, { status: 404 });

  if (session.chainVerified) {
    publish('pod.member.removed', {
      issuer: auth.effectiveDid,
      subject: body.did,
      scope: 'connections',
      payload: { context_id: params.id, context_type: 'pod', ...auth.actor },
    }).catch((err: unknown) => {
      log.error({ err: String(err) }, 'Attestation (pod.member.removed) error');
    });
  }

  return NextResponse.json({ removed: true });
}
