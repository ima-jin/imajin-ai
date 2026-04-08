import { NextRequest } from 'next/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db, invites } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse, generateId } from '@/src/lib/kernel/utils';
import { checkAccess } from '@/src/lib/kernel/access';

// TODO(#435-followup): The invites table still references chat.conversations.id (v1 FK).
// The conversationId field here now accepts a conversation DID as a plain text column
// (FK constraint should be dropped in a follow-up migration).
// Until then, invite creation/acceptance works with both v1 conv IDs (legacy) and v2 DIDs.

/**
 * POST /api/invites - Create an invite link for a v2 conversation
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const effectiveDid = identity.actingAs || identity.id;

  try {
    const body = await request.json();
    const { conversationId, forDid, maxUses, expiresInHours } = body;

    if (!conversationId) {
      return errorResponse('conversationId is required');
    }

    // Verify user has access to the conversation
    const access = await checkAccess(effectiveDid, conversationId);
    if (!access.allowed) {
      return errorResponse('Permission denied', 403);
    }

    let expiresAt = null;
    if (expiresInHours) {
      expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
    }

    const inviteId = generateId('inv');

    await db.insert(invites).values({
      id: inviteId,
      conversationId,
      createdBy: effectiveDid,
      forDid: forDid || null,
      maxUses: maxUses?.toString() || null,
      expiresAt,
    });

    const invite = await db.query.invites.findFirst({
      where: eq(invites.id, inviteId),
    });

    return jsonResponse({
      invite,
      link: `${process.env.NEXT_PUBLIC_BASE_URL || 'https://chat.imajin.ai'}/join/${inviteId}`,
    }, 201);
  } catch (error) {
    console.error('Failed to create invite:', error);
    return errorResponse('Failed to create invite', 500);
  }
}

/**
 * GET /api/invites?conversationId=xxx - List invites for a conversation
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const url = new URL(request.url);
  const conversationId = url.searchParams.get('conversationId');

  if (!conversationId) {
    return errorResponse('conversationId is required');
  }

  const { identity } = authResult;
  const effectiveDid = identity.actingAs || identity.id;
  const access = await checkAccess(effectiveDid, conversationId);
  if (!access.allowed) {
    return errorResponse('Permission denied', 403);
  }

  try {
    const inviteList = await db.query.invites.findMany({
      where: and(
        eq(invites.conversationId, conversationId),
        isNull(invites.revokedAt)
      ),
    });

    return jsonResponse({ invites: inviteList });
  } catch (error) {
    console.error('Failed to list invites:', error);
    return errorResponse('Failed to list invites', 500);
  }
}
