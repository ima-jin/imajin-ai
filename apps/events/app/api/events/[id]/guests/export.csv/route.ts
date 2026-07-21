import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { requireAuth , resolveActingDid } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { getClient } from '@imajin/db';
import { resolveAttendee } from '@/src/lib/attendee';

const log = createLogger('events');
const sql = getClient();
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

/** Strip HTML tags and collapse whitespace for clean CSV headers */
function stripHtml(s: string): string {
  let out = '';
  let inTag = false;
  for (const ch of s) {
    if (ch === '<') {
      inTag = true;
      continue;
    }
    if (ch === '>') {
      inTag = false;
      continue;
    }
    if (!inTag) out += ch;
  }

  let collapsed = '';
  let prevWasSpace = false;
  for (const ch of out) {
    const isSpace = ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
    if (isSpace) {
      if (!prevWasSpace) collapsed += ' ';
      prevWasSpace = true;
    } else {
      collapsed += ch;
      prevWasSpace = false;
    }
  }
  return collapsed.trim();
}

function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(',') + '\r\n';
}

async function resolveProfile(did: string): Promise<{ name: string | null; handle: string | null; email: string | null }> {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(did)}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const identity = data.identity || data;
      return {
        name: identity.name || null,
        handle: identity.handle || null,
        email: identity.email || null,
      };
    }
  } catch { /* ignore */ }
  return { name: null, handle: null, email: null };
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
        o.buyer_did,
        i.name AS identity_name,
        i.contact_email,
        cred.value AS credential_email,
        buyer_i.name AS buyer_name
      FROM events.tickets t
      JOIN events.ticket_types tt ON t.ticket_type_id = tt.id
      LEFT JOIN events.orders o ON t.order_id = o.id
      LEFT JOIN auth.identities i ON i.id = t.owner_did
      LEFT JOIN LATERAL (
        SELECT value FROM auth.credentials
        WHERE did = t.owner_did AND type = 'email'
        ORDER BY created_at DESC LIMIT 1
      ) cred ON true
      LEFT JOIN LATERAL (
        SELECT id, survey_id, answers
        FROM dykil.survey_responses
        WHERE ticket_id = t.id
        ORDER BY created_at DESC LIMIT 1
      ) sr ON true
      LEFT JOIN auth.identities buyer_i ON buyer_i.id = o.buyer_did
      WHERE t.event_id = ${id}
      ${statusFilter}
      ORDER BY t.created_at DESC
    `;

    // Detect duplicate survey responses and warn
    const ticketIds = ticketRows.map((t: any) => t.id);
    if (ticketIds.length > 0) {
      const dupRows = await sql`
        SELECT ticket_id, COUNT(*) as cnt
        FROM dykil.survey_responses
        WHERE ticket_id = ANY(${ticketIds})
        GROUP BY ticket_id
        HAVING COUNT(*) > 1
      `;
      for (const row of dupRows) {
        log.warn(
          { ticketId: row.ticket_id, count: Number(row.cnt) },
          'Ticket has multiple survey responses; using most recent'
        );
      }
    }

    if (summaryMode) {
      const total = ticketRows.length;
      const valid = ticketRows.filter((t: any) => !['cancelled', 'refunded'].includes(t.status)).length;
      const pendingRegistration = ticketRows.filter((t: any) => t.registration_status === 'pending').length;
      const completeRegistration = ticketRows.filter((t: any) => t.registration_status === 'complete').length;
      const cancelled = ticketRows.filter((t: any) => ['cancelled', 'refunded'].includes(t.status)).length;
      return NextResponse.json({ total, valid, pendingRegistration, completeRegistration, cancelled });
    }

    // Batch-resolve unique owner DIDs for profile name/email
    const uniqueDids = [...new Set(ticketRows.map((t: any) => t.owner_did).filter(Boolean))] as string[];
    const profileMap = new Map<string, { name: string | null; handle: string | null; email: string | null }>();
    await Promise.all(
      uniqueDids.map(async (ownerDid) => {
        const profile = await resolveProfile(ownerDid);
        profileMap.set(ownerDid, profile);
      })
    );

    // Find distinct form IDs used by this event's ticket types
    const formIds = [...new Set(ticketRows.map((t: any) => t.registration_form_id).filter(Boolean))] as string[];

    // Fetch form definitions from Dykil and build survey column list
    const surveyColumns: string[] = [];
    const formFieldMap = new Map<string, Array<{ name: string; title: string; exportLabel?: string }>>();

    if (formIds.length > 0) {
      const formRows = await sql`
        SELECT id, fields FROM dykil.surveys WHERE id = ANY(${formIds})
      `;
      for (const row of formRows) {
        const rawFields = row.fields || {};
        let fields: Array<{ name: string; title?: string; exportLabel?: string }>;
        if (Array.isArray(rawFields)) {
          fields = rawFields;
        } else if (Array.isArray(rawFields.elements)) {
          fields = rawFields.elements;
        } else {
          fields = [];
        }
        const mappedFields = fields.map((f: any) => ({
          name: f.name,
          title: f.title || f.name,
          exportLabel: f.exportLabel,
        }));
        formFieldMap.set(row.id, mappedFields);
        for (const f of mappedFields) {
          const label = f.exportLabel || stripHtml(f.title);
          const colName = `Survey: ${label}`;
          if (!surveyColumns.includes(colName)) {
            surveyColumns.push(colName);
          }
        }
      }
    }

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
      const profile = t.owner_did ? (profileMap.get(t.owner_did) ?? null) : null;

      const surveyAnswers = t.survey_answers || {};
      const surveyName = surveyAnswers.full_name || surveyAnswers.name || null;
      const surveyEmail = surveyAnswers.email || null;

      const resolved = resolveAttendee({
        surveyName,
        surveyEmail,
        identityName: t.identity_name || null,
        identityContactEmail: t.contact_email || null,
        identityCredentialEmail: t.credential_email || null,
        profileName: profile?.name || null,
        profileEmail: profile?.email || null,
        buyerName: t.buyer_name || null,
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
      const surveyValues: string[] = [];
      if (t.survey_form_id && formFieldMap.has(t.survey_form_id)) {
        const fields = formFieldMap.get(t.survey_form_id)!;
        for (const colName of surveyColumns) {
          const question = colName.replaceAll('Survey: ', '');
          const field = fields.find((f) => (f.exportLabel || stripHtml(f.title)) === question);
          if (field && field.name in surveyAnswers) {
            const ans = surveyAnswers[field.name];
            surveyValues.push(ans === null || ans === undefined ? '' : String(ans));
          } else {
            surveyValues.push('');
          }
        }
      } else {
        for (const _ of surveyColumns) {
          surveyValues.push('');
        }
      }

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
