import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { eq, and } from 'drizzle-orm';

const log = createLogger('events');
import { requireAuth } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { db, tickets } from '@/src/db';
import { getClient } from '@imajin/db';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; ticketId: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const did = identity.actingAs || identity.id;
  const { id: eventId, ticketId } = await params;

  try {
    const orgCheck = await isEventOrganizer(eventId, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const [ticket] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.eventId, eventId)))
      .limit(1);
    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    const sql = getClient();
    const rows = await sql`
      SELECT sr.id, sr.survey_id, sr.answers, s.fields
      FROM dykil.survey_responses sr
      JOIN dykil.surveys s ON s.id = sr.survey_id
      WHERE sr.ticket_id = ${ticketId}
      LIMIT 1
    `;

    if (rows.length === 0) {
      return NextResponse.json({ registration: null, questions: [] });
    }

    const row = rows[0];
    const registration = {
      id: row.id,
      ticketId,
      formId: row.survey_id,
      responseId: row.id,
      name: row.answers?.full_name || row.answers?.name || null,
      email: row.answers?.email || null,
    };

    let questions: Array<{ question: string; answer: unknown }> = [];

    // fields can be { elements: [...] } or directly an array
    const rawFields = row.fields || {};
    const fields: Array<{ name: string; title?: string }> =
      Array.isArray(rawFields) ? rawFields :
      Array.isArray(rawFields.elements) ? rawFields.elements : [];
    const answers: Record<string, unknown> = row.answers || {};

    questions = fields
      .filter((f) => f.name in answers)
      .map((f) => ({
        question: f.title || f.name,
        answer: answers[f.name],
      }));

    return NextResponse.json({ registration, questions });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch registration');
    return NextResponse.json({ error: 'Failed to fetch registration' }, { status: 500 });
  }
}
