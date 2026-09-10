import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { requireAuth , resolveActingDid, resolveIdentitiesForDids } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { getClient } from '@imajin/db';
import { resolveAttendee } from '@/src/lib/attendee';
import {
  warnDuplicateSurveyResponses,
  loadSurveyFormData,
  buildSurveyValues,
} from '@/src/lib/guest-export-helpers';

const log = createLogger('events');
const sql = getClient();

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    ? String(v)
    : JSON.stringify(v);
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(',') + '\r\n';
}

function buildProofOfPayment(
  paymentMethod: string | null,
  status: string,
  paymentConfirmedAt: string | Date | null
): string {
  if (!paymentMethod) return '';
  if (paymentMethod === 'etransfer') {
    if (paymentConfirmedAt) {
      const dateStr = typeof paymentConfirmedAt === 'string'
        ? paymentConfirmedAt.split('T')[0]
        : new Date(paymentConfirmedAt).toISOString().split('T')[0];
      return `etransfer / confirmed ${dateStr}`;
    }
    return 'etransfer / pending';
  }
  if (paymentMethod === 'free') {
    return 'free / n/a';
  }
  const displayStatus = status === 'valid' ? 'paid' : status;
  return `${paymentMethod} / ${displayStatus}`;
}

function resolvePaymentId(
  ticketPaymentId: string | null,
  orderPaymentId: string | null,
  orderStripeSessionId: string | null,
  paymentMethod: string | null
): string {
  if (paymentMethod === 'etransfer' || paymentMethod === 'free') return '';
  return ticketPaymentId || orderPaymentId || orderStripeSessionId || '';
}

/**
 * GET /api/events/[id]/guests/export.csv — export guest list as CSV
 * Query params:
 *   ?includeCancelled=1 — include cancelled/refunded tickets
 *   ?summary=1          — return JSON summary instead of CSV
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const did = resolveActingDid(identity);
  const { id } = await params;

  const url = new URL(request.url);
  const includeCancelled = url.searchParams.get('includeCancelled') === '1';
  const summaryMode = url.searchParams.get('summary') === '1';

  try {
    const orgCheck = await isEventOrganizer(id, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const [event] = await sql`
      SELECT id, title FROM events.events WHERE id = ${id} LIMIT 1
    `;
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    const statusFilter = includeCancelled
      ? sql``
      : sql`AND t.status NOT IN ('cancelled', 'refunded')`;

    const ticketRows = await sql`
      SELECT
        t.id,
        t.status,
        t.owner_did,
        t.purchased_at,
        t.payment_method,
        t.payment_id AS ticket_payment_id,
        t.payment_confirmed_at,
        t.registration_status,
        t.order_id,
        tt.name AS ticket_type,
        tt.registration_form_id,
        sr.id AS survey_response_id,
        sr.survey_id AS survey_form_id,
        sr.answers AS survey_answers,
        o.payment_id AS order_payment_id,
        o.stripe_session_id,
        o.buyer_email,
        o.buyer_did
      FROM events.tickets t
      JOIN events.ticket_types tt ON t.ticket_type_id = tt.id
      LEFT JOIN events.orders o ON t.order_id = o.id
      LEFT JOIN LATERAL (
        SELECT id, survey_id, answers
        FROM dykil.survey_responses
        WHERE ticket_id = t.id
        ORDER BY created_at DESC LIMIT 1
      ) sr ON true
      WHERE t.event_id = ${id}
      ${statusFilter}
      ORDER BY t.created_at DESC
    `;

    // Detect duplicate survey responses and warn
    const ticketIds = ticketRows.map((t: any) => t.id);
    await warnDuplicateSurveyResponses(ticketIds, sql, log);

    if (summaryMode) {
      const total = ticketRows.length;
      const valid = ticketRows.filter((t: any) => !['cancelled', 'refunded'].includes(t.status)).length;
      const pendingRegistration = ticketRows.filter((t: any) => t.registration_status === 'pending').length;
      const completeRegistration = ticketRows.filter((t: any) => t.registration_status === 'complete').length;
      const cancelled = ticketRows.filter((t: any) => ['cancelled', 'refunded'].includes(t.status)).length;
      return NextResponse.json({ total, valid, pendingRegistration, completeRegistration, cancelled });
    }

    // Batch-resolve unique owner DIDs for name/handle/email via the profile
    // service's batched /api/resolve route (#1998) — replaces the raw
    // auth.identities / auth.credentials joins this query used to run for
    // itself, plus the separate per-DID AUTH_SERVICE_URL /api/lookup call.
    const uniqueDids = [...new Set(
      ticketRows.flatMap((t: any) => [t.owner_did, t.buyer_did]).filter(Boolean)
    )] as string[];
    const resolvedMap = await resolveIdentitiesForDids(uniqueDids);

    // Find distinct form IDs used by this event's ticket types
    const formIds = [...new Set(ticketRows.map((t: any) => t.registration_form_id).filter(Boolean))] as string[];

    // Fetch form definitions and build survey column list
    const { surveyColumns, formFieldMap } = await loadSurveyFormData(formIds, sql);

    // Build CSV
    const dateStr = new Date().toISOString().split('T')[0];
    const safeTitle = event.title
      ? event.title.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
      : event.id;
    const filename = `${safeTitle || event.id}-guests-${dateStr}.csv`;

    const baseHeaders = [
      'Ticket ID',
      'Order ID',
      'Payment ID',
      'Guest Full Name',
      'Guest Email',
      'Ticket Type',
      'Proof of Payment',
      'Status',
      'Registration Status',
      'Guest Of',
      'Purchased At',
    ];
    const headers = [...baseHeaders, ...surveyColumns, 'Owner DID'];

    let csvBody = csvRow(headers);

    for (const t of ticketRows) {
      const ownerResolved = t.owner_did ? resolvedMap.get(t.owner_did) : undefined;
      const buyerResolved = t.buyer_did ? resolvedMap.get(t.buyer_did) : undefined;

      const surveyAnswers = t.survey_answers || {};
      const surveyName = surveyAnswers.full_name || surveyAnswers.name || null;
      const surveyEmail = surveyAnswers.email || null;

      const resolved = resolveAttendee({
        surveyName,
        surveyEmail,
        identityName: ownerResolved?.displayName || null,
        identityContactEmail: ownerResolved?.email || null,
        identityCredentialEmail: null,
        profileName: null,
        profileEmail: null,
        buyerName: buyerResolved?.displayName || null,
        buyerEmail: t.buyer_email || null,
      });

      const paymentId = resolvePaymentId(
        t.ticket_payment_id,
        t.order_payment_id,
        t.stripe_session_id,
        t.payment_method
      );

      const proofOfPayment = buildProofOfPayment(
        t.payment_method,
        t.status,
        t.payment_confirmed_at
      );

      const baseValues = [
        t.id,
        t.order_id || '',
        paymentId,
        resolved.name,
        resolved.email,
        t.ticket_type,
        proofOfPayment,
        t.status,
        t.registration_status || '',
        resolved.guestOf,
        t.purchased_at ? new Date(t.purchased_at).toISOString() : '',
      ];

      // Survey answers
      const surveyValues = buildSurveyValues(
        { survey_form_id: t.survey_form_id, survey_answers: surveyAnswers as any },
        surveyColumns,
        formFieldMap,
      );

      csvBody += csvRow([...baseValues, ...surveyValues, t.owner_did || '']);
    }

    const bom = '\uFEFF';
    return new NextResponse(bom + csvBody, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to export guest list');
    return NextResponse.json({ error: 'Failed to export guest list' }, { status: 500 });
  }
}
