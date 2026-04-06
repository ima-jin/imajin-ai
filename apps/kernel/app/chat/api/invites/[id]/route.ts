import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, invites } from '@/src/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse, generateId } from '@/src/lib/kernel/utils';

// TODO(#435-followup): invites.conversationId FK to chat.conversations.id needs to be
// dropped and the column treated as plain text pointing to a conversation DID.

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
 * GET /api/invites/:id - Get invite info (public — for preview before joining)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: inviteId } = await params;

  try {
    const invite = await db.query.invites.findFirst({
      where: eq(invites.id, inviteId),
    });

    if (!invite) {
      return errorResponse('Invite not found', 404);
    }

    if (invite.revokedAt) {
      return errorResponse('Invite has been revoked', 410);
    }

    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
      return errorResponse('Invite has expired', 410);
    }

    if (invite.maxUses && parseInt(invite.usedCount) >= parseInt(invite.maxUses)) {
      return errorResponse('Invite has reached maximum uses', 410);
    }

    return jsonResponse({
      invite: {
        id: invite.id,
        conversationId: invite.conversationId,
        forDid: invite.forDid,
        expiresAt: invite.expiresAt,
      },
    });
  } catch (error) {
    console.error('Failed to get invite:', error);
    return errorResponse('Failed to get invite', 500);
  }
}

/**
 * POST /api/invites/:id - Accept invite (join conversation)
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
  const effectiveDid = identity.actingAs || identity.id;
  const { id: inviteId } = await params;

  try {
    const invite = await db.query.invites.findFirst({
      where: eq(invites.id, inviteId),
    });

    if (!invite) {
      return errorResponse('Invite not found', 404);
    }

    if (invite.revokedAt) {
      return errorResponse('Invite has been revoked', 410);
    }

    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
      return errorResponse('Invite has expired', 410);
    }

    if (invite.maxUses && parseInt(invite.usedCount) >= parseInt(invite.maxUses)) {
      return errorResponse('Invite has reached maximum uses', 410);
    }

    if (invite.forDid && invite.forDid !== effectiveDid) {
      return errorResponse('This invite is for a different user', 403);
    }

    // Increment used count
    await db
      .update(invites)
      .set({ usedCount: (parseInt(invite.usedCount) + 1).toString() })
      .where(eq(invites.id, inviteId));

    // Return the conversation DID — the client should redirect there
    return jsonResponse({
      conversationId: invite.conversationId,
      joined: true,
    });
  } catch (error) {
    console.error('Failed to accept invite:', error);
    return errorResponse('Failed to accept invite', 500);
  }
}

/**
 * DELETE /api/invites/:id - Revoke invite
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
  const { id: inviteId } = await params;

  try {
    const invite = await db.query.invites.findFirst({
      where: eq(invites.id, inviteId),
    });

    if (!invite) {
      return errorResponse('Invite not found', 404);
    }

    if (invite.createdBy !== effectiveDid) {
      // Check if user has access to the conversation
      const hasAccess = await verifyAccess(invite.conversationId, request.headers.get('Cookie'));
      if (!hasAccess) {
        return errorResponse('Permission denied', 403);
      }
    }

    await db
      .update(invites)
      .set({ revokedAt: new Date() })
      .where(eq(invites.id, inviteId));

    return jsonResponse({ revoked: true });
  } catch (error) {
    console.error('Failed to revoke invite:', error);
    return errorResponse('Failed to revoke invite', 500);
  }
}
