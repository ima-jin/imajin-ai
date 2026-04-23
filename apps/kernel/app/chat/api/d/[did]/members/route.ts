import { NextRequest } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse, generateId } from '@/src/lib/kernel/utils';
import { corsOptions, corsHeaders } from "@/src/lib/kernel/cors";
import { publish } from '@imajin/bus';
import { lookupIdentity } from '@/src/lib/kernel/lookup';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

const sql = getClient();

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
      const effectiveDid = identity.actingAs || identity.id;

      const callerRows = await sql`
        SELECT role FROM chat.conversation_members
        WHERE conversation_did = ${did}
          AND member_did = ${effectiveDid}
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

      publish('group.member.added', {
        issuer: identity.id,
        subject: memberDid,
        scope: 'chat',
        payload: { context_id: did, context_type: 'chat.group' },
      }).catch((err: unknown) => log.error({ err: String(err) }, 'Group member added publish error'));

      // Insert system message into the conversation timeline
      const systemMsgId = generateId('msg');
      const systemContent = JSON.stringify({ type: 'system', event: 'member_added', actorDid: effectiveDid, targetDid: memberDid });
      sql`
        INSERT INTO chat.messages_v2 (id, conversation_did, from_did, content, content_type, created_at)
        VALUES (${systemMsgId}, ${did}, ${effectiveDid}, ${systemContent}::jsonb, 'application/json', NOW())
      `.catch((err: unknown) => log.error({ err: String(err) }, 'System message insert error (member_added)'));
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
    log.error({ err: String(error) }, 'Failed to add member');
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

    // Resolve names via identity lookup
    const members = await Promise.all(
      rows.map(async (row: Record<string, string>) => {
        try {
          const identity = await lookupIdentity(row.did);
          if (identity) {
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
    log.error({ err: String(error) }, 'Failed to get members');
    return errorResponse('Failed to get members', 500, cors);
  }
}
