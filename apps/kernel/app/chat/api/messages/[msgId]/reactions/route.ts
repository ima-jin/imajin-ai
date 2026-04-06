import { NextRequest } from 'next/server';
import { eq, and, sql } from 'drizzle-orm';
import { db, messagesV2, messageReactionsV2 } from '@/src/db';
import { requireAuth } from '@/src/lib/chat/auth';
import { jsonResponse, errorResponse } from '@/src/lib/chat/utils';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

async function verifyAccess(did: string, cookieHeader: string | null): Promise<boolean> {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/access/${encodeURIComponent(did)}`, {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * GET /api/messages/:msgId/reactions - Get reactions for a v2 message
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
  const effectiveDid = identity.actingAs || identity.id;
  const { msgId } = await params;

  try {
    const message = await db.query.messagesV2.findFirst({
      where: eq(messagesV2.id, msgId),
    });

    if (!message) {
      return errorResponse('Message not found', 404);
    }

    // Verify access to the conversation
    const hasAccess = await verifyAccess(message.conversationDid, request.headers.get('Cookie'));
    if (!hasAccess) {
      return errorResponse('Access denied', 403);
    }

    const reactions = await db
      .select({
        emoji: messageReactionsV2.emoji,
        count: sql<number>`count(*)::int`,
        reacted: sql<boolean>`bool_or(${messageReactionsV2.did} = ${effectiveDid})`,
      })
      .from(messageReactionsV2)
      .where(eq(messageReactionsV2.messageId, msgId))
      .groupBy(messageReactionsV2.emoji);

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
  const effectiveDid = identity.actingAs || identity.id;
  const { msgId } = await params;

  try {
    const body = await request.json();
    const { emoji } = body;

    if (!emoji || typeof emoji !== 'string') {
      return errorResponse('emoji is required and must be a string');
    }

    const message = await db.query.messagesV2.findFirst({
      where: eq(messagesV2.id, msgId),
    });

    if (!message) {
      return errorResponse('Message not found', 404);
    }

    const hasAccess = await verifyAccess(message.conversationDid, request.headers.get('Cookie'));
    if (!hasAccess) {
      return errorResponse('Access denied', 403);
    }

    await db
      .insert(messageReactionsV2)
      .values({ messageId: msgId, did: effectiveDid, emoji })
      .onConflictDoNothing();

    const reactions = await db
      .select({
        emoji: messageReactionsV2.emoji,
        count: sql<number>`count(*)::int`,
        reacted: sql<boolean>`bool_or(${messageReactionsV2.did} = ${effectiveDid})`,
      })
      .from(messageReactionsV2)
      .where(eq(messageReactionsV2.messageId, msgId))
      .groupBy(messageReactionsV2.emoji);

    const port = process.env.PORT || '3007';
    fetch(`http://localhost:${port}/__ws_broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: message.conversationDid,
        type: 'reaction_added',
        messageId: msgId,
        emoji,
        did: effectiveDid,
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
  const effectiveDid = identity.actingAs || identity.id;
  const { msgId } = await params;

  try {
    const body = await request.json();
    const { emoji } = body;

    if (!emoji || typeof emoji !== 'string') {
      return errorResponse('emoji is required and must be a string');
    }

    const message = await db.query.messagesV2.findFirst({
      where: eq(messagesV2.id, msgId),
    });

    if (!message) {
      return errorResponse('Message not found', 404);
    }

    const hasAccess = await verifyAccess(message.conversationDid, request.headers.get('Cookie'));
    if (!hasAccess) {
      return errorResponse('Access denied', 403);
    }

    await db
      .delete(messageReactionsV2)
      .where(
        and(
          eq(messageReactionsV2.messageId, msgId),
          eq(messageReactionsV2.did, effectiveDid),
          eq(messageReactionsV2.emoji, emoji)
        )
      );

    const reactions = await db
      .select({
        emoji: messageReactionsV2.emoji,
        count: sql<number>`count(*)::int`,
        reacted: sql<boolean>`bool_or(${messageReactionsV2.did} = ${effectiveDid})`,
      })
      .from(messageReactionsV2)
      .where(eq(messageReactionsV2.messageId, msgId))
      .groupBy(messageReactionsV2.emoji);

    const port = process.env.PORT || '3007';
    fetch(`http://localhost:${port}/__ws_broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: message.conversationDid,
        type: 'reaction_removed',
        messageId: msgId,
        emoji,
        did: effectiveDid,
        reactions,
      }),
    }).catch(() => {});

    return jsonResponse({ reactions });
  } catch (error) {
    console.error('Failed to remove reaction:', error);
    return errorResponse('Failed to remove reaction', 500);
  }
}
