/**
 * DELETE /api/events/[id]/invites/[inviteId] - Revoke invite (owner only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, events, eventInvites } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '@/src/lib/auth';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; inviteId: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { id, inviteId } = await params;

  const [event] = await db
    .select({ creatorDid: events.creatorDid })
    .from(events)
    .where(eq(events.id, id))
    .limit(1);

  if (!event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  if (event.creatorDid !== authResult.identity.id) {
    return NextResponse.json({ error: 'Only the event owner can revoke invites' }, { status: 403 });
  }

  const deleted = await db
    .delete(eventInvites)
    .where(and(eq(eventInvites.id, inviteId), eq(eventInvites.eventId, id)))
    .returning();

  if (!deleted.length) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
