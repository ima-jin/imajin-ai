import { NextRequest } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, corsHeaders, corsOptions } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const sql = getClient();

/**
 * OPTIONS /api/d/:did/members/leave - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /api/d/:did/members/leave - Leave a group conversation
 * Auth: caller must be an active member
 * - Sets left_at = now() (soft delete)
 * - Event conversations are disallowed (ticket = membership)
 * - If caller is owner and others remain: auto-promotes oldest active member to owner
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { identity } = authResult;
  const { did } = await params;

  try {
    // Only allow leaving group conversations (not events or DMs)
    if (!did.startsWith('did:imajin:group:')) {
      return errorResponse('You can only leave group conversations', 400, cors);
    }

    // Check caller is an active member
    const memberRows = await sql`
      SELECT role FROM chat.conversation_members
      WHERE conversation_did = ${did}
        AND member_did = ${identity.id}
        AND left_at IS NULL
      LIMIT 1
    `;

    if (memberRows.length === 0) {
      return errorResponse('You are not a member of this conversation', 403, cors);
    }

    const callerRole = memberRows[0].role as string;

    // If owner, promote the oldest other active member before leaving
    if (callerRole === 'owner') {
      const otherMembers = await sql`
        SELECT member_did FROM chat.conversation_members
        WHERE conversation_did = ${did}
          AND member_did != ${identity.id}
          AND left_at IS NULL
        ORDER BY joined_at ASC
        LIMIT 1
      `;

      if (otherMembers.length > 0) {
        await sql`
          UPDATE chat.conversation_members
          SET role = 'owner'
          WHERE conversation_did = ${did}
            AND member_did = ${otherMembers[0].member_did}
        `;
      }
      // If no other members, just leave — conversation becomes orphaned (fine, archived)
    }

    // Soft-delete: set left_at = now()
    await sql`
      UPDATE chat.conversation_members
      SET left_at = NOW()
      WHERE conversation_did = ${did}
        AND member_did = ${identity.id}
    `;

    return jsonResponse({ ok: true }, 200, cors);
  } catch (error) {
    console.error('Failed to leave conversation:', error);
    return errorResponse('Failed to leave conversation', 500, cors);
  }
}
