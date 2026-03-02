import { NextRequest } from 'next/server';
import { eq, and, sql } from 'drizzle-orm';
import { db, messages, messageReactions, participants } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse } from '@/lib/utils';

/**
 * GET /api/messages/:msgId/reactions - Get reactions for a message
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ msgId: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const { msgId } = await params;

  try {
    // Verify message exists and user has access
    const message = await db.query.messages.findFirst({
      where: eq(messages.id, msgId),
    });

    if (!message) {
      return errorResponse('Message not found', 404);
    }

    // Check if user is participant
    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, message.conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!participant) {
      return errorResponse('Access denied', 403);
    }

    // Get reactions grouped by emoji
    const reactions = await db
      .select({
        emoji: messageReactions.emoji,
        count: sql<number>`count(*)::int`,
        reacted: sql<boolean>`bool_or(${messageReactions.did} = ${identity.id})`,
      })
      .from(messageReactions)
      .where(eq(messageReactions.messageId, msgId))
      .groupBy(messageReactions.emoji);

    return jsonResponse({ reactions });
  } catch (error) {
    console.error('Failed to get reactions:', error);
    return errorResponse('Failed to get reactions', 500);
  }
}

/**
 * POST /api/messages/:msgId/reactions - Add a reaction
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ msgId: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const { msgId } = await params;

  try {
    const body = await request.json();
    const { emoji } = body;

    if (!emoji || typeof emoji !== 'string') {
      return errorResponse('emoji is required and must be a string');
    }

    // Verify message exists and user has access
    const message = await db.query.messages.findFirst({
      where: eq(messages.id, msgId),
    });

    if (!message) {
      return errorResponse('Message not found', 404);
    }

    // Check if user is participant
    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, message.conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!participant) {
      return errorResponse('Access denied', 403);
    }

    // Insert reaction (will fail silently if already exists due to primary key)
    await db
      .insert(messageReactions)
      .values({
        messageId: msgId,
        did: identity.id,
        emoji,
      })
      .onConflictDoNothing();

    // Get updated reactions
    const reactions = await db
      .select({
        emoji: messageReactions.emoji,
        count: sql<number>`count(*)::int`,
        reacted: sql<boolean>`bool_or(${messageReactions.did} = ${identity.id})`,
      })
      .from(messageReactions)
      .where(eq(messageReactions.messageId, msgId))
      .groupBy(messageReactions.emoji);

    // Broadcast via WebSocket
    const port = process.env.PORT || '3007';
    fetch(`http://localhost:${port}/__ws_broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: message.conversationId,
        type: 'reaction_added',
        messageId: msgId,
        emoji,
        did: identity.id,
        reactions,
      }),
    }).catch(() => {});

    return jsonResponse({ reactions });
  } catch (error) {
    console.error('Failed to add reaction:', error);
    return errorResponse('Failed to add reaction', 500);
  }
}

/**
 * DELETE /api/messages/:msgId/reactions - Remove a reaction
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ msgId: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const { msgId } = await params;

  try {
    const body = await request.json();
    const { emoji } = body;

    if (!emoji || typeof emoji !== 'string') {
      return errorResponse('emoji is required and must be a string');
    }

    // Verify message exists and user has access
    const message = await db.query.messages.findFirst({
      where: eq(messages.id, msgId),
    });

    if (!message) {
      return errorResponse('Message not found', 404);
    }

    // Check if user is participant
    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, message.conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!participant) {
      return errorResponse('Access denied', 403);
    }

    // Remove reaction
    await db
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, msgId),
          eq(messageReactions.did, identity.id),
          eq(messageReactions.emoji, emoji)
        )
      );

    // Get updated reactions
    const reactions = await db
      .select({
        emoji: messageReactions.emoji,
        count: sql<number>`count(*)::int`,
        reacted: sql<boolean>`bool_or(${messageReactions.did} = ${identity.id})`,
      })
      .from(messageReactions)
      .where(eq(messageReactions.messageId, msgId))
      .groupBy(messageReactions.emoji);

    // Broadcast via WebSocket
    const port = process.env.PORT || '3007';
    fetch(`http://localhost:${port}/__ws_broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: message.conversationId,
        type: 'reaction_removed',
        messageId: msgId,
        emoji,
        did: identity.id,
        reactions,
      }),
    }).catch(() => {});

    return jsonResponse({ reactions });
  } catch (error) {
    console.error('Failed to remove reaction:', error);
    return errorResponse('Failed to remove reaction', 500);
  }
}
