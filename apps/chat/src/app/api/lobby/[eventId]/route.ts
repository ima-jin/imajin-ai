import { NextRequest } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, conversations, participants } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId } from '@/lib/utils';

const EVENTS_SERVICE_URL = process.env.EVENTS_SERVICE_URL || 'http://localhost:3005';

/**
 * GET /api/lobby/:eventId - Get or create lobby conversation for an event
 * Verifies ticket ownership via events service
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const { eventId } = await params;

  try {
    // Verify ticket ownership by calling events service
    const cookieHeader = request.headers.get('Cookie');
    const ticketRes = await fetch(
      `${EVENTS_SERVICE_URL}/api/events/${eventId}/my-ticket`,
      {
        headers: cookieHeader ? { Cookie: cookieHeader } : {},
      }
    );

    if (!ticketRes.ok) {
      return errorResponse('Failed to verify ticket ownership', 403);
    }

    const ticketData = await ticketRes.json();
    if (!ticketData.hasTicket) {
      return errorResponse('You need a ticket to access the event lobby', 403);
    }

    const lobbyConversationId = ticketData.lobbyConversationId;
    if (!lobbyConversationId) {
      return errorResponse('Event lobby not found', 404);
    }

    // Check if conversation exists
    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, lobbyConversationId),
    });

    if (!conversation) {
      return errorResponse('Lobby conversation not found', 404);
    }

    // Check if user is already a participant
    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, lobbyConversationId),
        eq(participants.did, identity.id)
      ),
    });

    // If not a participant, add them
    if (!participant) {
      await db.insert(participants).values({
        conversationId: lobbyConversationId,
        did: identity.id,
        role: 'member',
        invitedBy: null,
      });
    }

    return jsonResponse({
      conversationId: lobbyConversationId,
      conversation,
    });
  } catch (error) {
    console.error('Failed to get lobby conversation:', error);
    return errorResponse('Failed to get lobby conversation', 500);
  }
}
