import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { eq, and, desc, lt, isNull, inArray } from 'drizzle-orm';

const log = createLogger('kernel');
import { db, conversationsV2, messagesV2, messageReactionsV2 } from '@/src/db';
import { requireAuth, requireAppAuth, isVerifiedTier } from '@imajin/auth';
import { lookupIdentity } from '@/src/lib/kernel/lookup';
import { jsonResponse, errorResponse, generateId } from '@/src/lib/kernel/utils';
import { parseConversationDid } from '@/src/lib/chat/conversation-did';
import { hasCapability, requiredCapability, CAPABILITY_MESSAGES } from '@/src/lib/chat/capabilities';
import { checkAccess } from '@/src/lib/kernel/access';
import { processMentions } from '@/src/lib/chat/mentions';

/**
 * GET /api/conversations/:id/messages
 * :id is a URL-encoded conversation DID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let requesterDid: string;

  // App auth path
  if (request.headers.get('x-app-did')) {
    const appResult = await requireAppAuth(request, { scope: 'messages:read' });
    if ('error' in appResult) {
      return errorResponse(appResult.error, appResult.status);
    }
    requesterDid = appResult.appAuth.userDid;
  } else {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return errorResponse(authResult.error, authResult.status);
    }
    requesterDid = authResult.identity.actingAs || authResult.identity.id;
  }

  const { id } = await params;
  const conversationDid = decodeURIComponent(id);

  const access = await checkAccess(requesterDid, conversationDid);
  if (!access.allowed) {
    return errorResponse('Conversation not found or access denied', 404);
  }

  const url = new URL(request.url);
  const limit = Math.min(Number.parseInt(url.searchParams.get('limit') || '50'), 100);
  const before = url.searchParams.get('before');

  try {
    let query = db
      .select()
      .from(messagesV2)
      .where(
        and(
          eq(messagesV2.conversationDid, conversationDid),
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
              eq(messagesV2.conversationDid, conversationDid),
              isNull(messagesV2.deletedAt),
              lt(messagesV2.createdAt, cursorMessage.createdAt)
            )
          )
          .orderBy(desc(messagesV2.createdAt))
          .limit(limit);
      }
    }

    const result = await query;

    // Fetch reactions
    const messageIds = result.map(m => m.id);
    const reactions = messageIds.length > 0
      ? await db
          .select()
          .from(messageReactionsV2)
          .where(inArray(messageReactionsV2.messageId, messageIds))
      : [];

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
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to get messages');
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
  let effectiveDid: string;
  let identity: { id: string; tier?: string; handle?: string | null };

  // App auth path
  if (request.headers.get('x-app-did')) {
    const appResult = await requireAppAuth(request, { scope: 'messages:write' });
    if ('error' in appResult) {
      return errorResponse(appResult.error, appResult.status);
    }
    effectiveDid = appResult.appAuth.userDid;
    const lookedUp = await lookupIdentity(effectiveDid);
    identity = {
      id: effectiveDid,
      tier: lookedUp?.tier ?? 'preliminary',
      handle: lookedUp?.handle ?? null,
    };
  } else {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return errorResponse(authResult.error, authResult.status);
    }
    identity = authResult.identity;
    effectiveDid = identity.actingAs || identity.id;
  }
  const { id } = await params;
  const conversationDid = decodeURIComponent(id);

  // Soft DIDs cannot send messages
  if (!isVerifiedTier(identity.tier)) {
    return errorResponse('Please verify your account to send messages', 403);
  }

  const access = await checkAccess(effectiveDid, conversationDid);
  if (!access.allowed) {
    return errorResponse('Conversation not found or access denied', 404);
  }

  try {
    const body = await request.json();
    const { content, replyToMessageId, mediaType, mediaPath, mediaAssetId, mediaMeta, conversationName } = body;

    const earlyContentType = body.contentType || content?.type || 'text';
    const required = requiredCapability(earlyContentType);
    const tier = identity.tier ?? 'preliminary';
    if (!hasCapability({ tier }, required)) {
      return Response.json(
        { error: CAPABILITY_MESSAGES[required], code: 'CAPABILITY_DENIED', required },
        { status: 403 }
      );
    }

    if (!content || typeof content !== 'object') {
      return errorResponse('content is required and must be an object');
    }

    const contentType = body.contentType || content.type || 'text';
    const validContentTypes = ['text', 'system', 'media', 'voice', 'location'];
    if (!validContentTypes.includes(contentType)) {
      return errorResponse(`Invalid contentType: ${contentType}`);
    }

    // Auto-create conversation if it doesn't exist
    const existing = await db.query.conversationsV2.findFirst({
      where: eq(conversationsV2.did, conversationDid),
    });

    if (!existing) {
      const parsed = parseConversationDid(conversationDid);
      const name = conversationName || (parsed.type === 'unknown'  ? conversationDid : `${parsed.type}:${parsed.slug ?? ''}`);
      await db.insert(conversationsV2).values({
        did: conversationDid,
        name,
        createdBy: effectiveDid,
      }).onConflictDoNothing();
    }

    // Validate reply if provided
    if (replyToMessageId) {
      const replyMessage = await db.query.messagesV2.findFirst({
        where: and(
          eq(messagesV2.id, replyToMessageId),
          eq(messagesV2.conversationDid, conversationDid)
        ),
      });
      if (!replyMessage) {
        return errorResponse('Reply message not found', 404);
      }
    }

    const messageId = generateId('msg');

    await db.insert(messagesV2).values({
      id: messageId,
      conversationDid,
      fromDid: effectiveDid,
      content,
      contentType,
      replyToMessageId: replyToMessageId || null,
      mediaType: mediaType || null,
      mediaPath: mediaPath || null,
        mediaAssetId: mediaAssetId || null,
      mediaMeta: mediaMeta || null,
    });

    await db
      .update(conversationsV2)
      .set({ lastMessageAt: new Date(), updatedAt: new Date() })
      .where(eq(conversationsV2.did, conversationDid));

    const message = await db.query.messagesV2.findFirst({
      where: eq(messagesV2.id, messageId),
    });

    publish('message.send', { issuer: effectiveDid, subject: effectiveDid, scope: 'chat', payload: { conversationDid, messageId } }).catch(() => {});

    // Broadcast via WebSocket
    if (message) {
      const port = process.env.PORT || '3007';
      fetch(`http://localhost:${port}/__ws_broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: conversationDid, message }),
      }).catch(() => {});
    }

    // Detect and notify @mentions — fire and forget
    processMentions({
      conversationDid,
      messageId,
      senderDid: effectiveDid,
      senderName: identity.handle || identity.id.slice(0, 16),
      content,
    });

    return jsonResponse({ message }, 201);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to send message');
    return errorResponse('Failed to send message', 500);
  }
}
