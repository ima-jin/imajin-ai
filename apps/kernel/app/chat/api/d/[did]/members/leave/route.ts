import { NextRequest } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse, generateId } from '@/src/lib/kernel/utils';
import { corsOptions, corsHeaders } from "@/src/lib/kernel/cors";
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

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
  const effectiveDid = identity.actingAs || identity.id;
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
        AND member_did = ${effectiveDid}
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
          AND member_did != ${effectiveDid}
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
        AND member_did = ${effectiveDid}
    `;

    publish('group.member.left', {
      issuer: effectiveDid,
      subject: effectiveDid,
      scope: 'chat',
      payload: { context_id: did, context_type: 'chat.group' },
    }).catch((err: unknown) => log.error({ err: String(err) }, 'Group member left publish error'));

    // Insert system message into the conversation timeline
    const systemMsgId = generateId('msg');
    const systemContent = JSON.stringify({ type: 'system', event: 'member_left', actorDid: effectiveDid, targetDid: effectiveDid });
    sql`
      INSERT INTO chat.messages_v2 (id, conversation_did, from_did, content, content_type, created_at)
      VALUES (${systemMsgId}, ${did}, ${effectiveDid}, ${systemContent}::jsonb, 'application/json', NOW())
    `.catch((err: unknown) => log.error({ err: String(err) }, 'System message insert error (member_left)'));

    return jsonResponse({ ok: true }, 200, cors);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to leave conversation');
    return errorResponse('Failed to leave conversation', 500, cors);
  }
}
