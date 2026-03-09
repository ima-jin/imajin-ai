import { NextRequest } from 'next/server';
import { eq, and, desc, lt, isNull } from 'drizzle-orm';
import { db, conversations, participants, messages } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId, corsHeaders, corsOptions } from '@/lib/utils';

const EVENTS_SERVICE_URL = process.env.EVENTS_SERVICE_URL || 'http://localhost:3006';

/**
 * Verify ticket ownership for event lobby access
 */
async function verifyEventAccess(
  eventId: string,
  cookieHeader: string | null
): Promise<{ hasAccess: boolean; lobbyConversationId: string | null }> {
  try {
    const ticketRes = await fetch(
      `${EVENTS_SERVICE_URL}/api/events/${eventId}/my-ticket`,
      {
        headers: cookieHeader ? { Cookie: cookieHeader } : {},
      }
    );

    if (!ticketRes.ok) {
      return { hasAccess: false, lobbyConversationId: null };
    }

    const ticketData = await ticketRes.json();
    return {
      hasAccess: ticketData.hasAccess || ticketData.hasTicket || false,
      lobbyConversationId: ticketData.lobbyConversationId || null,
    };
  } catch (error) {
    console.error('Failed to verify event access:', error);
    return { hasAccess: false, lobbyConversationId: null };
  }
}

/**
 * OPTIONS /api/lobby/:eventId/messages - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /api/lobby/:eventId/messages - Get paginated messages from event lobby
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { identity } = authResult;
  const { eventId } = await params;

  // Pagination
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const before = url.searchParams.get('before'); // Message ID cursor

  try {
    // Verify event access (ticket holder OR organizer)
    const cookieHeader = request.headers.get('Cookie');
    const { hasAccess, lobbyConversationId } = await verifyEventAccess(
      eventId,
      cookieHeader
    );

    if (!hasAccess || !lobbyConversationId) {
      return errorResponse('You need a ticket to access the event lobby', 403, cors);
    }

    // Check if user is a participant
    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, lobbyConversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!participant) {
      // Auto-add them as a participant if they have access
      await db.insert(participants).values({
        conversationId: lobbyConversationId,
        did: identity.id,
        role: 'member',
        invitedBy: null,
      });
    }

    // Build query
    let query = db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, lobbyConversationId),
          isNull(messages.deletedAt)
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    // If paginating, get messages before the cursor
    if (before) {
      const cursorMessage = await db.query.messages.findFirst({
        where: eq(messages.id, before),
      });
      if (cursorMessage && cursorMessage.createdAt) {
        query = db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, lobbyConversationId),
              isNull(messages.deletedAt),
              lt(messages.createdAt, cursorMessage.createdAt)
            )
          )
          .orderBy(desc(messages.createdAt))
          .limit(limit);
      }
    }

    const result = await query;

    return jsonResponse({
      messages: result.reverse(), // Return in chronological order
      hasMore: result.length === limit,
    }, 200, cors);
  } catch (error) {
    console.error('Failed to get lobby messages:', error);
    return errorResponse('Failed to get lobby messages', 500, cors);
  }
}

/**
 * POST /api/lobby/:eventId/messages - Send a message to event lobby
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { identity } = authResult;
  const { eventId } = await params;

  try {
    // Verify event access (ticket holder OR organizer)
    const cookieHeader = request.headers.get('Cookie');
    const { hasAccess, lobbyConversationId } = await verifyEventAccess(
      eventId,
      cookieHeader
    );

    if (!hasAccess || !lobbyConversationId) {
      return errorResponse('You need a ticket to post in the event lobby', 403, cors);
    }

    // Check if user is a participant
    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, lobbyConversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!participant) {
      // Auto-add them as a participant if they have access
      await db.insert(participants).values({
        conversationId: lobbyConversationId,
        did: identity.id,
        role: 'member',
        invitedBy: null,
      });
    }

    const body = await request.json();
    const { content, replyTo } = body;

    // Validate content - for event lobby, messages are plaintext (no E2EE)
    if (!content || typeof content !== 'object') {
      return errorResponse('content is required and must be an object', 400, cors);
    }

    // Determine content type from the content object
    const contentType = content.type || 'text';
    const validTypes = ['text', 'voice', 'media', 'location'];
    if (!validTypes.includes(contentType)) {
      return errorResponse('Invalid content type', 400, cors);
    }

    // Text messages require text field
    if (contentType === 'text' && (!content.text || typeof content.text !== 'string')) {
      return errorResponse('content.text is required for text messages', 400, cors);
    }

    // If replying, verify the message exists in this conversation
    if (replyTo) {
      const replyMessage = await db.query.messages.findFirst({
        where: and(
          eq(messages.id, replyTo),
          eq(messages.conversationId, lobbyConversationId)
        ),
      });
      if (!replyMessage) {
        return errorResponse('Reply message not found', 404, cors);
      }
    }

    // Create message
    const messageId = generateId('msg');

    await db.insert(messages).values({
      id: messageId,
      conversationId: lobbyConversationId,
      fromDid: identity.id,
      content,
      contentType,
      replyTo: replyTo || null,
    });

    // Update conversation's lastMessageAt
    await db
      .update(conversations)
      .set({
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, lobbyConversationId));

    const message = await db.query.messages.findFirst({
      where: eq(messages.id, messageId),
    });

    // Broadcast via WebSocket (POST to custom server's broadcast endpoint)
    if (message) {
      const port = process.env.PORT || '3007';
      fetch(`http://localhost:${port}/__ws_broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: lobbyConversationId, message }),
      }).catch(() => {});
    }

    return jsonResponse({ message }, 201, cors);
  } catch (error) {
    console.error('Failed to send lobby message:', error);
    return errorResponse('Failed to send lobby message', 500, cors);
  }
}
