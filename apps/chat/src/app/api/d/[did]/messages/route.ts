import { NextRequest } from 'next/server';
import { eq, and, desc, lt, isNull, inArray } from 'drizzle-orm';
import { db, conversationsV2, messagesV2, messageReactionsV2 } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId, corsHeaders, corsOptions } from '@/lib/utils';
import { parseConversationDid } from '@/lib/conversation-did';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

async function verifyDidAccess(did: string, cookieHeader: string | null): Promise<boolean> {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/access/${encodeURIComponent(did)}`, {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * OPTIONS /api/d/:did/messages - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * GET /api/d/:did/messages - Paginated messages for a DID-keyed conversation
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { did } = await params;

  // Verify access
  const cookieHeader = request.headers.get('Cookie');
  const hasAccess = await verifyDidAccess(did, cookieHeader);
  if (!hasAccess) {
    return errorResponse('Access denied', 403, cors);
  }

  // Pagination
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const before = url.searchParams.get('before');

  try {
    let query = db
      .select()
      .from(messagesV2)
      .where(
        and(
          eq(messagesV2.conversationDid, did),
          isNull(messagesV2.deletedAt)
        )
      )
      .orderBy(desc(messagesV2.createdAt))
      .limit(limit);

    if (before) {
      const cursorMessage = await db.query.messagesV2.findFirst({
        where: eq(messagesV2.id, before),
      });
      if (cursorMessage?.createdAt) {
        query = db
          .select()
          .from(messagesV2)
          .where(
            and(
              eq(messagesV2.conversationDid, did),
              isNull(messagesV2.deletedAt),
              lt(messagesV2.createdAt, cursorMessage.createdAt)
            )
          )
          .orderBy(desc(messagesV2.createdAt))
          .limit(limit);
      }
    }

    const result = await query;

    // Fetch reactions for these messages
    const messageIds = result.map(m => m.id);
    const reactions = messageIds.length > 0
      ? await db
          .select()
          .from(messageReactionsV2)
          .where(inArray(messageReactionsV2.messageId, messageIds))
      : [];

    // Group reactions by messageId
    const reactionsByMessage = reactions.reduce<Record<string, typeof reactions>>((acc, r) => {
      if (!acc[r.messageId]) acc[r.messageId] = [];
      acc[r.messageId].push(r);
      return acc;
    }, {});

    const messagesWithReactions = result.reverse().map(m => ({
      ...m,
      reactions: reactionsByMessage[m.id] || [],
    }));

    return jsonResponse({
      messages: messagesWithReactions,
      hasMore: result.length === limit,
    }, 200, cors);
  } catch (error) {
    console.error('Failed to get messages:', error);
    return errorResponse('Failed to get messages', 500, cors);
  }
}

/**
 * POST /api/d/:did/messages - Send a message to a DID-keyed conversation
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { identity } = authResult;
  const { did } = await params;

  // Soft DIDs cannot send messages — they must verify their account first
  if (identity.tier === 'soft') {
    return errorResponse('Please verify your account to send messages', 403, cors);
  }

  // Verify access
  const cookieHeader = request.headers.get('Cookie');
  const hasAccess = await verifyDidAccess(did, cookieHeader);
  if (!hasAccess) {
    return errorResponse('Access denied', 403, cors);
  }

  try {
    const body = await request.json();
    const { content, replyToMessageId, mediaType, mediaPath, mediaMeta, conversationName } = body;

    if (!content || typeof content !== 'object') {
      return errorResponse('content is required and must be an object', 400, cors);
    }

    const contentType = body.contentType || content.type || 'text';
    const validContentTypes = ['text', 'system', 'media', 'voice', 'location'];
    if (!validContentTypes.includes(contentType)) {
      return errorResponse(`Invalid contentType: ${contentType}`, 400, cors);
    }

    // Auto-create conversation if it doesn't exist
    const existing = await db.query.conversationsV2.findFirst({
      where: eq(conversationsV2.did, did),
    });

    if (!existing) {
      const parsed = parseConversationDid(did);
      let name = conversationName || null;
      // For event conversations, resolve the event title from events service
      if (!name && parsed.type === 'event') {
        try {
          const eventsUrl = process.env.EVENTS_SERVICE_URL || 'http://localhost:3006';
          const evtRes = await fetch(`${eventsUrl}/api/events/by-did/${encodeURIComponent(did)}`);
          if (evtRes.ok) {
            const evtData = await evtRes.json();
            name = evtData.event?.title ? `${evtData.event.title} Lobby` : null;
          }
        } catch {}
      }
      // Fallback for non-event types: use type:slug
      if (!name && parsed.type !== 'unknown' && parsed.type !== 'event') {
        name = `${parsed.type}:${parsed.slug ?? ''}`;
      }
      await db.insert(conversationsV2).values({
        did,
        name: name || did,
        createdBy: identity.id,
      }).onConflictDoNothing();
    }

    // Validate reply if provided
    if (replyToMessageId) {
      const replyMessage = await db.query.messagesV2.findFirst({
        where: and(
          eq(messagesV2.id, replyToMessageId),
          eq(messagesV2.conversationDid, did)
        ),
      });
      if (!replyMessage) {
        return errorResponse('Reply message not found', 404, cors);
      }
    }

    const messageId = generateId('msg');

    await db.insert(messagesV2).values({
      id: messageId,
      conversationDid: did,
      fromDid: identity.id,
      content,
      contentType,
      replyToMessageId: replyToMessageId || null,
      mediaType: mediaType || null,
      mediaPath: mediaPath || null,
      mediaMeta: mediaMeta || null,
    });

    // Update lastMessageAt
    await db
      .update(conversationsV2)
      .set({ lastMessageAt: new Date(), updatedAt: new Date() })
      .where(eq(conversationsV2.did, did));

    const message = await db.query.messagesV2.findFirst({
      where: eq(messagesV2.id, messageId),
    });

    // Broadcast via WebSocket
    if (message) {
      const port = process.env.PORT || '3007';
      fetch(`http://localhost:${port}/__ws_broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: did, message }),
      }).catch(() => {});
    }

    return jsonResponse({ message }, 201, cors);
  } catch (error) {
    console.error('Failed to send message:', error);
    return errorResponse('Failed to send message', 500, cors);
  }
}
