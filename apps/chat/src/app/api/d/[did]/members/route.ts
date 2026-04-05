import { NextRequest } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAuth } from '@/lib/auth';
import { jsonResponse, errorResponse, corsHeaders, corsOptions } from '@/lib/utils';
import { notify } from '@imajin/notify';

export const dynamic = 'force-dynamic';

const sql = getClient();
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

/**
 * OPTIONS /api/d/:did/members - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /api/d/:did/members - Add a member to a conversation
 * Body: { memberDid: string, role?: string }
 *
 * For group conversations (did:imajin:group:*): requires auth and owner/admin role.
 * For event chats: no auth required (webhook-friendly for ticket sync).
 *
 * If re-adding someone who previously left: clears left_at and updates joined_at.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  const { did } = await params;

  try {
    const body = await request.json();
    const { memberDid, role = 'member' } = body;

    if (!memberDid) {
      return errorResponse('memberDid is required', 400, cors);
    }

    const isGroup = did.startsWith('did:imajin:group:');

    if (isGroup) {
      // Group management requires authentication and owner/admin role
      const authResult = await requireAuth(request);
      if ('error' in authResult) {
        return errorResponse(authResult.error, authResult.status, cors);
      }

      const { identity } = authResult;

      const callerRows = await sql`
        SELECT role FROM chat.conversation_members
        WHERE conversation_did = ${did}
          AND member_did = ${identity.id}
          AND left_at IS NULL
        LIMIT 1
      `;

      if (callerRows.length === 0) {
        return errorResponse('You are not a member of this conversation', 403, cors);
      }

      const callerRole = callerRows[0].role as string;
      if (callerRole !== 'owner' && callerRole !== 'admin') {
        return errorResponse('Only owners and admins can add members', 403, cors);
      }

      // Add or re-activate member (clear left_at if they previously left)
      await sql`
        INSERT INTO chat.conversation_members (conversation_did, member_did, role, joined_at)
        VALUES (${did}, ${memberDid}, ${role}, NOW())
        ON CONFLICT (conversation_did, member_did)
          DO UPDATE SET left_at = NULL, joined_at = NOW()
          WHERE chat.conversation_members.left_at IS NOT NULL
      `;

      notify.interest({ did: memberDid, attestationType: 'group.member.added' })
        .catch((err: unknown) => console.error('Interest signal error:', err));
    } else {
      // Webhook / event-chat mode: no auth required
      // Ensure conversation exists (event chats may not exist yet)
      await sql`
        INSERT INTO chat.conversations_v2 (did, type, name, created_at, updated_at)
        VALUES (${did}, 'group', '', NOW(), NOW())
        ON CONFLICT (did) DO NOTHING
      `;

      // Add or re-activate member
      await sql`
        INSERT INTO chat.conversation_members (conversation_did, member_did, role, joined_at)
        VALUES (${did}, ${memberDid}, ${role}, NOW())
        ON CONFLICT (conversation_did, member_did)
          DO UPDATE SET left_at = NULL, joined_at = NOW()
          WHERE chat.conversation_members.left_at IS NOT NULL
      `;
    }

    return jsonResponse({ ok: true, did, memberDid, role }, 200, cors);
  } catch (error) {
    console.error('Failed to add member:', error);
    return errorResponse('Failed to add member', 500, cors);
  }
}

/**
 * GET /api/d/:did/members - Get members of a conversation via pod membership
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { did } = await params;

  try {
    // Get members from chat.conversation_members
    const rows = await sql`
      SELECT member_did as did, role
      FROM chat.conversation_members
      WHERE conversation_did = ${did}
        AND left_at IS NULL
      ORDER BY role DESC, joined_at ASC
    `;

    // Resolve names via auth lookup
    const members = await Promise.all(
      rows.map(async (row: Record<string, string>) => {
        try {
          const res = await fetch(
            `${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(row.did)}`
          );
          if (res.ok) {
            const data = await res.json();
            const identity = data.identity || data;
            return {
              did: row.did,
              role: row.role,
              name: identity.name || null,
              handle: identity.handle || null,
            };
          }
        } catch {}
        return { did: row.did, role: row.role, name: null, handle: null };
      })
    );

    return jsonResponse({ members, count: members.length }, 200, cors);
  } catch (error) {
    console.error('Failed to get members:', error);
    return errorResponse('Failed to get members', 500, cors);
  }
}
