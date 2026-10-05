import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { requireAuth, resolveActingDid, evaluateEligibility } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { getClient } from '@imajin/db';

const log = createLogger('events');
const sql = getClient();

/**
 * POST /api/events/[id]/tickets/[ticketId]/check-in — set used_at timestamp (owner or cohost)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; ticketId: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const did = resolveActingDid(identity);
  const { id, ticketId } = await params;

  try {
    const orgCheck = await isEventOrganizer(id, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const [ticket] = await sql`
      SELECT id, status, used_at, owner_did FROM events.tickets
      WHERE id = ${ticketId} AND event_id = ${id}
      LIMIT 1
    `;

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    if (ticket.status !== 'valid') {
      return NextResponse.json({ error: 'Ticket is not valid' }, { status: 400 });
    }

    if (ticket.used_at) {
      return NextResponse.json({ error: 'Ticket already checked in' }, { status: 400 });
    }

    const [updated] = await sql`
      UPDATE events.tickets
      SET used_at = NOW(), status = 'used'
      WHERE id = ${ticketId}
      RETURNING id, used_at, status
    `;

    publish('checkin.create', {
      issuer: did,
      subject: did,
      scope: 'events',
      payload: { eventId: id, ticketId, attendeeDid: ticket.owner_did ?? undefined },
    }).catch((err) => log.error({ err: String(err) }, 'Publish error'));

    // Fire-and-forget attestations — do not block check-in on failure
    if (ticket.owner_did) {
      const attendeeDid = ticket.owner_did as string;
      // institution.verified should be issued BY the event DID, not the organizer.
      // Event DIDs are not real identities (no keypair, no chain), so a sub-identity
      // delegation model is required before this can be cryptographically correct
      // (see #537). For now, only emit event.attendance (organizer vouches for attendee).
      publish('event.attendance', {
        issuer: identity.id,
        subject: attendeeDid,
        scope: 'events',
        payload: {
          ticketId,
          usedAt: updated.used_at,
          checkedInBy: identity.id,
          context_id: id,
          context_type: 'event',
        },
      }).catch((err) => log.error({ err: String(err) }, 'Publish error'));

      // Check hard verification eligibility — fire-and-forget. The kernel
      // (POST /auth/api/eligibility/evaluate, #1999) owns the rule and the
      // tier upgrade + attestation emission; this app no longer reads or
      // writes auth.identities directly.
      evaluateEligibility(attendeeDid)
        .catch((err) => log.error({ err: String(err) }, '[verification] eligibility evaluation error'));
    }

    // Fire-and-forget check-in webhook — do not block check-in on failure
    const webhookUrl = process.env.CHECKIN_WEBHOOK_URL;
    if (webhookUrl) {
      (async () => {
        try {
          const [countRow] = await sql`
            SELECT COUNT(*) as count FROM events.tickets
            WHERE event_id = ${id} AND used_at IS NOT NULL
          `;
          const [eventRow] = await sql`
            SELECT title FROM events.events WHERE id = ${id}
          `;
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'checkin',
              eventId: id,
              eventTitle: eventRow?.title ?? null,
              ticketId,
              ownerDid: ticket.owner_did ?? null,
              checkedInAt: updated.used_at,
              attendeeCount: Number(countRow?.count ?? 0),
            }),
          });
        } catch (err) {
          log.error({ err: String(err) }, 'Check-in webhook error');
        }
      })();
    }

    return NextResponse.json({ ticket: { id: updated.id, usedAt: updated.used_at } });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to check in ticket');
    return NextResponse.json({ error: 'Failed to check in ticket' }, { status: 500 });
  }
}
