import { NextRequest, NextResponse } from 'next/server';
import { db, pods, podMembers } from '@/src/db';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { getSessionFromCookies } from '@/src/lib/kernel/session';
import { lookupIdentity } from '@/src/lib/kernel/lookup';

async function resolveIdentity(did: string) {
  const identity = await lookupIdentity(did);
  if (!identity) return { handle: null, name: null };
  return { handle: identity.handle, name: identity.name };
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSessionFromCookies(request.headers.get('cookie'));
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const [pod] = await db.select().from(pods).where(eq(pods.id, params.id));
  if (!pod) return NextResponse.json({ error: 'Pod not found' }, { status: 404 });

  const members = await db
    .select()
    .from(podMembers)
    .where(and(eq(podMembers.podId, params.id), isNull(podMembers.removedAt)));

  // Verify requester is a member
  const isMember = members.some((m) => m.did === session.did);
  if (!isMember) return NextResponse.json({ error: 'Not a member' }, { status: 403 });

  // Resolve member profiles
  const resolved = await Promise.all(
    members.map(async (m) => {
      const profile = await resolveIdentity(m.did);
      return { ...m, ...profile };
    })
  );

  const memberCount = members.length;

  return NextResponse.json({ pod: { ...pod, memberCount }, members: resolved });
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSessionFromCookies(request.headers.get('cookie'));
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await request.json();

  // Setting conversationDid only requires membership, not ownership
  const isConversationDidOnly = Object.keys(body).length === 1 && body.conversationDid !== undefined;

  if (isConversationDidOnly) {
    // Verify requester is a member
    const members = await db
      .select()
      .from(podMembers)
      .where(and(eq(podMembers.podId, params.id), isNull(podMembers.removedAt)));
    const isMember = members.some((m) => m.did === session.did);
    if (!isMember) return NextResponse.json({ error: 'Not a member' }, { status: 403 });

    // Only set if not already set (first-write wins)
    const [pod] = await db.select().from(pods).where(eq(pods.id, params.id));
    if (!pod) return NextResponse.json({ error: 'Pod not found' }, { status: 404 });

    if (!pod.conversationDid) {
      const [updated] = await db
        .update(pods)
        .set({ conversationDid: body.conversationDid, updatedAt: new Date() })
        .where(eq(pods.id, params.id))
        .returning();
      return NextResponse.json({ pod: updated });
    }
    return NextResponse.json({ pod });
  }

  // All other updates require ownership
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.description !== undefined) updates.description = body.description?.trim() || null;
  if (body.conversationDid !== undefined) updates.conversationDid = body.conversationDid;

  const [updated] = await db
    .update(pods)
    .set(updates)
    .where(and(eq(pods.id, params.id), eq(pods.ownerDid, session.did)))
    .returning();

  if (!updated) return NextResponse.json({ error: 'Pod not found or unauthorized' }, { status: 404 });
  return NextResponse.json({ pod: updated });
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSessionFromCookies(request.headers.get('cookie'));
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const [deleted] = await db
    .delete(pods)
    .where(and(eq(pods.id, params.id), eq(pods.ownerDid, session.did)))
    .returning();

  if (!deleted) return NextResponse.json({ error: 'Pod not found or unauthorized' }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
