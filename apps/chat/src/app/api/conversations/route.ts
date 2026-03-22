import { NextRequest } from 'next/server';
import { eq, desc, and, gt, ne, inArray, sql } from 'drizzle-orm';
import { db, conversationsV2, messagesV2, conversationReadsV2 } from '@/db';
import { getClient } from '@imajin/db';
import { requireAuth, requireGraphMember } from '@/lib/auth';
import { jsonResponse, errorResponse, isValidDid } from '@/lib/utils';
import { dmDid, groupDid, parseConversationDid } from '@/lib/conversation-did';

const rawSql = getClient();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

/**
 * GET /api/conversations - List v2 conversations for authenticated user
 * Returns conversations the user participates in, with DM enrichment.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    // Discover all conversation DIDs this user participates in (same logic as conversations-v2)
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
      ...podConvDids.map((r: Record<string, string>) => r.conversation_did),
    ]);

    if (didSet.size === 0) {
      return jsonResponse({ conversations: [] });
    }

    const convs = await db
      .select()
      .from(conversationsV2)
      .where(inArray(conversationsV2.did, Array.from(didSet)))
      .orderBy(desc(conversationsV2.lastMessageAt));

    const readMap = new Map(readRecords.map(r => [r.conversationDid, r.lastReadAt]));

    const result = await Promise.all(
      convs.map(async (conv) => {
        const parsed = parseConversationDid(conv.did);

        // Last message preview
        const [lastMsg] = await db
          .select()
          .from(messagesV2)
          .where(eq(messagesV2.conversationDid, conv.did))
          .orderBy(desc(messagesV2.createdAt))
          .limit(1);

        // Unread count
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

        // For DMs, resolve other participant info by parsing the DID slug
        let otherParticipant: { did: string; handle: string | null; name: string | null } | null = null;
        if (parsed.type === 'dm' && AUTH_SERVICE_URL) {
          // DM DIDs don't embed participant DIDs — look up from sent messages or reads
          // to find the other party
          const [otherMsg] = await db
            .select({ fromDid: messagesV2.fromDid })
            .from(messagesV2)
            .where(
              and(
                eq(messagesV2.conversationDid, conv.did),
                ne(messagesV2.fromDid, identity.id),
              )
            )
            .limit(1);

          const otherDid = otherMsg?.fromDid;
          if (otherDid) {
            try {
              const lookupRes = await fetch(`${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(otherDid)}`);
              if (lookupRes.ok) {
                const data = await lookupRes.json();
                const ident = data.identity || data;
                otherParticipant = {
                  did: otherDid,
                  handle: ident.handle || null,
                  name: ident.name || null,
                };
              }
            } catch {
              // ignore lookup failures
            }
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
          otherParticipant,
        };
      })
    );

    return jsonResponse({ conversations: result });
  } catch (error) {
    console.error('Failed to list conversations:', error);
    return errorResponse('Failed to list conversations', 500);
  }
}

/**
 * POST /api/conversations - Create a new v2 conversation
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type, name, participantDids } = body;

    if (!type || !['direct', 'group'].includes(type)) {
      return errorResponse('type must be "direct" or "group"');
    }

    let authResult;
    if (type === 'direct') {
      authResult = await requireGraphMember(request);
    } else {
      authResult = await requireAuth(request);
    }

    if ('error' in authResult) {
      return errorResponse(authResult.error, authResult.status);
    }

    const { identity } = authResult;

    if (!participantDids || !Array.isArray(participantDids) || participantDids.length === 0) {
      return errorResponse('participantDids is required');
    }

    for (const did of participantDids) {
      if (!isValidDid(did)) {
        return errorResponse(`Invalid DID: ${did}`);
      }
    }

    if (type === 'direct') {
      if (participantDids.length !== 1) {
        return errorResponse('Direct conversations must have exactly one other participant');
      }

      const otherDid = participantDids[0];
      const convDid = dmDid(identity.id, otherDid);

      const existing = await db.query.conversationsV2.findFirst({
        where: eq(conversationsV2.did, convDid),
      });

      if (existing) {
        return jsonResponse({ conversation: existing, existing: true });
      }

      await db.insert(conversationsV2).values({
        did: convDid,
        createdBy: identity.id,
      }).onConflictDoNothing();

      const conv = await db.query.conversationsV2.findFirst({
        where: eq(conversationsV2.did, convDid),
      });

      return jsonResponse({ conversation: conv }, 201);
    }

    // Group conversation
    if (!name) {
      return errorResponse('Group conversations require a name');
    }

    const allMembers = [...new Set([identity.id, ...participantDids])];
    const convDid = groupDid(allMembers);

    const existing = await db.query.conversationsV2.findFirst({
      where: eq(conversationsV2.did, convDid),
    });

    if (existing) {
      return jsonResponse({ conversation: existing, existing: true });
    }

    await db.insert(conversationsV2).values({
      did: convDid,
      name,
      createdBy: identity.id,
    }).onConflictDoNothing();

    const conv = await db.query.conversationsV2.findFirst({
      where: eq(conversationsV2.did, convDid),
    });

    return jsonResponse({ conversation: conv }, 201);
  } catch (error) {
    console.error('Failed to create conversation:', error);
    return errorResponse('Failed to create conversation', 500);
  }
}
