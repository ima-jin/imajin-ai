import { NextRequest } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, conversations, participants, invites, messages } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId, hasRole } from '@/lib/utils';

/**
 * GET /api/invites/:id - Get invite info (public - for preview before joining)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: inviteId } = await params;

  try {
    const invite = await db.query.invites.findFirst({
      where: eq(invites.id, inviteId),
    });

    if (!invite) {
      return errorResponse('Invite not found', 404);
    }

    // Check if revoked
    if (invite.revokedAt) {
      return errorResponse('Invite has been revoked', 410);
    }

    // Check if expired
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
      return errorResponse('Invite has expired', 410);
    }

    // Check if maxed out
    if (invite.maxUses && parseInt(invite.usedCount) >= parseInt(invite.maxUses)) {
      return errorResponse('Invite has reached maximum uses', 410);
    }

    // Get conversation info (limited for preview)
    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, invite.conversationId),
    });

    if (!conversation) {
      return errorResponse('Conversation not found', 404);
    }

    // Count participants
    const allParticipants = await db.query.participants.findMany({
      where: eq(participants.conversationId, invite.conversationId),
    });

    return jsonResponse({
      invite: {
        id: invite.id,
        conversationId: invite.conversationId,
        forDid: invite.forDid,
        expiresAt: invite.expiresAt,
      },
      conversation: {
        id: conversation.id,
        type: conversation.type,
        name: conversation.name,
        description: conversation.description,
        avatar: conversation.avatar,
        participantCount: allParticipants.length,
      },
    });
  } catch (error) {
    console.error('Failed to get invite:', error);
    return errorResponse('Failed to get invite', 500);
  }
}

/**
 * POST /api/invites/:id - Accept invite (join conversation)
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
  const { id: inviteId } = await params;

  try {
    const invite = await db.query.invites.findFirst({
      where: eq(invites.id, inviteId),
    });

    if (!invite) {
      return errorResponse('Invite not found', 404);
    }

    // Validate invite is still valid
    if (invite.revokedAt) {
      return errorResponse('Invite has been revoked', 410);
    }

    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
      return errorResponse('Invite has expired', 410);
    }

    if (invite.maxUses && parseInt(invite.usedCount) >= parseInt(invite.maxUses)) {
      return errorResponse('Invite has reached maximum uses', 410);
    }

    // Check if invite is for a specific DID
    if (invite.forDid && invite.forDid !== identity.id) {
      return errorResponse('This invite is for a different user', 403);
    }

    // Check if already a participant
    const existing = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, invite.conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (existing) {
      return jsonResponse({ 
        conversationId: invite.conversationId,
        alreadyMember: true,
      });
    }

    // Add as participant
    await db.insert(participants).values({
      conversationId: invite.conversationId,
      did: identity.id,
      role: 'member',
      invitedBy: invite.createdBy,
    });

    // Increment used count
    await db
      .update(invites)
      .set({ usedCount: (parseInt(invite.usedCount) + 1).toString() })
      .where(eq(invites.id, inviteId));

    // Add system message
    await db.insert(messages).values({
      id: generateId('msg'),
      conversationId: invite.conversationId,
      fromDid: identity.id,
      content: { type: 'system', text: `${identity.id} joined via invite` },
      contentType: 'system',
    });

    return jsonResponse({ 
      conversationId: invite.conversationId,
      joined: true,
    });
  } catch (error) {
    console.error('Failed to accept invite:', error);
    return errorResponse('Failed to accept invite', 500);
  }
}

/**
 * DELETE /api/invites/:id - Revoke invite
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
  const { id: inviteId } = await params;

  try {
    const invite = await db.query.invites.findFirst({
      where: eq(invites.id, inviteId),
    });

    if (!invite) {
      return errorResponse('Invite not found', 404);
    }

    // Check if user can revoke (creator or admin+ of conversation)
    if (invite.createdBy !== identity.id) {
      const participant = await db.query.participants.findFirst({
        where: and(
          eq(participants.conversationId, invite.conversationId),
          eq(participants.did, identity.id)
        ),
      });

      if (!participant || !hasRole(participant.role, 'admin')) {
        return errorResponse('Permission denied', 403);
      }
    }

    await db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(eq(invites.id, inviteId));

    return jsonResponse({ revoked: true });
  } catch (error) {
    console.error('Failed to revoke invite:', error);
    return errorResponse('Failed to revoke invite', 500);
  }
}
