import { NextRequest } from 'next/server';
import { eq, desc, and, gt, ne, inArray, sql } from 'drizzle-orm';
import { db, conversationsV2, messagesV2, conversationReadsV2, conversationMembersV2 } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';
import { parseConversationDid } from '@/lib/conversation-did';

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
    const [readRecords, sentMessages, createdConvs, memberRecords] = await Promise.all([
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
      db
        .select({ conversationDid: conversationMembersV2.conversationDid })
        .from(conversationMembersV2)
        .where(eq(conversationMembersV2.did, identity.id)),
    ]);

    const didSet = new Set<string>([
      ...readRecords.map(r => r.conversationDid),
      ...sentMessages.map(m => m.conversationDid),
      ...createdConvs.map(c => c.did),
      ...memberRecords.map(m => m.conversationDid),
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
 * POST /api/conversations-v2 - Create a conversation and register members
 * Body: { did, name?, memberDids: string[] }
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const { did, name, memberDids } = await request.json();
    if (!did) {
      return errorResponse('did is required', 400);
    }
    if (!memberDids || !Array.isArray(memberDids) || memberDids.length === 0) {
      return errorResponse('memberDids is required', 400);
    }

    // Create conversation if it doesn't exist
    await db.insert(conversationsV2).values({
      did,
      name: name || null,
      createdBy: identity.id,
    }).onConflictDoNothing();

    // Register all members (including creator)
    const allMembers = new Set([identity.id, ...memberDids]);
    for (const memberDid of allMembers) {
      await db.insert(conversationMembersV2).values({
        conversationDid: did,
        did: memberDid,
        role: memberDid === identity.id ? 'owner' : 'member',
        addedBy: identity.id,
      }).onConflictDoNothing();
    }

    return jsonResponse({ ok: true, did }, 201);
  } catch (error) {
    console.error('Failed to create conversation:', error);
    return errorResponse('Failed to create conversation', 500);
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
