/**
 * GET  /api/events/[id]/invites - List invites (owner/cohost only)
 * POST /api/events/[id]/invites - Create invite link (owner/cohost only)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, events, eventInvites, eventAdmins } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '@/src/lib/auth';
import { randomBytes } from 'crypto';

const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL || 'https://events.imajin.ai';

async function assertOwnerOrAdmin(eventId: string, did: string) {
  const [event] = await db
    .select({ creatorDid: events.creatorDid })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) return { error: 'Event not found', status: 404 };

  if (event.creatorDid === did) return { ok: true };

  const [admin] = await db
    .select()
    .from(eventAdmins)
    .where(and(eq(eventAdmins.eventId, eventId), eq(eventAdmins.did, did)))
    .limit(1);

  if (admin) return { ok: true };

  return { error: 'Not authorized', status: 403 };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { id } = await params;
  const check = await assertOwnerOrAdmin(id, authResult.identity.id);
  if ('error' in check) {
    return NextResponse.json({ error: check.error }, { status: check.status });
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
  const check = await assertOwnerOrAdmin(id, authResult.identity.id);
  if ('error' in check) {
    return NextResponse.json({ error: check.error }, { status: check.status });
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
