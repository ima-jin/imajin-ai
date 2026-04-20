import { NextRequest } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse, generateId } from '@/src/lib/kernel/utils';
import { corsOptions, corsHeaders } from "@/src/lib/kernel/cors";
import { notify } from '@imajin/notify';
import { emitAttestation } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

const sql = getClient();

/**
 * OPTIONS /api/d/:did/members/:memberDid - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * DELETE /api/d/:did/members/:memberDid - Remove a member from a group conversation
 * Auth: caller must be owner or admin
 * - Cannot remove yourself (use leave instead)
 * - Admins cannot remove other admins or owners
 * - Sets left_at = now() on the target member (soft delete)
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ did: string; memberDid: string }> }
) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status, cors);
  }

  const { identity } = authResult;
  const effectiveDid = identity.actingAs || identity.id;
  const { did, memberDid } = await params;

  try {
    // Cannot remove yourself — use leave instead
    if (memberDid === effectiveDid) {
      return errorResponse('Cannot remove yourself — use the leave endpoint instead', 400, cors);
    }

    // Check caller is an active member with owner or admin role
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
      return errorResponse('Only owners and admins can remove members', 403, cors);
    }

    // Check the target member exists and is active
    const targetRows = await sql`
      SELECT role FROM chat.conversation_members
      WHERE conversation_did = ${did}
        AND member_did = ${memberDid}
        AND left_at IS NULL
      LIMIT 1
    `;

    if (targetRows.length === 0) {
      return errorResponse('Member not found', 404, cors);
    }

    const targetRole = targetRows[0].role as string;

    // Admins cannot remove other admins or owners — only owners can
    if (callerRole === 'admin' && (targetRole === 'admin' || targetRole === 'owner')) {
      return errorResponse('Admins cannot remove other admins or owners', 403, cors);
    }

    // Soft-delete: set left_at = now()
    await sql`
      UPDATE chat.conversation_members
      SET left_at = NOW()
      WHERE conversation_did = ${did}
        AND member_did = ${memberDid}
    `;

    notify.interest({ did: memberDid, attestationType: 'group.member.removed' })
      .catch((err: unknown) => log.error({ err: String(err) }, 'Interest signal error'));

    emitAttestation({
      issuer_did: identity.id,
      subject_did: memberDid,
      type: 'group.member.removed',
      context_id: did,
      context_type: 'chat.group',
    }).catch((err: unknown) => log.error({ err: String(err) }, 'Attestation (group.member.removed) error'));

    // Insert system message into the conversation timeline
    const systemMsgId = generateId('msg');
    const systemContent = JSON.stringify({ type: 'system', event: 'member_removed', actorDid: effectiveDid, targetDid: memberDid });
    sql`
      INSERT INTO chat.messages_v2 (id, conversation_did, from_did, content, content_type, created_at)
      VALUES (${systemMsgId}, ${did}, ${effectiveDid}, ${systemContent}::jsonb, 'application/json', NOW())
    `.catch((err: unknown) => log.error({ err: String(err) }, 'System message insert error (member_removed)'));

    return jsonResponse({ ok: true }, 200, cors);
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to remove member');
    return errorResponse('Failed to remove member', 500, cors);
  }
}
