import { NextRequest } from 'next/server';
import { eq, desc, and, gt, ne, inArray, sql } from 'drizzle-orm';
import { db, conversationsV2, messagesV2, conversationReadsV2 } from '@/db';
import { getClient } from '@imajin/db';
import { requireAuth, requireGraphMember } from '@/lib/auth';
import { jsonResponse, errorResponse, isValidDid } from '@/lib/utils';
import { dmDid, parseConversationDid } from '@/lib/conversation-did';

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
  const effectiveDid = identity.actingAs || identity.id;

  try {
    // Discover all conversation DIDs this user participates in (same logic as conversations-v2)
    const [readRecords, sentMessages, createdConvs, podConvDids, memberConvDids] = await Promise.all([
      db
        .select()
        .from(conversationReadsV2)
        .where(eq(conversationReadsV2.did, effectiveDid)),
      db
        .selectDistinct({ conversationDid: messagesV2.conversationDid })
        .from(messagesV2)
        .where(eq(messagesV2.fromDid, effectiveDid)),
      db
        .select({ did: conversationsV2.did })
        .from(conversationsV2)
        .where(eq(conversationsV2.createdBy, effectiveDid)),
      rawSql`
        SELECT p.conversation_did
        FROM connections.pods p
        JOIN connections.pod_members pm ON pm.pod_id = p.id
        WHERE pm.did = ${effectiveDid}
          AND pm.removed_at IS NULL
          AND p.conversation_did IS NOT NULL
      `,
      rawSql`
        SELECT conversation_did
        FROM chat.conversation_members
        WHERE member_did = ${effectiveDid}
          AND left_at IS NULL
      `,
    ]);

    const didSet = new Set<string>([
      ...readRecords.map(r => r.conversationDid),
      ...sentMessages.map(m => m.conversationDid),
      ...createdConvs.map(c => c.did),
      ...podConvDids.map((r: Record<string, string>) => r.conversation_did),
      ...memberConvDids.map((r: Record<string, string>) => r.conversation_did),
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
                ne(messagesV2.fromDid, effectiveDid),
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
                ne(messagesV2.fromDid, effectiveDid),
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
          // DM DIDs don't embed participant DIDs — look up from messages and reads
          let otherDid: string | undefined;

          // 1. Check messages from the other party
          const [otherMsg] = await db
            .select({ fromDid: messagesV2.fromDid })
            .from(messagesV2)
            .where(
              and(
                eq(messagesV2.conversationDid, conv.did),
                ne(messagesV2.fromDid, effectiveDid),
              )
            )
            .limit(1);
          otherDid = otherMsg?.fromDid;

          // 2. If no messages from other party, check conversation reads
          if (!otherDid) {
            const [otherRead] = await db
              .select({ did: conversationReadsV2.did })
              .from(conversationReadsV2)
              .where(
                and(
                  eq(conversationReadsV2.conversationDid, conv.did),
                  ne(conversationReadsV2.did, effectiveDid),
                )
              )
              .limit(1);
            otherDid = otherRead?.did;
          }

          // 3. Check conversation_members table
          if (!otherDid) {
            const otherMembers = await rawSql`
              SELECT member_did FROM chat.conversation_members
              WHERE conversation_did = ${conv.did}
                AND member_did != ${effectiveDid}
              LIMIT 1
            `;
            if (otherMembers.length > 0) {
              otherDid = otherMembers[0].member_did as string;
            }
          }

          // 4. Fallback: created_by != me means I'm the other party
          if (!otherDid && conv.createdBy !== effectiveDid) {
            otherDid = conv.createdBy;
          }
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
    const effectiveDid = identity.actingAs || identity.id;

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
      const convDid = dmDid(effectiveDid, otherDid);

      const existing = await db.query.conversationsV2.findFirst({
        where: eq(conversationsV2.did, convDid),
      });

      if (existing) {
        return jsonResponse({ conversation: existing, existing: true });
      }

      await db.insert(conversationsV2).values({
        did: convDid,
        type: 'dm',
        createdBy: effectiveDid,
      }).onConflictDoNothing();

      // Track both parties so we can resolve names without reversing the hash
      await rawSql`
        INSERT INTO chat.conversation_members (conversation_did, member_did, role)
        VALUES (${convDid}, ${effectiveDid}, 'member'), (${convDid}, ${otherDid}, 'member')
        ON CONFLICT (conversation_did, member_did) DO NOTHING
      `;

      const conv = await db.query.conversationsV2.findFirst({
        where: eq(conversationsV2.did, convDid),
      });

      return jsonResponse({ conversation: conv }, 201);
    }

    // Group conversation
    if (!name) {
      return errorResponse('Group conversations require a name');
    }

    const allMembers = [...new Set([effectiveDid, ...participantDids])];

    // Random group DID — group identity is the room, not the members
    const groupId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const convDid = `did:imajin:group:${groupId}`;

    await db.insert(conversationsV2).values({
      did: convDid,
      type: 'group',
      name,
      createdBy: effectiveDid,
    }).onConflictDoNothing();

    // Insert members
    await rawSql`
      INSERT INTO chat.conversation_members (conversation_did, member_did, role)
      SELECT ${convDid}, unnest(${allMembers}::text[]),
        CASE WHEN unnest = ${effectiveDid} THEN 'owner' ELSE 'member' END
      ON CONFLICT (conversation_did, member_did) DO NOTHING
    `.catch(() => {
      // Fallback: insert one by one if unnest approach fails
      return Promise.all(allMembers.map(did =>
        rawSql`
          INSERT INTO chat.conversation_members (conversation_did, member_did, role)
          VALUES (${convDid}, ${did}, ${did === effectiveDid ? 'owner' : 'member'})
          ON CONFLICT (conversation_did, member_did) DO NOTHING
        `
      ));
    });

    const conv = await db.query.conversationsV2.findFirst({
      where: eq(conversationsV2.did, convDid),
    });

    return jsonResponse({ conversation: conv }, 201);
  } catch (error) {
    console.error('Failed to create conversation:', error);
    return errorResponse('Failed to create conversation', 500);
  }
}
