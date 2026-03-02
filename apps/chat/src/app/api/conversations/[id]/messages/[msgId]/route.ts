import { NextRequest } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, messages, participants } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';

/**
 * PUT /api/conversations/:id/messages/:msgId - Edit a message
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; msgId: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const { id: conversationId, msgId } = await params;

  try {
    // Get the message
    const message = await db.query.messages.findFirst({
      where: and(
        eq(messages.id, msgId),
        eq(messages.conversationId, conversationId)
      ),
    });

    if (!message) {
      return errorResponse('Message not found', 404);
    }

    // Only the author can edit
    if (message.fromDid !== identity.id) {
      return errorResponse('You can only edit your own messages', 403);
    }

    const body = await request.json();
    const { content } = body;

    if (!content || typeof content !== 'object') {
      return errorResponse('content is required and must be an object');
    }

    // Update the message
    await db
      .update(messages)
      .set({
        content,
        editedAt: new Date(),
      })
      .where(eq(messages.id, msgId));

    const updatedMessage = await db.query.messages.findFirst({
      where: eq(messages.id, msgId),
    });

    // Broadcast via WebSocket
    if (updatedMessage) {
      const port = process.env.PORT || '3007';
      fetch(`http://localhost:${port}/__ws_broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          type: 'message_edited',
          message: updatedMessage,
        }),
      }).catch(() => {});
    }

    return jsonResponse({ message: updatedMessage });
  } catch (error) {
    console.error('Failed to edit message:', error);
    return errorResponse('Failed to edit message', 500);
  }
}

/**
 * DELETE /api/conversations/:id/messages/:msgId - Delete a message (soft delete)
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; msgId: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const { id: conversationId, msgId } = await params;

  try {
    // Get the message
    const message = await db.query.messages.findFirst({
      where: and(
        eq(messages.id, msgId),
        eq(messages.conversationId, conversationId)
      ),
    });

    if (!message) {
      return errorResponse('Message not found', 404);
    }

    // Check permissions: author can delete, or admin/owner for group conversations
    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, identity.id)
      ),
    });

    const canDelete =
      message.fromDid === identity.id ||
      participant?.role === 'admin' ||
      participant?.role === 'owner';

    if (!canDelete) {
      return errorResponse('You do not have permission to delete this message', 403);
    }

    // Soft delete
    await db
      .update(messages)
      .set({
        deletedAt: new Date(),
      })
      .where(eq(messages.id, msgId));

    const deletedMessage = await db.query.messages.findFirst({
      where: eq(messages.id, msgId),
    });

    // Broadcast via WebSocket
    if (deletedMessage) {
      const port = process.env.PORT || '3007';
      fetch(`http://localhost:${port}/__ws_broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          type: 'message_deleted',
          message: deletedMessage,
        }),
      }).catch(() => {});
    }

    return jsonResponse({ message: deletedMessage });
  } catch (error) {
    console.error('Failed to delete message:', error);
    return errorResponse('Failed to delete message', 500);
  }
}
