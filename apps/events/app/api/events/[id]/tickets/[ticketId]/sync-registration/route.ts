/**
 * POST /api/events/:id/tickets/:ticketId/sync-registration
 *
 * Idempotent backfill for orphan tickets: DB says pending, but Dykil has a response.
 * Queries the shared Postgres DB (dykil schema) directly.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { eq, and } from 'drizzle-orm';

const log = createLogger('events');
import { requireAuth } from '@imajin/auth';
import { isEventOrganizer } from '@/src/lib/organizer';
import { db, tickets, ticketTypes } from '@/src/db';
import { getClient } from '@imajin/db';

const sql = getClient();

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
  const { id: eventId, ticketId } = await params;

  try {
    // Load ticket with its type
    const [ticket] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.eventId, eventId)))
      .limit(1);

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    // Auth: ticket owner OR event organizer
    const orgCheck = await isEventOrganizer(eventId, did);
    if (ticket.ownerDid !== did && !orgCheck.authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Load ticket type to get registrationFormId
    const [type] = await db
      .select({ registrationFormId: ticketTypes.registrationFormId })
      .from(ticketTypes)
      .where(eq(ticketTypes.id, ticket.ticketTypeId))
      .limit(1);

    const surveyId = type?.registrationFormId;
    if (!surveyId) {
      return NextResponse.json({
        synced: false,
        reason: 'no_registration_form',
      });
    }

    // Already complete?
    if (ticket.registrationStatus === 'complete') {
      return NextResponse.json({
        synced: false,
        reason: 'already complete',
      });
    }

    // Query Dykil directly via shared DB
    const dykilRows = await sql`
      SELECT id, answers
      FROM dykil.survey_responses
      WHERE survey_id = ${surveyId} AND ticket_id = ${ticketId}
      LIMIT 1
    `;

    if (dykilRows.length === 0) {
      return NextResponse.json({
        synced: false,
        reason: 'no submission',
      });
    }

    const response = dykilRows[0];

    // Update ticket: mark complete and store survey answers in metadata
    const currentMeta = (ticket.metadata || {}) as Record<string, unknown>;
    await db
      .update(tickets)
      .set({
        registrationStatus: 'complete',
        metadata: {
          ...currentMeta,
          surveyAnswers: response.answers,
          surveyResponseId: response.id,
          syncedAt: new Date().toISOString(),
        },
      })
      .where(eq(tickets.id, ticket.id));

    return NextResponse.json({
      synced: true,
      responseId: response.id,
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to sync registration');
    return NextResponse.json(
      { error: 'Failed to sync registration' },
      { status: 500 }
    );
  }
}
