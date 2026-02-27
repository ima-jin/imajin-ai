import { NextRequest, NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db, invites, pods, podMembers } from '../../../../../src/db/index';
import { generateId } from '../../../../../src/lib/id';

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

export async function POST(
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

  if (invite.usedCount >= invite.maxUses) {
    return NextResponse.json({ error: 'Invite already used' }, { status: 410 });
  }

  if (invite.fromDid === session.did) {
    return NextResponse.json({ error: 'Cannot accept your own invite' }, { status: 400 });
  }

  // Create a 2-person "connection" pod
  const podId = generateId('pod_');
  const senderLabel = invite.fromHandle || invite.fromDid.slice(0, 16);
  const accepterLabel = session.handle || session.did.slice(0, 16);

  await db.insert(pods).values({
    id: podId,
    name: `${senderLabel} ↔ ${accepterLabel}`,
    ownerDid: invite.fromDid,
    type: 'personal',
    visibility: 'private',
  });

  await db.insert(podMembers).values([
    { podId, did: invite.fromDid, role: 'member', addedBy: invite.fromDid },
    { podId, did: session.did, role: 'member', addedBy: session.did },
  ]);

  // Mark invite as consumed
  await db
    .update(invites)
    .set({
      usedCount: sql`${invites.usedCount} + 1`,
      consumedAt: new Date(),
      consumedBy: session.did,
    })
    .where(eq(invites.code, params.code));

  return NextResponse.json({
    ok: true,
    pod: { id: podId, name: `${senderLabel} ↔ ${accepterLabel}` },
  }, { status: 201 });
}
