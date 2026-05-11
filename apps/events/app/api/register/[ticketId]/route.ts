/**
 * POST /api/register/[ticketId]
 * GET  /api/register/[ticketId]
 *
 * Per-ticket registration API.
 * POST creates a registration for a pending ticket.
 * GET returns the existing registration for a ticket.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withLogger } from '@imajin/logger';
import { db, tickets } from '@/src/db';
import { eq } from 'drizzle-orm';
import { getClient } from '@imajin/db';

export const POST = withLogger('events', async (request, { log }) => {
  const ticketId = request.nextUrl.pathname.split('/').pop()!;

  log.info({ ticketId }, 'registration POST attempt');

  // Load ticket
  const [ticket] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);

  if (!ticket) {
    log.warn({ ticketId }, 'ticket not found');
    return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
  }

  log.info({ ticketId, currentStatus: ticket.registrationStatus }, 'ticket loaded');

  if (ticket.registrationStatus !== 'pending') {
    log.warn({ ticketId, status: ticket.registrationStatus }, 'ticket not pending (idempotent)');
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
    log.warn({ ticketId }, 'no survey response found for ticket');
    return NextResponse.json(
      { error: 'No survey response found for this ticket' },
      { status: 404 }
    );
  }

  await db
    .update(tickets)
    .set({ registrationStatus: 'complete' })
    .where(eq(tickets.id, ticket.id));

  log.info({ ticketId }, 'registration status updated to complete');

  return NextResponse.json({ success: true });
});

export const GET = withLogger('events', async (request) => {
  const ticketId = request.nextUrl.pathname.split('/').pop()!;

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
});
