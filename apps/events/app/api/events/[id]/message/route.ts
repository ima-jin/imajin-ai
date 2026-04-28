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

interface MessageFilter {
  type: 'everyone' | 'ticket_type' | 'registration_complete' | 'registration_incomplete';
  ticketTypeIds?: string[];
}

async function checkAuth(request: NextRequest, eventId: string) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return { error: authResult.error, status: authResult.status };
  }
  const did = authResult.identity.actingAs || authResult.identity.id;
  const orgCheck = await isEventOrganizer(eventId, did);
  if (!orgCheck.authorized) {
    return { error: 'Forbidden', status: 403 };
  }
  return { identity: authResult.identity };
}

async function queryRecipients(eventId: string, filter?: MessageFilter) {
  const baseWhere = sql`event_id = ${eventId} AND status IN ('valid', 'used') AND owner_did IS NOT NULL`;

  if (filter) {
    switch (filter.type) {
      case 'ticket_type':
        if (filter.ticketTypeIds && filter.ticketTypeIds.length > 0) {
          const rows = await sql`
            SELECT DISTINCT owner_did
            FROM events.tickets
            WHERE event_id = ${eventId}
              AND status IN ('valid', 'used')
              AND owner_did IS NOT NULL
              AND ticket_type_id = ANY(${filter.ticketTypeIds})
          `;
          return rows.map((r: any) => r.owner_did as string);
        }
        break;
      case 'registration_complete': {
        const rows = await sql`
          SELECT DISTINCT owner_did
          FROM events.tickets
          WHERE event_id = ${eventId}
            AND status IN ('valid', 'used')
            AND owner_did IS NOT NULL
            AND registration_status = 'complete'
        `;
        return rows.map((r: any) => r.owner_did as string);
      }
      case 'registration_incomplete': {
        const rows = await sql`
          SELECT DISTINCT owner_did
          FROM events.tickets
          WHERE event_id = ${eventId}
            AND status IN ('valid', 'used')
            AND owner_did IS NOT NULL
            AND (registration_status IS NULL OR registration_status != 'complete')
        `;
        return rows.map((r: any) => r.owner_did as string);
      }
      case 'everyone':
      default:
        break;
    }
  }

  const rows = await sql`
    SELECT DISTINCT owner_did
    FROM events.tickets
    WHERE event_id = ${eventId}
      AND status IN ('valid', 'used')
      AND owner_did IS NOT NULL
  `;
  return rows.map((r: any) => r.owner_did as string);
}

/**
 * GET /api/events/[id]/message?filterType=...&ticketTypeId=...
 *
 * Get recipient count for a given filter. Used by the message composer
 * to update the displayed count when filters change.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await checkAuth(request, id);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { searchParams } = new URL(request.url);
  const filterType = searchParams.get('filterType') as MessageFilter['type'] | null;
  const ticketTypeIds = searchParams.getAll('ticketTypeId');

  const filter: MessageFilter | undefined = filterType && filterType !== 'everyone'
    ? { type: filterType, ticketTypeIds: ticketTypeIds.length > 0 ? ticketTypeIds : undefined }
    : undefined;

  try {
    const dids = await queryRecipients(id, filter);
    return NextResponse.json({ count: dids.length });
  } catch (err) {
    log.error({ err: String(err) }, '[message] Failed to count recipients');
    return NextResponse.json({ error: 'Failed to count recipients' }, { status: 500 });
  }
}

/**
 * POST /api/events/[id]/message
 *
 * Send a broadcast message to filtered confirmed ticket holders for an event.
 * Caller must be event organizer (creator or cohost).
 *
 * Body: { subject: string; markdown: string; filter?: MessageFilter }
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

  let body: { subject: string; markdown: string; filter?: MessageFilter };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { subject, markdown, filter } = body;
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

  // Fetch distinct attendee DIDs with optional filter
  const dids = await queryRecipients(id, filter);
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
