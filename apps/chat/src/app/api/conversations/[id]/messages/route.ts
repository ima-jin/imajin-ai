import { NextRequest } from 'next/server';
import { eq, and, desc, lt, isNull, inArray } from 'drizzle-orm';
import { db, conversationsV2, messagesV2, messageReactionsV2 } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId } from '@/lib/utils';
import { parseConversationDid } from '@/lib/conversation-did';
import { hasCapability, requiredCapability, CAPABILITY_MESSAGES } from '@/lib/capabilities';
import { notify } from '@imajin/notify';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const PROFILE_SERVICE_URL = process.env.PROFILE_SERVICE_URL || 'http://localhost:3005';
const MENTION_REGEX = /@([a-zA-Z0-9_-]+)/g;

async function resolveHandleToDid(handle: string): Promise<string | null> {
  try {
    const res = await fetch(`${PROFILE_SERVICE_URL}/api/profile/search?q=${encodeURIComponent(handle)}&limit=5`);
    if (!res.ok) return null;
    const data = await res.json();
    const profile = (data.profiles || []).find((p: { handle?: string; did?: string }) => p.handle?.toLowerCase() === handle.toLowerCase());
    return profile?.did ?? null;
  } catch {
    return null;
  }
}

async function verifyAccess(did: string, cookieHeader: string | null): Promise<boolean> {
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
 * GET /api/conversations/:id/messages
 * :id is a URL-encoded conversation DID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { id } = await params;
  const conversationDid = decodeURIComponent(id);

  const hasAccess = await verifyAccess(conversationDid, request.headers.get('Cookie'));
  if (!hasAccess) {
    return errorResponse('Conversation not found or access denied', 404);
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
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
  const { id } = await params;
  const conversationDid = decodeURIComponent(id);

  // Soft DIDs cannot send messages
  if (identity.tier === 'soft') {
    return errorResponse('Please verify your account to send messages', 403);
  }

  const hasAccess = await verifyAccess(conversationDid, request.headers.get('Cookie'));
  if (!hasAccess) {
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
      const name = conversationName || (parsed.type !== 'unknown' ? `${parsed.type}:${parsed.slug ?? ''}` : conversationDid);
      await db.insert(conversationsV2).values({
        did: conversationDid,
        name,
        createdBy: identity.id,
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
      fromDid: identity.id,
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
    const messageText = typeof content === 'object' && (content as any).text ? (content as any).text : typeof content === 'string' ? content : '';
    const mentionMatches = [...messageText.matchAll(new RegExp(MENTION_REGEX))].map((m: RegExpMatchArray) => m[1]);
    if (mentionMatches.length > 0) {
      const uniqueHandles = [...new Set<string>(mentionMatches)];
      (async () => {
        for (const handle of uniqueHandles) {
          try {
            const mentionedDid = await resolveHandleToDid(handle);
            if (!mentionedDid || mentionedDid === identity.id) continue;
            notify.send({
              to: mentionedDid,
              scope: 'chat:mention',
              data: {
                conversationId: conversationDid,
                messageId,
                senderName: identity.handle || identity.id.slice(0, 16),
                messagePreview: messageText.slice(0, 100),
              },
            }).catch((err: unknown) => console.error('Mention notify error:', err));

            // Record interest signal — chat.mention → chat scope
            notify.interest({ did: mentionedDid, attestationType: 'chat.mention' })
              .catch((err: unknown) => console.error('Interest signal error:', err));
          } catch (err) {
            console.error('Handle resolution error:', err);
          }
        }
      })().catch(() => {});
    }

    return jsonResponse({ message }, 201);
  } catch (error) {
    console.error('Failed to send message:', error);
    return errorResponse('Failed to send message', 500);
  }
}
