import { NextRequest } from 'next/server';
import { eq, desc, and, or } from 'drizzle-orm';
import { db, conversations, participants, messages } from '@/db';
import { getClient } from '@imajin/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId, isValidDid } from '@/lib/utils';

const sql = getClient();

/**
 * GET /api/conversations - List conversations for authenticated user
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    // Get all conversations where user is a participant
    const userConversations = await db
      .select({
        conversation: conversations,
        participant: participants,
      })
      .from(participants)
      .innerJoin(conversations, eq(participants.conversationId, conversations.id))
      .where(eq(participants.did, identity.id))
      .orderBy(desc(conversations.lastMessageAt));

    const convList = userConversations.map(({ conversation, participant }) => ({
      ...conversation,
      myRole: participant.role,
      muted: participant.muted,
      lastReadAt: participant.lastReadAt,
      otherParticipant: null as { did: string; handle: string | null; name: string | null } | null,
      podName: null as string | null,
      eventName: null as string | null,
      participantCount: 0,
    }));

    // Enrich conversations with additional data
    const authUrl = process.env.AUTH_SERVICE_URL!;
    for (const conv of convList) {
      // Get participant count for all conversations
      try {
        const allParts = await db
          .select()
          .from(participants)
          .where(eq(participants.conversationId, conv.id));
        conv.participantCount = allParts.length;

        // For direct conversations, resolve other participant
        if (conv.type === 'direct') {
          const other = allParts.find(p => p.did !== identity.id);
          if (other) {
            const lookupRes = await fetch(`${authUrl}/api/lookup/${encodeURIComponent(other.did)}`);
            if (lookupRes.ok) {
              const data = await lookupRes.json();
              const ident = data.identity || data;
              conv.otherParticipant = {
                did: other.did,
                handle: ident.handle || null,
                name: ident.name || null,
              };
            }
          }
        }

        // For group conversations with pod_id, fetch pod/event name
        if (conv.type === 'group' && conv.podId) {
          const eventRows = await sql`
            SELECT e.title FROM events e WHERE e.pod_id = ${conv.podId} LIMIT 1
          `;
          if (eventRows.length > 0) {
            conv.eventName = eventRows[0].title;
            if (!conv.name) {
              conv.name = `${eventRows[0].title} Chat`;
            }
          } else {
            const podRows = await sql`
              SELECT name FROM trust_pods WHERE id = ${conv.podId} LIMIT 1
            `;
            if (podRows.length > 0) {
              conv.podName = podRows[0].name;
            }
          }
        }
      } catch (err) {
        console.error('Error enriching conversation:', err);
      }
    }

    return jsonResponse({ conversations: convList });
  } catch (error) {
    console.error('Failed to list conversations:', error);
    return errorResponse('Failed to list conversations', 500);
  }
}

/**
 * POST /api/conversations - Create a new conversation
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const body = await request.json();
    const { type, name, description, participantDids, visibility = 'private' } = body;

    // Validate type
    if (!type || !['direct', 'group'].includes(type)) {
      return errorResponse('type must be "direct" or "group"');
    }

    // Validate participants
    if (!participantDids || !Array.isArray(participantDids) || participantDids.length === 0) {
      return errorResponse('participantDids is required');
    }

    for (const did of participantDids) {
      if (!isValidDid(did)) {
        return errorResponse(`Invalid DID: ${did}`);
      }
    }

    // For direct messages, ensure exactly one other participant
    if (type === 'direct') {
      if (participantDids.length !== 1) {
        return errorResponse('Direct conversations must have exactly one other participant');
      }
      
      // Check if direct conversation already exists
      const otherDid = participantDids[0];
      const existing = await db
        .select()
        .from(conversations)
        .innerJoin(participants, eq(participants.conversationId, conversations.id))
        .where(
          and(
            eq(conversations.type, 'direct'),
            or(
              eq(participants.did, identity.id),
              eq(participants.did, otherDid)
            )
          )
        );
      
      // Group by conversation and check if both users are in the same one
      const convCounts: Record<string, Set<string>> = {};
      for (const row of existing) {
        if (!convCounts[row.chat_conversations.id]) {
          convCounts[row.chat_conversations.id] = new Set();
        }
        convCounts[row.chat_conversations.id].add(row.chat_participants.did);
      }
      
      for (const [convId, dids] of Object.entries(convCounts)) {
        if (dids.has(identity.id) && dids.has(otherDid)) {
          // Return existing conversation
          const conv = await db.query.conversations.findFirst({
            where: eq(conversations.id, convId),
          });
          return jsonResponse({ conversation: conv, existing: true });
        }
      }
    }

    // Groups need a name
    if (type === 'group' && !name) {
      return errorResponse('Group conversations require a name');
    }

    // Create conversation
    const conversationId = generateId('conv');
    
    await db.insert(conversations).values({
      id: conversationId,
      type,
      name: name || null,
      description: description || null,
      visibility,
      createdBy: identity.id,
    });

    // Add creator as owner
    await db.insert(participants).values({
      conversationId,
      did: identity.id,
      role: 'owner',
      invitedBy: null,
    });

    // Add other participants as members
    for (const did of participantDids) {
      if (did !== identity.id) {
        await db.insert(participants).values({
          conversationId,
          did,
          role: 'member',
          invitedBy: identity.id,
        });
      }
    }

    // Add system message for group creation
    if (type === 'group') {
      await db.insert(messages).values({
        id: generateId('msg'),
        conversationId,
        fromDid: identity.id,
        content: { type: 'system', text: `${identity.id} created the group` },
        contentType: 'system',
      });
    }

    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });

    return jsonResponse({ conversation }, 201);
  } catch (error) {
    console.error('Failed to create conversation:', error);
    return errorResponse('Failed to create conversation', 500);
  }
}
