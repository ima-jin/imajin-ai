import { NextRequest } from 'next/server';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { db, conversations, participants, invites, messages } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId, hasRole } from '@/lib/utils';

/**
 * POST /api/invites - Create an invite link
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;

  try {
    const body = await request.json();
    const { conversationId, forDid, maxUses, expiresInHours } = body;

    if (!conversationId) {
      return errorResponse('conversationId is required');
    }

    // Check if user can create invites (admin+)
    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!participant || !hasRole(participant.role, 'admin')) {
      return errorResponse('Permission denied', 403);
    }

    // Calculate expiry
    let expiresAt = null;
    if (expiresInHours) {
      expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
    }

    // Create invite
    const inviteId = generateId('inv');
    
    await db.insert(invites).values({
      id: inviteId,
      conversationId,
      createdBy: identity.id,
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

  const { identity } = authResult;
  const url = new URL(request.url);
  const conversationId = url.searchParams.get('conversationId');

  if (!conversationId) {
    return errorResponse('conversationId is required');
  }

  try {
    // Check if user is admin+
    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!participant || !hasRole(participant.role, 'admin')) {
      return errorResponse('Permission denied', 403);
    }

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
