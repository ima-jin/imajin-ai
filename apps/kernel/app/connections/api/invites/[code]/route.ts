import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, invites, profiles } from '../../../../src/db/index';
import { corsHeaders, corsOptions } from '@/src/lib/connections/cors';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
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

export async function GET(
  _request: NextRequest,
  { params }: { params: { code: string } }
) {
  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.code, params.code))
    .limit(1);

  if (!invite) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
  }

  const response = NextResponse.json({
    id: invite.id,
    code: invite.code,
    fromDid: invite.fromDid,
    fromHandle: invite.fromHandle,
    note: invite.note,
    used: invite.usedCount >= invite.maxUses || invite.status !== 'pending',
    createdAt: invite.createdAt,
  });

  // Allow cross-origin reads from *.imajin.ai (auth needs to validate invites client-side)
  const headers = corsHeaders(_request);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }

  return response;
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { code: string } }
) {
  const session = await getSession(request);
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.code, params.code))
    .limit(1);

  if (!invite) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
  }

  if (invite.fromDid !== session.did) {
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
      .where(eq(profiles.did, session.did));
  }

  return NextResponse.json({ ok: true });
}
