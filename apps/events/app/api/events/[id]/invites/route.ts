/**
 * GET  /api/events/[id]/invites - List invites (owner/cohost only)
 * POST /api/events/[id]/invites - Create invite link (owner/cohost only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, eventInvites } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { randomBytes } from 'crypto';

const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { id } = await params;
  const check = await isEventOrganizer(id, authResult.identity.id);
  if (!check.authorized) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  const invites = await db
    .select()
    .from(eventInvites)
    .where(eq(eventInvites.eventId, id));

  const withUrls = invites.map(inv => ({
    ...inv,
    url: `${EVENTS_URL}/${id}?invite=${inv.token}`,
  }));

  return NextResponse.json({ invites: withUrls });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { id } = await params;
  const check = await isEventOrganizer(id, authResult.identity.id);
  if (!check.authorized) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  const body = await request.json();
  const { label, maxUses, expiresAt } = body;

  const inviteId = `inv_${randomBytes(12).toString('hex')}`;
  const token = randomBytes(16).toString('hex');

  const [invite] = await db
    .insert(eventInvites)
    .values({
      id: inviteId,
      eventId: id,
      token,
      label: label || null,
      maxUses: maxUses || null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    })
    .returning();

  return NextResponse.json({
    invite: {
      ...invite,
      url: `${EVENTS_URL}/${id}?invite=${invite.token}`,
    },
  });
}
