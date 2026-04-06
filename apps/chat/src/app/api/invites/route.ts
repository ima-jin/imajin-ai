import { NextRequest } from 'next/server';
import { eq, and, isNull } from 'drizzle-orm';
import { db, invites } from '@/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, generateId } from '@/lib/utils';

// TODO(#435-followup): The invites table still references chat.conversations.id (v1 FK).
// The conversationId field here now accepts a conversation DID as a plain text column
// (FK constraint should be dropped in a follow-up migration).
// Until then, invite creation/acceptance works with both v1 conv IDs (legacy) and v2 DIDs.

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
    const hasAccess = await verifyAccess(conversationId, request.headers.get('Cookie'));
    if (!hasAccess) {
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

  const hasAccess = await verifyAccess(conversationId, request.headers.get('Cookie'));
  if (!hasAccess) {
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
