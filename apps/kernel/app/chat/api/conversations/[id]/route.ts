import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, conversationsV2 } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/src/lib/kernel/utils';

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

  const { id } = await params;
  const conversationDid = decodeURIComponent(id);

  const hasAccess = await verifyAccess(conversationDid, request.headers.get('Cookie'));
  if (!hasAccess) {
    return errorResponse('Conversation not found or access denied', 404);
  }

  try {
    const conversation = await db.query.conversationsV2.findFirst({
      where: eq(conversationsV2.did, conversationDid),
    });

    if (!conversation) {
      return errorResponse('Conversation not found', 404);
    }

    return jsonResponse({ conversation });
  } catch (error) {
    console.error('Failed to get conversation:', error);
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

  const hasAccess = await verifyAccess(conversationDid, request.headers.get('Cookie'));
  if (!hasAccess) {
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
    console.error('Failed to update conversation:', error);
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
    console.error('Failed to delete conversation:', error);
    return errorResponse('Failed to delete conversation', 500);
  }
}
