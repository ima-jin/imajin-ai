import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { getClient } from '@imajin/db';

export const dynamic = 'force-dynamic';

const sql = getClient();

const NOTIFY_URL = process.env.NOTIFY_SERVICE_URL || process.env.NOTIFY_URL || 'http://localhost:3008';
const NOTIFY_WEBHOOK_SECRET = process.env.NOTIFY_WEBHOOK_SECRET;

/**
 * POST /api/events/[id]/message
 *
 * Send a broadcast message to all confirmed ticket holders for an event.
 * Caller must be event organizer (creator or cohost).
 *
 * Body: { subject: string; markdown: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const { id } = await params;

  const orgCheck = await isEventOrganizer(id, identity.id);
  if (!orgCheck.authorized) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: { subject: string; markdown: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { subject, markdown } = body;
  if (!subject || !markdown) {
    return NextResponse.json({ error: 'Missing required fields: subject, markdown' }, { status: 400 });
  }

  if (!NOTIFY_WEBHOOK_SECRET) {
    console.error('[message] NOTIFY_WEBHOOK_SECRET not configured');
    return NextResponse.json({ error: 'Broadcast service not configured' }, { status: 500 });
  }

  // Fetch distinct attendee DIDs for confirmed (paid) tickets
  const ticketRows = await sql`
    SELECT DISTINCT owner_did
    FROM events.tickets
    WHERE event_id = ${id}
      AND status IN ('valid', 'used')
      AND owner_did IS NOT NULL
  `;

  const dids = ticketRows.map((r: any) => r.owner_did as string);
  const total = dids.length;

  if (total === 0) {
    return NextResponse.json({ sent: 0, skipped: 0, errors: 0, total: 0 });
  }

  // Forward to notify broadcast
  let broadcastResult: { sent: number; skipped: number; errors: number };
  try {
    const res = await fetch(`${NOTIFY_URL}/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': NOTIFY_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        scope: 'events',
        dids,
        subject,
        markdown,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[message] Broadcast failed: ${res.status} ${err}`);
      return NextResponse.json({ error: 'Broadcast failed' }, { status: 502 });
    }

    broadcastResult = await res.json();
  } catch (err) {
    console.error('[message] Broadcast request error:', err);
    return NextResponse.json({ error: 'Broadcast service unavailable' }, { status: 502 });
  }

  return NextResponse.json({
    sent: broadcastResult.sent,
    skipped: broadcastResult.skipped,
    errors: broadcastResult.errors,
    total,
  });
}
