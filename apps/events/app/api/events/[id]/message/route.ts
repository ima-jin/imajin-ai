import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { requireAuth } from '@imajin/auth';

const log = createLogger('events');
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
  const did = identity.actingAs || identity.id;
  const { id } = await params;

  const orgCheck = await isEventOrganizer(id, did);
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
    log.error({}, '[message] NOTIFY_WEBHOOK_SECRET not configured');
    return NextResponse.json({ error: 'Broadcast service not configured' }, { status: 500 });
  }

  // Fetch event details for context
  const [event] = await sql`
    SELECT title, image_url, starts_at FROM events.events WHERE id = ${id}
  `;

  if (!event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
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

  // Prepend event subject and context
  const fullSubject = `${event.title}: ${subject}`;

  // Resolve organizer email for reply-to
  const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
  let organizerEmail: string | undefined;
  try {
    const contactRes = await fetch(
      `${AUTH_SERVICE_URL}/api/identity/${encodeURIComponent(identity.id)}/contact`,
      { headers: { 'x-webhook-secret': NOTIFY_WEBHOOK_SECRET }, cache: 'no-store' },
    );
    if (contactRes.ok) {
      const contactData = await contactRes.json();
      organizerEmail = contactData.email;
    }
  } catch {}

  // Forward to notify broadcast with event-contextualized HTML
  const EVENTS_URL = process.env.NEXT_PUBLIC_EVENTS_URL || 'http://localhost:3006';

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
        subject: fullSubject,
        markdown,
        eventContext: {
          title: event.title,
          imageUrl: event.image_url
            ? (event.image_url.startsWith('http') ? event.image_url : `${EVENTS_URL}${event.image_url}`)
            : null,
          eventUrl: `${EVENTS_URL}/${id}`,
        },
        ...(organizerEmail ? { replyTo: organizerEmail } : {}),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      log.error({ status: res.status, err }, '[message] Broadcast failed');
      return NextResponse.json({ error: 'Broadcast failed' }, { status: 502 });
    }

    broadcastResult = await res.json();
  } catch (err) {
    log.error({ err: String(err) }, '[message] Broadcast request error');
    return NextResponse.json({ error: 'Broadcast service unavailable' }, { status: 502 });
  }

  return NextResponse.json({
    sent: broadcastResult.sent,
    skipped: broadcastResult.skipped,
    errors: broadcastResult.errors,
    total,
  });
}
