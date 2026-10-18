import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, invites, profiles } from '@/src/db';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { resolveEffectiveDid } from '@imajin/auth';

export function OPTIONS(request: NextRequest) {
  const response = corsOptions(request);
  response.headers.set('Access-Control-Allow-Methods', `${response.headers.get('Access-Control-Allow-Methods')}, PATCH`);
  return response;
}

function withInviteCors(response: NextResponse, request: NextRequest) {
  for (const [key, value] of Object.entries(corsHeaders(request))) response.headers.set(key, value);
  return response;
}

export async function GET(_request: NextRequest, props: { params: Promise<{ code: string }> }) {
  const params = await props.params;
  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.code, params.code))
    .limit(1);

  if (!invite) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
  }
  if (invite.delivery === 'direct') {
    const auth = await resolveEffectiveDid(_request, { scope: 'connections:read' });
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (auth.effectiveDid !== invite.fromDid && auth.effectiveDid !== invite.toDid) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }
  }

  const response = NextResponse.json({
    id: invite.id,
    code: invite.code,
    fromDid: invite.fromDid,
    fromHandle: invite.fromHandle,
    note: invite.note,
    used: invite.usedCount >= invite.maxUses || invite.status !== 'pending',
    createdAt: invite.createdAt,
    // Invite context extension (#1834 Phase 2): scopeDid is safe to expose
    // client-side (it's the same org/community DID `/auth/onboard?scope=`
    // already accepts). `pendingAttestationId` stays server-side — it is
    // resolved from the invite row by code at accept/onboard time instead.
    scopeDid: invite.scopeDid,
  });

  // Allow cross-origin reads from *.imajin.ai (auth needs to validate invites client-side)
  const headers = corsHeaders(_request);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }

  return response;
}

export async function DELETE(request: NextRequest, props: { params: Promise<{ code: string }> }) {
  return withInviteCors(await deleteInvite(request, props), request);
}

async function deleteInvite(request: NextRequest, props: { params: Promise<{ code: string }> }) {
  const params = await props.params;
  const auth = await resolveEffectiveDid(request, { scope: 'connections:write', service: 'connections' });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.code, params.code))
    .limit(1);

  if (!invite) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
  }

  if (invite.delivery === 'direct') {
    const { directInviteResponse, transitionDirectInvite } = await import('@/src/lib/connections/direct-invites');
    return directInviteResponse(() => transitionDirectInvite(request, invite, 'cancel'));
  }
  if (invite.fromDid !== auth.effectiveDid) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  if (invite.status !== 'pending') {
    return NextResponse.json({ error: `Cannot revoke ${invite.status} invite` }, { status: 400 });
  }

  // Soft delete: set status to revoked
  await db
    .update(invites)
    .set({ status: 'revoked' })
    .where(eq(invites.code, params.code));

  // For email invites, clear the cooldown so the user can invite again immediately
  if (invite.delivery === 'email') {
    await db
      .update(profiles)
      .set({ nextInviteAvailableAt: null })
      .where(eq(profiles.did, auth.effectiveDid));
  }

  return NextResponse.json({ ok: true });
}

export async function PATCH(request: NextRequest, props: { params: Promise<{ code: string }> }) {
  return withInviteCors(await declineInvite(request, props), request);
}

async function declineInvite(request: NextRequest, props: { params: Promise<{ code: string }> }) {
  const { code } = await props.params;
  const body = await request.json().catch(() => ({}));
  if (body?.action !== 'decline') {
    return NextResponse.json({ error: 'action must be decline' }, { status: 400 });
  }
  const [invite] = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
  if (!invite) return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
  if (invite.delivery !== 'direct') {
    return NextResponse.json({ error: 'Only direct requests can be declined' }, { status: 400 });
  }
  const { directInviteResponse, transitionDirectInvite } = await import('@/src/lib/connections/direct-invites');
  return directInviteResponse(() => transitionDirectInvite(request, invite, 'decline'));
}
