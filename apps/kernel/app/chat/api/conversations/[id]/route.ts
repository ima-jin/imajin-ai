import { NextRequest } from 'next/server';
import { eq, ne, and, sql } from 'drizzle-orm';
import { db, conversationsV2, profiles } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/src/lib/kernel/utils';
import { checkAccess } from '@/src/lib/kernel/access';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * GET /api/conversations/:id - Get v2 conversation details
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

  const { identity } = authResult;
  const effectiveDid = identity.actingAs || identity.id;
  const { id } = await params;
  const conversationDid = decodeURIComponent(id);

  const access = await checkAccess(effectiveDid, conversationDid);
  if (!access.allowed) {
    return errorResponse('Conversation not found or access denied', 404);
  }

  try {
    const conversation = await db.query.conversationsV2.findFirst({
      where: eq(conversationsV2.did, conversationDid),
    });

    if (!conversation) {
      return errorResponse('Conversation not found', 404);
    }

    // For DMs, resolve the other participant
    let otherParticipant: { did: string; handle: string | null; name: string | null } | null = null;
    if (conversationDid.startsWith('did:imajin:dm:')) {
      try {
        const members = await db.execute<{ member_did: string }>(sql`
          SELECT member_did FROM chat.conversation_members
          WHERE conversation_did = ${conversationDid}
            AND member_did != ${effectiveDid}
          LIMIT 1
        `);
        const otherDid = members[0]?.member_did || (conversation.createdBy !== effectiveDid ? conversation.createdBy : null);
        if (otherDid) {
          const profile = await db.query.profiles.findFirst({
            where: eq(profiles.did, otherDid),
            columns: { did: true, handle: true, name: true },
          });
          if (profile) {
            otherParticipant = { did: profile.did, handle: profile.handle, name: profile.name };
          }
        }
      } catch {
        // non-critical — fall back to generic header
      }
    }

    return jsonResponse({ conversation, otherParticipant });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to get conversation');
    return errorResponse('Failed to get conversation', 500);
  }
}

/**
 * PATCH /api/conversations/:id - Update conversation name
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const effectiveDid = identity.actingAs || identity.id;
  const { id } = await params;
  const conversationDid = decodeURIComponent(id);

  const access = await checkAccess(effectiveDid, conversationDid);
  if (!access.allowed) {
    return errorResponse('Access denied', 403);
  }

  try {
    const body = await request.json();
    const { name } = body;

    const conv = await db.query.conversationsV2.findFirst({
      where: eq(conversationsV2.did, conversationDid),
    });

    if (!conv) {
      // Auto-create if it doesn't exist yet
      await db.insert(conversationsV2).values({
        did: conversationDid,
        name: name || null,
        createdBy: effectiveDid,
      }).onConflictDoNothing();
    } else {
      if (conv.createdBy !== effectiveDid) {
        return errorResponse('Only the creator can update the name', 403);
      }
      await db
        .update(conversationsV2)
        .set({ name: name || null, updatedAt: new Date() })
        .where(eq(conversationsV2.did, conversationDid));
    }

    return jsonResponse({ ok: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to update conversation');
    return errorResponse('Failed to update conversation', 500);
  }
}

/**
 * DELETE /api/conversations/:id - Delete conversation (creator only)
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const effectiveDid = identity.actingAs || identity.id;
  const { id } = await params;
  const conversationDid = decodeURIComponent(id);

  try {
    const conv = await db.query.conversationsV2.findFirst({
      where: eq(conversationsV2.did, conversationDid),
    });

    if (!conv) {
      return errorResponse('Conversation not found', 404);
    }

    if (conv.createdBy !== effectiveDid) {
      return errorResponse('Only the creator can delete a conversation', 403);
    }

    // Cascade deletes messages_v2, message_reactions_v2, conversation_reads_v2
    await db.delete(conversationsV2).where(eq(conversationsV2.did, conversationDid));

    return jsonResponse({ deleted: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to delete conversation');
    return errorResponse('Failed to delete conversation', 500);
  }
}
