import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { requireAuth, requireAppAuth , resolveActingDid, resolveIdentitiesForDids } from '@imajin/auth';
import { corsHeaders } from '@imajin/config';

const log = createLogger('events');
import { isEventOrganizer } from '@/src/lib/organizer';
import { getClient } from '@imajin/db';
import { resolveAttendee } from '@/src/lib/attendee';

const sql = getClient();

/**
 * GET /api/events/[id]/guests — list all tickets with profile info (owner or cohost)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);
  let did: string;

  // App auth path
  if (request.headers.get('x-app-did')) {
    const appResult = await requireAppAuth(request, { scope: 'events:read' });
    if ('error' in appResult) {
      return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
    }
    did = appResult.appAuth.userDid;
  } else {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const { identity } = authResult;
    did = resolveActingDid(identity);
  }

  const { id } = await params;

  try {
    const orgCheck = await isEventOrganizer(id, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const isOwner = orgCheck.role === 'creator' || orgCheck.role === 'cohost';

    const ticketRows = await sql`
      SELECT t.id, t.status, t.owner_did, t.price_paid, t.currency, t.purchased_at, t.used_at,
             t.payment_method, t.payment_id, t.hold_expires_at, t.registration_status,
             t.last_email_sent_at,
             tt.name as ticket_type,
             sr.answers as survey_answers,
             o.fair_settlement, o.amount_total,
             o.buyer_email,
             o.buyer_did
      FROM events.tickets t
      JOIN events.ticket_types tt ON t.ticket_type_id = tt.id
      LEFT JOIN LATERAL (
        SELECT answers FROM dykil.survey_responses
        WHERE ticket_id = t.id
        ORDER BY created_at DESC LIMIT 1
      ) sr ON true
      LEFT JOIN events.orders o ON t.order_id = o.id
      WHERE t.event_id = ${id}
      ORDER BY t.created_at DESC
    `;

    // Batch-resolve unique owner/buyer DIDs via the profile service's batched
    // /api/resolve route (#1998) — replaces the raw auth.identities /
    // auth.credentials joins this query used to run for itself, plus the
    // separate per-DID AUTH_SERVICE_URL /api/lookup HTTP call.
    const uniqueDids = [...new Set(
      ticketRows.flatMap((t: any) => [t.owner_did, t.buyer_did]).filter(Boolean)
    )] as string[];
    const resolvedMap = await resolveIdentitiesForDids(uniqueDids);

    const guests = ticketRows.map((t: any) => {
      const ownerResolved = t.owner_did ? resolvedMap.get(t.owner_did) : undefined;
      const buyerResolved = t.buyer_did ? resolvedMap.get(t.buyer_did) : undefined;

      const surveyAnswers = t.survey_answers || {};
      const resolved = resolveAttendee({
        surveyName: surveyAnswers.full_name || surveyAnswers.name || null,
        surveyEmail: surveyAnswers.email || null,
        identityName: ownerResolved?.displayName || null,
        identityContactEmail: ownerResolved?.email || null,
        identityCredentialEmail: null,
        profileName: null,
        profileEmail: null,
        buyerName: buyerResolved?.displayName || null,
        buyerEmail: t.buyer_email || null,
      });

      return {
        id: t.id,
        status: t.status,
        ownerDid: t.owner_did,
        pricePaid: t.price_paid,
        currency: t.currency,
        purchasedAt: t.purchased_at,
        usedAt: t.used_at,
        ticketType: t.ticket_type,
        paymentMethod: t.payment_method ?? null,
        paymentId: t.payment_id ?? null,
        holdExpiresAt: t.hold_expires_at ?? null,
        profile: ownerResolved
          ? { name: ownerResolved.displayName, handle: ownerResolved.handle, avatar: null, email: ownerResolved.email ?? null }
          : null,
        registrationStatus: t.registration_status ?? null,
        attendeeName: surveyAnswers.full_name || surveyAnswers.name || null,
        resolvedName: resolved.name || null,
        resolvedEmail: resolved.email || null,
        guestOf: resolved.guestOf || null,
        lastEmailSentAt: t.last_email_sent_at ?? null,
        fairSettlement: t.fair_settlement ?? null,
        orderAmountTotal: t.amount_total ?? null,
      };
    });

    return NextResponse.json({ guests, isOwner });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch guests');
    return NextResponse.json({ error: 'Failed to fetch guests' }, { status: 500 });
  }
}
