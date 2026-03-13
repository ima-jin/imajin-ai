import { NextRequest } from 'next/server';
import { eq, desc, and, gt, ne, inArray, sql } from 'drizzle-orm';
import { db, conversationsV2, messagesV2, conversationReadsV2 } from '@/db';
import { getClient } from '@imajin/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { parseConversationDid } from '@/lib/conversation-did';

const rawSql = getClient();

/**
 * GET /api/conversations-v2 - List DID-based conversations for authenticated user
 * Optional: ?did=<did> to fetch info for a specific conversation DID
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const url = new URL(request.url);
  const specificDid = url.searchParams.get('did');

  try {
    // Find all conversation DIDs this user participates in
    const [readRecords, sentMessages, createdConvs, podConvDids] = await Promise.all([
      db
        .select()
        .from(conversationReadsV2)
        .where(eq(conversationReadsV2.did, identity.id)),
      db
        .selectDistinct({ conversationDid: messagesV2.conversationDid })
        .from(messagesV2)
        .where(eq(messagesV2.fromDid, identity.id)),
      db
        .select({ did: conversationsV2.did })
        .from(conversationsV2)
        .where(eq(conversationsV2.createdBy, identity.id)),
      // Discover conversations via pod membership (connections layer)
      rawSql`
        SELECT p.conversation_did
        FROM connections.pods p
        JOIN connections.pod_members pm ON pm.pod_id = p.id
        WHERE pm.did = ${identity.id}
          AND pm.removed_at IS NULL
          AND p.conversation_did IS NOT NULL
      `,
    ]);

    const didSet = new Set<string>([
      ...readRecords.map(r => r.conversationDid),
      ...sentMessages.map(m => m.conversationDid),
      ...createdConvs.map(c => c.did),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...podConvDids.map((r: any) => r.conversation_did as string),
    ]);

    if (specificDid) {
      if (!didSet.has(specificDid)) {
        return errorResponse('Not found', 404);
      }
    }

    if (didSet.size === 0) {
      return jsonResponse({ conversations: [] });
    }

    const dids = specificDid ? [specificDid] : Array.from(didSet);

    const convs = await db
      .select()
      .from(conversationsV2)
      .where(inArray(conversationsV2.did, dids))
      .orderBy(desc(conversationsV2.lastMessageAt));

    const readMap = new Map(readRecords.map(r => [r.conversationDid, r.lastReadAt]));

    const result = await Promise.all(
      convs.map(async (conv) => {
        const parsed = parseConversationDid(conv.did);

        // Get last message preview
        const [lastMsg] = await db
          .select()
          .from(messagesV2)
          .where(eq(messagesV2.conversationDid, conv.did))
          .orderBy(desc(messagesV2.createdAt))
          .limit(1);

        // Get unread count (messages from others after lastReadAt)
        const lastReadAt = readMap.get(conv.did);
        let unread = 0;
        if (lastReadAt) {
          const [row] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(messagesV2)
            .where(
              and(
                eq(messagesV2.conversationDid, conv.did),
                gt(messagesV2.createdAt, lastReadAt),
                ne(messagesV2.fromDid, identity.id),
              )
            );
          unread = row?.count ?? 0;
        } else {
          // Never read — count all messages not from self
          const [row] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(messagesV2)
            .where(
              and(
                eq(messagesV2.conversationDid, conv.did),
                ne(messagesV2.fromDid, identity.id),
              )
            );
          unread = row?.count ?? 0;
        }

        let lastMessagePreview = '';
        if (lastMsg) {
          const c = lastMsg.content as Record<string, unknown>;
          if (c?.text && typeof c.text === 'string') {
            lastMessagePreview = c.text.slice(0, 100);
          } else if (c?.type === 'media') {
            lastMessagePreview = '[Media]';
          } else if (c?.type === 'voice') {
            lastMessagePreview = '[Voice message]';
          } else if (c?.type === 'location') {
            lastMessagePreview = '[Location]';
          }
        }

        return {
          did: conv.did,
          name: conv.name,
          type: parsed.type,
          slug: parsed.slug,
          createdBy: conv.createdBy,
          createdAt: conv.createdAt,
          lastMessageAt: conv.lastMessageAt,
          lastMessagePreview,
          unread,
        };
      })
    );

    return jsonResponse({ conversations: result });
  } catch (error) {
    console.error('Failed to list v2 conversations:', error);
    return errorResponse('Failed to list conversations', 500);
  }
}

/**
 * PATCH /api/conversations-v2 - Update a conversation's name
 * Body: { did, name }
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const { did, name } = await request.json();
    if (!did || !name) {
      return errorResponse('did and name are required', 400);
    }

    const conv = await db.query.conversationsV2.findFirst({
      where: eq(conversationsV2.did, did),
    });

    if (!conv) {
      // Conversation doesn't exist yet (auto-created on first message) — create it now
      await db.insert(conversationsV2).values({
        did,
        name,
        createdBy: identity.id,
      }).onConflictDoNothing();
    } else {
      if (conv.createdBy !== identity.id) {
        return errorResponse('Only the creator can update the name', 403);
      }

      await db
        .update(conversationsV2)
        .set({ name, updatedAt: new Date() })
        .where(eq(conversationsV2.did, did));
    }

    return jsonResponse({ ok: true });
  } catch (error) {
    console.error('Failed to update conversation:', error);
    return errorResponse('Failed to update conversation', 500);
  }
}
