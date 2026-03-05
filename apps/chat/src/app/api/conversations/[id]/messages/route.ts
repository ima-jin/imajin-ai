import { NextRequest } from 'next/server';
import { eq, and, desc, lt, isNull } from 'drizzle-orm';
import { db, conversations, participants, messages } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId } from '@/lib/utils';
import { unfurlLinks } from '@/lib/unfurl';
import { hasCapability, requiredCapability, CAPABILITY_MESSAGES } from '@/lib/capabilities';

/**
 * GET /api/conversations/:id/messages - Get messages in a conversation
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const { id: conversationId } = await params;
  
  // Pagination
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const before = url.searchParams.get('before'); // Message ID for pagination

  try {
    // Check if user is a participant
    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!participant) {
      return errorResponse('Conversation not found or access denied', 404);
    }

    // Build query
    let query = db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
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
              eq(messages.conversationId, conversationId),
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
    });
  } catch (error) {
    console.error('Failed to get messages:', error);
    return errorResponse('Failed to get messages', 500);
  }
}

/**
 * POST /api/conversations/:id/messages - Send a message
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const { id: conversationId } = await params;

  try {
    // Check if user is a participant with write access
    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!participant) {
      return errorResponse('Conversation not found or access denied', 404);
    }

    if (participant.role === 'readonly') {
      return errorResponse('You do not have permission to send messages', 403);
    }

    const body = await request.json();

    // Determine contentType early for capability check
    const earlyContentType = body.contentType || body.content?.type || 'text';
    const required = requiredCapability(earlyContentType);
    const tier = identity.tier ?? 'hard';
    if (!hasCapability({ tier }, required)) {
      return Response.json(
        { error: CAPABILITY_MESSAGES[required], code: 'CAPABILITY_DENIED', required },
        { status: 403 }
      );
    }
    const { content, replyTo, mediaType, mediaPath, mediaMeta } = body;

    // Validate content
    if (!content || typeof content !== 'object') {
      return errorResponse('content is required and must be an object');
    }

    // Determine contentType from body or infer from content shape
    const requestedType = body.contentType || content.type || 'text';
    const validContentTypes = ['text', 'system', 'invite', 'trust-extended', 'voice', 'media', 'location'];
    if (!validContentTypes.includes(requestedType)) {
      return errorResponse(`Invalid contentType: ${requestedType}`);
    }

    // Validate content shape for rich message types
    if (requestedType === 'voice') {
      if (!content.assetId || typeof content.transcript !== 'string' || typeof content.durationMs !== 'number') {
        return errorResponse('voice message requires assetId, transcript, and durationMs');
      }
    } else if (requestedType === 'media') {
      if (!content.assetId || !content.filename || !content.mimeType) {
        return errorResponse('media message requires assetId, filename, and mimeType');
      }
    } else if (requestedType === 'location') {
      if (typeof content.lat !== 'number' || typeof content.lng !== 'number') {
        return errorResponse('location message requires lat and lng');
      }
    }

    const contentType = requestedType;

    // If replying, verify the message exists in this conversation
    if (replyTo) {
      const replyMessage = await db.query.messages.findFirst({
        where: and(
          eq(messages.id, replyTo),
          eq(messages.conversationId, conversationId)
        ),
      });
      if (!replyMessage) {
        return errorResponse('Reply message not found', 404);
      }
    }

    // Unfurl links from message content (text and system messages only)
    let linkPreviews = null;
    if ((contentType === 'text' || contentType === 'system') && content.text) {
      const previews = await unfurlLinks(content.text);
      linkPreviews = previews.length > 0 ? previews : null;
    }

    // Create message
    const messageId = generateId('msg');

    await db.insert(messages).values({
      id: messageId,
      conversationId,
      fromDid: identity.id,
      content,
      contentType,
      replyTo: replyTo || null,
      linkPreviews,
      mediaType: mediaType || null,
      mediaPath: mediaPath || null,
      mediaMeta: mediaMeta || null,
    });

    // Update conversation's lastMessageAt
    await db
      .update(conversations)
      .set({ 
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));

    const message = await db.query.messages.findFirst({
      where: eq(messages.id, messageId),
    });

    // Broadcast via WebSocket (POST to custom server's broadcast endpoint)
    if (message) {
      const port = process.env.PORT || '3007';
      fetch(`http://localhost:${port}/__ws_broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, message }),
      }).catch(() => {});
    }

    return jsonResponse({ message }, 201);
  } catch (error) {
    console.error('Failed to send message:', error);
    return errorResponse('Failed to send message', 500);
  }
}
