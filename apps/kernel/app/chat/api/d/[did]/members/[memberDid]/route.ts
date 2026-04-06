import { NextRequest } from 'next/server';
import { getClient } from '@imajin/db';
import { requireAuth } from '@imajin/auth';
import { jsonResponse, errorResponse, corsHeaders, corsOptions } from '@/src/lib/kernel/utils';
import { notify } from '@imajin/notify';
import { emitAttestation } from '@imajin/auth';

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
      .catch((err: unknown) => console.error('Interest signal error:', err));

    emitAttestation({
      issuer_did: identity.id,
      subject_did: memberDid,
      type: 'group.member.removed',
      context_id: did,
      context_type: 'chat.group',
    }).catch((err: unknown) => console.error('Attestation (group.member.removed) error:', err));

    return jsonResponse({ ok: true }, 200, cors);
  } catch (error) {
    console.error('Failed to remove member:', error);
    return errorResponse('Failed to remove member', 500, cors);
  }
}
