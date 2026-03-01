import { NextRequest } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, conversations, participants, messages } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId, hasRole, isValidDid } from '@/lib/utils';

/**
 * GET /api/conversations/:id/participants - List participants
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
    // Verify user is a participant
    const myParticipant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!myParticipant) {
      return errorResponse('Conversation not found or access denied', 404);
    }

    const allParticipants = await db.query.participants.findMany({
      where: eq(participants.conversationId, conversationId),
    });

    return jsonResponse({ participants: allParticipants });
  } catch (error) {
    console.error('Failed to list participants:', error);
    return errorResponse('Failed to list participants', 500);
  }
}

/**
 * POST /api/conversations/:id/participants - Add participant (admin+)
 */
export async function POST(
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
    // Check if user can invite (admin or owner)
    const myParticipant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!myParticipant || !hasRole(myParticipant.role, 'admin')) {
      return errorResponse('Permission denied', 403);
    }

    const body = await request.json();
    const { did, role = 'member' } = body;

    if (!isValidDid(did)) {
      return errorResponse('Invalid DID');
    }

    // Can't add someone with higher role than yourself (unless owner)
    if (myParticipant.role !== 'owner' && hasRole(role, myParticipant.role)) {
      return errorResponse('Cannot add participant with equal or higher role');
    }

    // Check if already a participant
    const existing = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, did)
      ),
    });

    if (existing) {
      return errorResponse('Already a participant', 409);
    }

    // Add participant
    await db.insert(participants).values({
      conversationId,
      did,
      role,
      invitedBy: identity.id,
    });

    // Add system message
    await db.insert(messages).values({
      id: generateId('msg'),
      conversationId,
      fromDid: identity.id,
      content: { type: 'system', text: `${identity.id} added ${did}` },
      contentType: 'system',
    });

    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, did)
      ),
    });

    return jsonResponse({ participant }, 201);
  } catch (error) {
    console.error('Failed to add participant:', error);
    return errorResponse('Failed to add participant', 500);
  }
}

/**
 * PATCH /api/conversations/:id/participants - Update participant role (owner only for admin+)
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
    const body = await request.json();
    const { did, role } = body;

    if (!isValidDid(did)) {
      return errorResponse('Invalid DID');
    }

    if (!['readonly', 'member', 'admin'].includes(role)) {
      return errorResponse('Invalid role');
    }

    // Check if user is owner
    const myParticipant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!myParticipant || myParticipant.role !== 'owner') {
      return errorResponse('Only the owner can change roles', 403);
    }

    // Can't change your own role
    if (did === identity.id) {
      return errorResponse('Cannot change your own role');
    }

    // Update role
    await db
      .update(participants)
      .set({ role })
      .where(
        and(
          eq(participants.conversationId, conversationId),
          eq(participants.did, did)
        )
      );

    // Add system message
    await db.insert(messages).values({
      id: generateId('msg'),
      conversationId,
      fromDid: identity.id,
      content: { type: 'system', text: `${identity.id} changed ${did}'s role to ${role}` },
      contentType: 'system',
    });

    return jsonResponse({ updated: true });
  } catch (error) {
    console.error('Failed to update participant:', error);
    return errorResponse('Failed to update participant', 500);
  }
}

/**
 * DELETE /api/conversations/:id/participants - Remove participant
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
    const url = new URL(request.url);
    const did = url.searchParams.get('did');

    if (!did || !isValidDid(did)) {
      return errorResponse('Invalid or missing DID');
    }

    const myParticipant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!myParticipant) {
      return errorResponse('Conversation not found', 404);
    }

    // Can remove yourself (leave) or others if admin+
    const isSelf = did === identity.id;
    
    if (!isSelf && !hasRole(myParticipant.role, 'admin')) {
      return errorResponse('Permission denied', 403);
    }

    // Owner can't leave without transferring ownership
    if (isSelf && myParticipant.role === 'owner') {
      return errorResponse('Owner must transfer ownership before leaving');
    }

    // Get the participant being removed
    const targetParticipant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, did)
      ),
    });

    if (!targetParticipant) {
      return errorResponse('Participant not found', 404);
    }

    // Can't remove someone with higher role
    if (!isSelf && hasRole(targetParticipant.role, myParticipant.role)) {
      return errorResponse('Cannot remove participant with equal or higher role');
    }

    // Remove
    await db
      .delete(participants)
      .where(
        and(
          eq(participants.conversationId, conversationId),
          eq(participants.did, did)
        )
      );

    // Add system message
    const action = isSelf ? 'left the group' : `removed ${did}`;
    await db.insert(messages).values({
      id: generateId('msg'),
      conversationId,
      fromDid: identity.id,
      content: { type: 'system', text: `${identity.id} ${action}` },
      contentType: 'system',
    });

    return jsonResponse({ removed: true });
  } catch (error) {
    console.error('Failed to remove participant:', error);
    return errorResponse('Failed to remove participant', 500);
  }
}
