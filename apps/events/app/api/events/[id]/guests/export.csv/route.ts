import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { requireAuth } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { getClient } from '@imajin/db';

const log = createLogger('events');
const sql = getClient();
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
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

/**
 * GET /api/events/[id]/guests/export.csv — export guest list as CSV
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
  const did = identity.actingAs || identity.id;
  const { id } = await params;

  try {
    const orgCheck = await isEventOrganizer(id, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Fetch event for filename
    const [event] = await sql`
      SELECT id, title FROM events.events WHERE id = ${id} LIMIT 1
    `;
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Fetch tickets with all needed info
    const ticketRows = await sql`
      SELECT
        t.id, t.status, t.owner_did, t.price_paid, t.currency, t.purchased_at, t.used_at,
        t.payment_method, t.order_id, t.registration_status,
        tt.name AS ticket_type, tt.registration_form_id,
        tr.name AS attendee_name, tr.email AS attendee_email, tr.form_id, tr.response_id
      FROM events.tickets t
      JOIN events.ticket_types tt ON t.ticket_type_id = tt.id
      LEFT JOIN events.ticket_registrations tr ON tr.ticket_id = t.id
      WHERE t.event_id = ${id}
      ORDER BY t.created_at DESC
    `;

    // Batch-resolve unique DIDs for profile info
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
    const formFieldMap = new Map<string, Array<{ name: string; title: string }>>();

    if (formIds.length > 0) {
      const formRows = await sql`
        SELECT id, fields FROM dykil.surveys WHERE id = ANY(${formIds})
      `;
      for (const row of formRows) {
        const rawFields = row.fields || {};
        const fields: Array<{ name: string; title?: string }> =
          Array.isArray(rawFields) ? rawFields :
          Array.isArray(rawFields.elements) ? rawFields.elements : [];
        const mappedFields = fields.map((f) => ({ name: f.name, title: f.title || f.name }));
        formFieldMap.set(row.id, mappedFields);
        for (const f of mappedFields) {
          const colName = `Survey: ${f.title}`;
          if (!surveyColumns.includes(colName)) {
            surveyColumns.push(colName);
          }
        }
      }
    }

    // Fetch all survey responses for tickets that have them
    const responseIds = [...new Set(ticketRows.map((t: any) => t.response_id).filter(Boolean))] as string[];
    const responseMap = new Map<string, Record<string, unknown>>();

    if (responseIds.length > 0) {
      const responseRows = await sql`
        SELECT id, answers FROM dykil.survey_responses WHERE id = ANY(${responseIds})
      `;
      for (const row of responseRows) {
        responseMap.set(row.id, row.answers || {});
      }
    }

    // Build CSV
    const dateStr = new Date().toISOString().split('T')[0];
    const safeTitle = event.title
      ? event.title.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
      : event.id;
    const filename = `${safeTitle || event.id}-guests-${dateStr}.csv`;

    const baseHeaders = [
      'Ticket ID', 'Order ID', 'Attendee Name', 'Attendee Email', 'Ticket Type',
      'Status', 'Registration Status', 'Purchased At', 'Checked In At',
      'Payment Method', 'Price Paid (cents)', 'Currency', 'Owner DID',
    ];
    const headers = [...baseHeaders, ...surveyColumns];

    let csvBody = csvRow(headers);

    for (const t of ticketRows) {
      const profile = t.owner_did ? (profileMap.get(t.owner_did) ?? null) : null;
      const attendeeName = t.attendee_name || profile?.name || '';
      const attendeeEmail = t.attendee_email || profile?.email || '';

      const baseValues = [
        t.id,
        t.order_id || '',
        attendeeName,
        attendeeEmail,
        t.ticket_type,
        t.status,
        t.registration_status || '',
        t.purchased_at ? new Date(t.purchased_at).toISOString() : '',
        t.used_at ? new Date(t.used_at).toISOString() : '',
        t.payment_method || '',
        t.price_paid ?? '',
        t.currency || '',
        t.owner_did || '',
      ];

      // Survey answers
      const surveyValues: string[] = [];
      if (t.response_id && t.form_id && formFieldMap.has(t.form_id)) {
        const fields = formFieldMap.get(t.form_id)!;
        const answers = responseMap.get(t.response_id) || {};
        for (const colName of surveyColumns) {
          const question = colName.replace('Survey: ', '');
          const field = fields.find((f) => f.title === question);
          if (field && field.name in answers) {
            const ans = answers[field.name];
            surveyValues.push(ans === null || ans === undefined ? '' : String(ans));
          } else {
            surveyValues.push('');
          }
        }
      } else {
        surveyValues.push(...new Array(surveyColumns.length).fill(''));
      }

      csvBody += csvRow([...baseValues, ...surveyValues]);
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
