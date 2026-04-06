import { NextRequest } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, messagesV2 } from '@/src/db';
import { requireAuth } from '@/src/lib/chat/auth';
import { jsonResponse, errorResponse } from '@/src/lib/chat/utils';

export const dynamic = 'force-dynamic';

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
  const effectiveDid = identity.actingAs || identity.id;
  const { id, msgId } = await params;
  const conversationDid = decodeURIComponent(id);

  try {
    const message = await db.query.messagesV2.findFirst({
      where: and(
        eq(messagesV2.id, msgId),
        eq(messagesV2.conversationDid, conversationDid)
      ),
    });

    if (!message) {
      return errorResponse('Message not found', 404);
    }

    if (message.fromDid !== effectiveDid) {
      return errorResponse('You can only edit your own messages', 403);
    }

    const body = await request.json();
    const { content } = body;

    if (!content || typeof content !== 'object') {
      return errorResponse('content is required and must be an object');
    }

    await db
      .update(messagesV2)
      .set({ content, editedAt: new Date() })
      .where(eq(messagesV2.id, msgId));

    const updatedMessage = await db.query.messagesV2.findFirst({
      where: eq(messagesV2.id, msgId),
    });

    if (updatedMessage) {
      const port = process.env.PORT || '3007';
      fetch(`http://localhost:${port}/__ws_broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversationDid,
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
 * DELETE /api/conversations/:id/messages/:msgId - Soft delete a message
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
  const effectiveDid = identity.actingAs || identity.id;
  const { id, msgId } = await params;
  const conversationDid = decodeURIComponent(id);

  try {
    const message = await db.query.messagesV2.findFirst({
      where: and(
        eq(messagesV2.id, msgId),
        eq(messagesV2.conversationDid, conversationDid)
      ),
    });

    if (!message) {
      return errorResponse('Message not found', 404);
    }

    // Author can always delete their own; for others, check access via auth service
    if (message.fromDid !== effectiveDid) {
      const hasAccess = await verifyAccess(conversationDid, request.headers.get('Cookie'));
      if (!hasAccess) {
        return errorResponse('You do not have permission to delete this message', 403);
      }
    }

    await db
      .update(messagesV2)
      .set({ deletedAt: new Date() })
      .where(eq(messagesV2.id, msgId));

    const deletedMessage = await db.query.messagesV2.findFirst({
      where: eq(messagesV2.id, msgId),
    });

    if (deletedMessage) {
      const port = process.env.PORT || '3007';
      fetch(`http://localhost:${port}/__ws_broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversationDid,
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
