import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { createEmitter } from '@imajin/events';
import { requireAuth, emitAttestation } from '@imajin/auth';

const log = createLogger('events');
const events = createEmitter('events');
import { isEventOrganizer } from '@/src/lib/organizer';
import { getClient } from '@imajin/db';

const sql = getClient();

let _nodeDid: string | undefined;
async function getNodeDid(): Promise<string> {
  if (_nodeDid !== undefined) return _nodeDid;
  try {
    const [row] = await sql`SELECT imajin_did FROM relay.relay_config WHERE id = 'singleton' LIMIT 1`;
    _nodeDid = (row?.imajin_did as string | null) || process.env.RELAY_DID || '';
  } catch {
    _nodeDid = process.env.RELAY_DID || '';
  }
  if (!_nodeDid) log.warn({}, '[check-in] No node DID found in relay.relay_config or RELAY_DID');
  return _nodeDid;
}

/**
 * Fire-and-forget hard verification check for a DID.
 * Mirrors checkHardEligibility in apps/kernel — runs in-process via shared DB.
 */
async function triggerHardEligibilityCheck(did: string): Promise<void> {
  const [identity] = await sql`
    SELECT tier, handle_claimed_at FROM auth.identities WHERE id = ${did} LIMIT 1
  `;
  if (!identity || identity.tier !== 'preliminary') return;
  if (!identity.handle_claimed_at) return;

  const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
  if (new Date(identity.handle_claimed_at) > fourWeeksAgo) return;

  const [{ count: connCount }] = await sql`
    SELECT COUNT(DISTINCT partner.id) as count
    FROM connections.connections c
    JOIN auth.identities partner
      ON (c.did_a = ${did} AND partner.id = c.did_b)
      OR (c.did_b = ${did} AND partner.id = c.did_a)
    WHERE c.disconnected_at IS NULL
      AND partner.type = 'human'
  `;
  if (Number(connCount) < 25) return;

  const [attendanceRow] = await sql`
    SELECT id FROM auth.attestations
    WHERE subject_did = ${did} AND type = 'event.attendance'
    LIMIT 1
  `;
  if (!attendanceRow) return;

  // Atomic CAS — only upgrade if still 'preliminary', prevents double emission
  const [upgraded] = await sql`
    UPDATE auth.identities SET tier = 'established', updated_at = NOW()
    WHERE id = ${did} AND tier = 'preliminary'
    RETURNING id
  `;

  if (!upgraded) return;

  const nodeDid = await getNodeDid();
  emitAttestation({
    issuer_did: nodeDid,
    subject_did: did,
    type: 'identity.verified.hard',
    context_id: did,
    context_type: 'identity',
  }).catch((err) => log.error({ err: String(err) }, '[verification] hard emit error'));
}

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
  const did = identity.actingAs || identity.id;
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

    events.emit({ action: 'checkin.create', did, payload: { eventId: id, ticketId, attendeeDid: ticket.owner_did ?? undefined } });

    // Fire-and-forget attestations — do not block check-in on failure
    if (ticket.owner_did) {
      const attendeeDid = ticket.owner_did as string;
      // TODO: institution.verified should be issued BY the event DID, not the organizer.
      // Event DIDs are not real identities (no keypair, no chain). Need sub-identity
      // delegation model before this can be cryptographically correct. See #537.
      // For now, only emit event.attendance (organizer vouches for attendee).
      emitAttestation({
        issuer_did: identity.id,
        subject_did: attendeeDid,
        type: 'event.attendance',
        context_id: id,
        context_type: 'event',
        payload: { ticketId, usedAt: updated.used_at, checkedInBy: identity.id },
      }).catch((err) => log.error({ err: String(err) }, 'Attestation emit error'));

      // Check hard verification eligibility — fire-and-forget
      triggerHardEligibilityCheck(attendeeDid)
        .catch((err) => log.error({ err: String(err) }, '[verification] hard check error'));
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
