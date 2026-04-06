import { NextRequest } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, messagesV2 } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, corsHeaders, corsOptions } from '@/lib/utils';

/**
 * OPTIONS /api/d/:did/messages/:msgId - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * PATCH /api/d/:did/messages/:msgId - Edit a message
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ did: string; msgId: string }> }
) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { identity } = authResult;
  const effectiveDid = identity.actingAs || identity.id;
  const { did, msgId } = await params;

  try {
    const existing = await db.query.messagesV2.findFirst({
      where: and(
        eq(messagesV2.id, msgId),
        eq(messagesV2.conversationDid, did)
      ),
    });

    if (!existing) {
      return errorResponse('Message not found', 404, cors);
    }

    if (existing.fromDid !== effectiveDid) {
      return errorResponse('You can only edit your own messages', 403, cors);
    }

    if (existing.deletedAt) {
      return errorResponse('Cannot edit a deleted message', 400, cors);
    }

    const body = await request.json();
    const { content } = body;

    if (!content || typeof content !== 'object') {
      return errorResponse('content is required and must be an object', 400, cors);
    }

    await db
      .update(messagesV2)
      .set({ content, editedAt: new Date() })
      .where(eq(messagesV2.id, msgId));

    const updated = await db.query.messagesV2.findFirst({
      where: eq(messagesV2.id, msgId),
    });

    // Broadcast so other connected clients see the edit immediately
    if (updated) {
      const port = process.env.PORT || '3007';
      fetch(`http://localhost:${port}/__ws_broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: did, type: 'message_edited', message: updated }),
      }).catch(() => {});
    }

    return jsonResponse({ message: updated }, 200, cors);
  } catch (error) {
    console.error('Failed to edit message:', error);
    return errorResponse('Failed to edit message', 500, cors);
  }
}

/**
 * DELETE /api/d/:did/messages/:msgId - Soft delete a message
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ did: string; msgId: string }> }
) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { identity } = authResult;
  const effectiveDid = identity.actingAs || identity.id;
  const { did, msgId } = await params;

  try {
    const existing = await db.query.messagesV2.findFirst({
      where: and(
        eq(messagesV2.id, msgId),
        eq(messagesV2.conversationDid, did)
      ),
    });

    if (!existing) {
      return errorResponse('Message not found', 404, cors);
    }

    if (existing.fromDid !== effectiveDid) {
      return errorResponse('You can only delete your own messages', 403, cors);
    }

    await db
      .update(messagesV2)
      .set({ deletedAt: new Date() })
      .where(eq(messagesV2.id, msgId));

    const port = process.env.PORT || '3007';
    fetch(`http://localhost:${port}/__ws_broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: did, type: 'message_deleted', messageId: msgId }),
    }).catch(() => {});

    return new Response(null, { status: 204, headers: cors });
  } catch (error) {
    console.error('Failed to delete message:', error);
    return errorResponse('Failed to delete message', 500, cors);
  }
}
