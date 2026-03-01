import { NextRequest } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, conversations, participants } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, hasRole } from '@/lib/utils';

/**
 * GET /api/conversations/:id - Get conversation details
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
  const { id: conversationId } = await params;

  try {
    // Check if user is a participant
    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!participant) {
      return errorResponse('Conversation not found or access denied', 404);
    }

    // Get conversation with all participants
    const conversation = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });

    if (!conversation) {
      return errorResponse('Conversation not found', 404);
    }

    const allParticipants = await db.query.participants.findMany({
      where: eq(participants.conversationId, conversationId),
    });

    return jsonResponse({
      conversation,
      participants: allParticipants,
      myRole: participant.role,
    });
  } catch (error) {
    console.error('Failed to get conversation:', error);
    return errorResponse('Failed to get conversation', 500);
  }
}

/**
 * PATCH /api/conversations/:id - Update conversation (admin+)
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
  const { id: conversationId } = await params;

  try {
    // Check if user is admin or owner
    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!participant || !hasRole(participant.role, 'admin')) {
      return errorResponse('Permission denied', 403);
    }

    const body = await request.json();
    const { name, description, visibility } = body;

    const updates: Partial<typeof conversations.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (visibility !== undefined) updates.visibility = visibility;

    await db
      .update(conversations)
      .set(updates)
      .where(eq(conversations.id, conversationId));

    const updated = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });

    return jsonResponse({ conversation: updated });
  } catch (error) {
    console.error('Failed to update conversation:', error);
    return errorResponse('Failed to update conversation', 500);
  }
}

/**
 * DELETE /api/conversations/:id - Delete conversation (owner only)
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
  const { id: conversationId } = await params;

  try {
    // Check if user is owner
    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!participant || participant.role !== 'owner') {
      return errorResponse('Only the owner can delete a conversation', 403);
    }

    // Cascade delete handles participants and messages
    await db.delete(conversations).where(eq(conversations.id, conversationId));

    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error('Failed to delete conversation:', error);
    return errorResponse('Failed to delete conversation', 500);
  }
}
