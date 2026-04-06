import { NextRequest } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse } from '@/src/lib/kernel/utils';
import { checkAccess } from '@/src/lib/kernel/access';
import { lookupIdentity } from '@/src/lib/kernel/lookup';

const sql = getClient();

/**
 * GET /api/conversations/:id/participants
 * :id is a URL-encoded conversation DID.
 * Returns members via direct DB query on chat.conversation_members.
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
  const requesterDid = authResult.identity.actingAs || authResult.identity.id;

  const access = await checkAccess(requesterDid, conversationDid);
  if (!access.allowed) {
    return errorResponse('Conversation not found or access denied', 404);
  }

  try {
    const rows = await sql`
      SELECT member_did as did, role
      FROM chat.conversation_members
      WHERE conversation_did = ${conversationDid}
        AND left_at IS NULL
      ORDER BY role DESC, joined_at ASC
    `;

    const participants = await Promise.all(
      rows.map(async (row: Record<string, string>) => {
        try {
          const identity = await lookupIdentity(row.did);
          if (identity) {
            return { did: row.did, role: row.role, name: identity.name || null, handle: identity.handle || null };
          }
        } catch {}
        return { did: row.did, role: row.role, name: null, handle: null };
      })
    );

    return jsonResponse({ participants });
  } catch (error) {
    console.error('Failed to list participants:', error);
    return errorResponse('Failed to list participants', 500);
  }
}

/**
 * POST /api/conversations/:id/participants - Add a member
 * Body: { memberDid: string, role?: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { id } = await params;
  const conversationDid = decodeURIComponent(id);
  const requesterDid = authResult.identity.actingAs || authResult.identity.id;

  const access = await checkAccess(requesterDid, conversationDid);
  if (!access.allowed) {
    return errorResponse('Access denied', 403);
  }

  try {
    const body = await request.json();
    const { memberDid, role = 'member' } = body;

    if (!memberDid) {
      return errorResponse('memberDid is required', 400);
    }

    await sql`
      INSERT INTO chat.conversation_members (conversation_did, member_did, role, joined_at)
      VALUES (${conversationDid}, ${memberDid}, ${role}, NOW())
      ON CONFLICT (conversation_did, member_did)
        DO UPDATE SET left_at = NULL, joined_at = NOW()
        WHERE chat.conversation_members.left_at IS NOT NULL
    `;

    return jsonResponse({ ok: true, did: conversationDid, memberDid, role }, 201);
  } catch (error) {
    console.error('Failed to add participant:', error);
    return errorResponse('Failed to add participant', 500);
  }
}
