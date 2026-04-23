import { NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { eq, and, desc, lt, ne, isNull, inArray, ilike, or } from 'drizzle-orm';

const log = createLogger('kernel');
import { db, conversationsV2, conversationMembers, messagesV2, messageReactionsV2, profiles } from '@/src/db';
import { requireAuth, isVerifiedTier } from '@imajin/auth';
import { jsonResponse, errorResponse, generateId } from '@/src/lib/kernel/utils';
import { corsOptions, corsHeaders } from "@/src/lib/kernel/cors";
import { parseConversationDid } from '@/src/lib/chat/conversation-did';
import { unfurlLinks } from '@/src/lib/chat/unfurl';
import { canonicalize } from '@imajin/auth';

import { checkAccess } from '@/src/lib/kernel/access';
import { crypto as authCrypto } from '@imajin/auth';
import { getChainByImajinDid } from '@/src/lib/auth/dfos';
import { verifyChain } from '@imajin/dfos';

const MENTION_REGEX = /@([a-zA-Z0-9_-]+)/g;

async function resolveHandleToDid(handle: string): Promise<string | null> {
  try {
    const result = await db
      .select({ did: profiles.did, handle: profiles.handle })
      .from(profiles)
      .where(ilike(profiles.handle, handle))
      .limit(1);
    const profile = result.find((p) => p.handle?.toLowerCase() === handle.toLowerCase());
    return profile?.did ?? null;
  } catch {
    return null;
  }
}

/**
 * Sign a message payload with the node's platform key.
 * Only signs for chain-verified identities. Best-effort: returns null on failure.
 */
async function signMessagePayload(fromDid: string, payload: string): Promise<string | null> {
  const privateKey = process.env.AUTH_PRIVATE_KEY;
  if (!privateKey) return null;

  try {
    const chain = await getChainByImajinDid(fromDid);
    if (!chain) return null;

    const verified = await verifyChain(chain.log as string[]);
    if (verified.isDeleted || verified.authKeys.length === 0) return null;

    const signature = authCrypto.signSync(payload, privateKey);
    return signature;
  } catch {
    return null;
  }
}

async function verifyDidAccess(requesterDid: string, targetDid: string): Promise<boolean> {
  const result = await checkAccess(requesterDid, targetDid);
  return result.allowed;
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
  const hasAccess = await verifyDidAccess(authResult.identity.actingAs || authResult.identity.id, did);
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
    log.error({ err: String(error) }, 'Failed to get messages');
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
  const effectiveDid = identity.actingAs || identity.id;
  const { did } = await params;

  // Soft DIDs cannot send messages — they must verify their account first
  if (!isVerifiedTier(identity.tier)) {
    return errorResponse('Please verify your account to send messages', 403, cors);
  }

  // Verify access
  const hasAccess = await verifyDidAccess(effectiveDid, did);
  if (!hasAccess) {
    return errorResponse('Access denied', 403, cors);
  }

  try {
    const body = await request.json();
    const { content, replyToMessageId, mediaType, mediaPath, mediaAssetId, mediaMeta, conversationName, recipientDid } = body;

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
        createdBy: effectiveDid,
      }).onConflictDoNothing();
    }

    // Always ensure the sender is a conversation member (idempotent).
    // Catches edge cases where the conversation exists but the sender isn't tracked.
    await db.insert(conversationMembers).values({
      conversationDid: did,
      memberDid: effectiveDid,
      role: 'member',
    }).onConflictDoNothing();

    // For DMs: ensure the recipient is also tracked as a member.
    // The DM DID is a hash so we can't reverse it — use recipientDid from the client
    // if provided, otherwise discover from existing conversation data.
    const isDm = parseConversationDid(did).type === 'dm';
    if (isDm) {
      let otherDid = recipientDid || null;
      if (!otherDid) {
        // Try conversation creator (if it's not us, they're the other party)
        const conv = existing || await db.query.conversationsV2.findFirst({
          where: eq(conversationsV2.did, did),
        });
        if (conv?.createdBy && conv.createdBy !== effectiveDid) {
          otherDid = conv.createdBy;
        }
      }
      if (!otherDid) {
        // Try existing messages from someone else
        const [otherMsg] = await db
          .select({ fromDid: messagesV2.fromDid })
          .from(messagesV2)
          .where(and(
            eq(messagesV2.conversationDid, did),
            ne(messagesV2.fromDid, effectiveDid),
          ))
          .limit(1);
        otherDid = otherMsg?.fromDid || null;
      }
      if (otherDid) {
        await db.insert(conversationMembers).values({
          conversationDid: did,
          memberDid: otherDid,
          role: 'member',
        }).onConflictDoNothing();
      }
    }

    // Validate reply if provided
    let replyToDid: string | null = null;
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
      replyToDid = replyMessage.fromDid;
    }

    const messageId = generateId('msg');
    const createdAt = new Date();

    // Sign if sender has chain identity — best-effort, never blocks delivery
    const signaturePayload = canonicalize({
      conversationDid: did,
      content,
      fromDid: effectiveDid,
      createdAt: createdAt.toISOString(),
    });
    const signature = await signMessagePayload(effectiveDid, signaturePayload);

    await db.insert(messagesV2).values({
      id: messageId,
      conversationDid: did,
      fromDid: effectiveDid,
      content,
      contentType,
      replyToDid: replyToDid,
      replyToMessageId: replyToMessageId || null,
      mediaType: mediaType || null,
      mediaPath: mediaPath || null,
        mediaAssetId: mediaAssetId || null,
      mediaMeta: mediaMeta || null,
      createdAt,
      signature,
    });

    // Update lastMessageAt
    await db
      .update(conversationsV2)
      .set({ lastMessageAt: new Date(), updatedAt: new Date() })
      .where(eq(conversationsV2.did, did));

    const message = await db.query.messagesV2.findFirst({
      where: eq(messagesV2.id, messageId),
    });

    publish('message.send', { issuer: effectiveDid, subject: effectiveDid, scope: 'chat', payload: { conversationDid: did, messageId } }).catch(() => {});

    // Broadcast via WebSocket
    if (message) {
      const port = process.env.PORT || '3007';
      fetch(`http://localhost:${port}/__ws_broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: did, message }),
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
            if (!mentionedDid || mentionedDid === effectiveDid) continue;
            publish('chat.mention', {
              issuer: effectiveDid,
              subject: mentionedDid,
              scope: 'chat',
              payload: {
                conversationId: did,
                messageId,
                senderName: identity.handle || identity.id.slice(0, 16),
                messagePreview: messageText.slice(0, 100),
                interestDids: [mentionedDid],
              },
            }).catch((err: unknown) => log.error({ err: String(err) }, 'Mention publish error'));
          } catch (err) {
            log.error({ err: String(err) }, 'Handle resolution error');
          }
        }
      })().catch(() => {});
    }

    // Unfurl link previews async — don't block the response
    if (message && contentType === 'text' && typeof content === 'string') {
      unfurlLinks(content).then(async (previews) => {
        if (previews.length === 0) return;
        await db
          .update(messagesV2)
          .set({ linkPreviews: previews })
          .where(eq(messagesV2.id, messageId));
        // Broadcast updated message with previews
        const port = process.env.PORT || '3007';
        fetch(`http://localhost:${port}/__ws_broadcast`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: did,
            type: 'message_updated',
            message: { ...message, linkPreviews: previews },
          }),
        }).catch(() => {});
      }).catch(() => {});
    }

    return jsonResponse({ message }, 201, cors);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to send message');
    return errorResponse('Failed to send message', 500, cors);
  }
}
