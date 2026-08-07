import { withLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { eq } from 'drizzle-orm';
import { db, conversationsV2 } from '@/src/db';
import { getClient } from '@imajin/db';
import { requireAuth, resolveEffectiveDid, resolveActingDid } from '@imajin/auth';
import { requireGraphMember } from '@/src/lib/kernel/require-graph-member';
import { jsonResponse, errorResponse, isValidDid } from '@/src/lib/kernel/utils';
import { dmDid } from '@/src/lib/chat/conversation-did';
import { canInitiateDm, DM_CONNECTION_REQUIRED } from '@/src/lib/chat/connection-check';
import { listConversations } from '@/src/lib/chat/queries';

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
    const conversations = await listConversations(effectiveDid);
    return jsonResponse({ conversations });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to list conversations');
    return errorResponse('Failed to list conversations', 500);
  }
});

/**
 * Find or create the canonical DM conversation between `effectiveDid` and
 * `otherDid`. Opening a NEW thread requires an active connection, or that the
 * other party is an agent (#855).
 *
 * Cognitive complexity: 3 (≤ 15)
 */
async function createDirectConversation(
  effectiveDid: string,
  otherDid: string,
  correlationId?: string,
) {
  const convDid = dmDid(effectiveDid, otherDid);

  const existing = await db.query.conversationsV2.findFirst({
    where: eq(conversationsV2.did, convDid),
  });

  if (existing) {
    return jsonResponse({ conversation: existing, existing: true });
  }

  const allowed = await canInitiateDm(effectiveDid, otherDid);
  if (!allowed) {
    return errorResponse(DM_CONNECTION_REQUIRED, 403);
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

/**
 * POST /api/conversations - Create a new v2 conversation
 *
 * Cognitive complexity: 12 (≤ 15)
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

      return createDirectConversation(effectiveDid, participantDids[0], correlationId);
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
