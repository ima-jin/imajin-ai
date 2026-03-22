/**
 * DELETE /api/events/[id]/invites/[inviteId] - Revoke invite (owner only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, eventInvites } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; inviteId: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { id, inviteId } = await params;

  const check = await isEventOrganizer(id, authResult.identity.id);
  if (!check.authorized) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
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
