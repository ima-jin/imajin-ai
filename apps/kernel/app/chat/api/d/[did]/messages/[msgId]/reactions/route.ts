import { NextRequest } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, messagesV2, messageReactionsV2 } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/src/lib/kernel/utils';
import { corsOptions, corsHeaders } from "@/src/lib/kernel/cors";
import { checkAccess } from '@/src/lib/kernel/access';

/**
 * OPTIONS /api/d/:did/messages/:msgId/reactions - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /api/d/:did/messages/:msgId/reactions - Add a reaction
 */
export async function POST(
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

  const access = await checkAccess(effectiveDid, did);
  if (!access.allowed) {
    return errorResponse('Access denied', 403, cors);
  }

  try {
    const message = await db.query.messagesV2.findFirst({
      where: and(
        eq(messagesV2.id, msgId),
        eq(messagesV2.conversationDid, did)
      ),
    });

    if (!message) {
      return errorResponse('Message not found', 404, cors);
    }

    const body = await request.json();
    const { emoji } = body;

    if (!emoji || typeof emoji !== 'string') {
      return errorResponse('emoji is required', 400, cors);
    }

    await db.insert(messageReactionsV2).values({
      messageId: msgId,
      did: effectiveDid,
      emoji,
    }).onConflictDoNothing();

    const port = process.env.PORT || '3007';
    fetch(`http://localhost:${port}/__ws_broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: did, type: 'reaction_added', messageId: msgId, emoji, senderDid: effectiveDid }),
    }).catch(() => {});

    return jsonResponse({ ok: true }, 201, cors);
  } catch (error) {
    console.error('Failed to add reaction:', error);
    return errorResponse('Failed to add reaction', 500, cors);
  }
}

/**
 * DELETE /api/d/:did/messages/:msgId/reactions - Remove a reaction
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

  const access = await checkAccess(effectiveDid, did);
  if (!access.allowed) {
    return errorResponse('Access denied', 403, cors);
  }

  try {
    const body = await request.json();
    const { emoji } = body;

    if (!emoji || typeof emoji !== 'string') {
      return errorResponse('emoji is required', 400, cors);
    }

    await db.delete(messageReactionsV2).where(
      and(
        eq(messageReactionsV2.messageId, msgId),
        eq(messageReactionsV2.did, effectiveDid),
        eq(messageReactionsV2.emoji, emoji)
      )
    );

    const port = process.env.PORT || '3007';
    fetch(`http://localhost:${port}/__ws_broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: did, type: 'reaction_removed', messageId: msgId, emoji, senderDid: effectiveDid }),
    }).catch(() => {});

    return new Response(null, { status: 204, headers: cors });
  } catch (error) {
    console.error('Failed to remove reaction:', error);
    return errorResponse('Failed to remove reaction', 500, cors);
  }
}
