import { withLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { eq, desc, and, inArray } from 'drizzle-orm';
import { db, conversationsV2, messagesV2, conversationReadsV2 } from '@/src/db';
import { getClient } from '@imajin/db';
import { requireAuth, resolveEffectiveDid, resolveActingDid } from '@imajin/auth';
import { requireGraphMember } from '@/src/lib/kernel/require-graph-member';
import { jsonResponse, errorResponse, isValidDid } from '@/src/lib/kernel/utils';
import { dmDid, parseConversationDid } from '@/src/lib/chat/conversation-did';
import {
  countUnread,
  extractMessagePreview,
  resolveDmParticipant,
} from '@/src/lib/chat/conversation-helpers';

const rawSql = getClient();

/**
 * GET /api/conversations - List v2 conversations for authenticated user
 * Returns conversations the user participates in, with DM enrichment.
 */
export const GET = withLogger('kernel', async (request, { log }) => {
  const auth = await resolveEffectiveDid(request, { scope: 'messages:read' });
  if (!auth.ok) {
    return errorResponse(auth.error, auth.status);
  }
  const effectiveDid = auth.effectiveDid;

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

        const lastReadAt = readMap.get(conv.did);
        const unread = await countUnread(conv.did, effectiveDid, lastReadAt);
        const lastMessagePreview = extractMessagePreview(lastMsg);
        const otherParticipant = await resolveDmParticipant(conv, effectiveDid, rawSql);

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
    log.error({ err: String(error) }, 'Failed to list conversations');
    return errorResponse('Failed to list conversations', 500);
  }
});

/**
 * POST /api/conversations - Create a new v2 conversation
 */
export const POST = withLogger('kernel', async (request, { log, correlationId }) => {
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
    const effectiveDid = resolveActingDid(identity);

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

      publish('conversation.create', { issuer: effectiveDid, subject: effectiveDid, scope: 'chat', payload: { conversationDid: convDid, type: 'direct' }, correlationId }).catch(() => {});

      return jsonResponse({ conversation: conv }, 201);
    }

    // Group conversation
    if (!name) {
      return errorResponse('Group conversations require a name');
    }

    const allMembers = [...new Set([effectiveDid, ...participantDids])];

    // Random group DID — group identity is the room, not the members
    const groupId = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
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

    publish('conversation.create', { issuer: effectiveDid, subject: effectiveDid, scope: 'chat', payload: { conversationDid: convDid, type: 'group', name }, correlationId }).catch(() => {});

    return jsonResponse({ conversation: conv }, 201);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to create conversation');
    return errorResponse('Failed to create conversation', 500);
  }
});
