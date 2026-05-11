/**
 * POST /api/register/[ticketId]
 * GET  /api/register/[ticketId]
 *
 * Per-ticket registration API.
 * POST creates a registration for a pending ticket.
 * GET returns the existing registration for a ticket.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { db, tickets } from '@/src/db';

const log = createLogger('events');
import { eq } from 'drizzle-orm';
import { getClient } from '@imajin/db';

export async function POST(
  request: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    const { ticketId } = params;

    // Load ticket
    const [ticket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    if (ticket.registrationStatus !== 'pending') {
      return NextResponse.json(
        { error: `Ticket registration status is '${ticket.registrationStatus}', expected 'pending'` },
        { status: 409 }
      );
    }

    // Verify Dykil survey response exists for this ticket
    const sql = getClient();
    const [surveyResponse] = await sql`
      SELECT id FROM dykil.survey_responses WHERE ticket_id = ${ticketId} LIMIT 1
    `;

    if (!surveyResponse) {
      return NextResponse.json(
        { error: 'No survey response found for this ticket' },
        { status: 404 }
      );
    }

    await db
      .update(tickets)
      .set({ registrationStatus: 'complete' })
      .where(eq(tickets.id, ticket.id));

    return NextResponse.json({ success: true });

  } catch (error) {
    log.error({ err: String(error) }, 'Registration error');
    return NextResponse.json(
      { error: 'Failed to complete registration' },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    const { ticketId } = params;

    const sql = getClient();
    const [response] = await sql`
      SELECT id, survey_id, answers, created_at
      FROM dykil.survey_responses
      WHERE ticket_id = ${ticketId}
      LIMIT 1
    `;

    if (!response) {
      return NextResponse.json({ error: 'Registration not found' }, { status: 404 });
    }

    // Backwards-compatible shape
    const registration = {
      id: response.id,
      ticketId,
      formId: response.survey_id,
      responseId: response.id,
      name: response.answers?.full_name || response.answers?.name || null,
      email: response.answers?.email || null,
      registeredAt: response.created_at,
    };

    return NextResponse.json({ registration });

  } catch (error) {
    log.error({ err: String(error) }, 'Registration lookup error');
    return NextResponse.json(
      { error: 'Failed to look up registration' },
      { status: 500 }
    );
  }
}
