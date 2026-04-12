import { NextRequest, NextResponse } from 'next/server';
import { db, identityMembers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth, emitAttestation } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * DELETE /api/groups/[groupDid]/controllers/[controllerDid]
 * Remove a controller (soft delete).
 * Owner can remove anyone (except self). Admin can remove members only.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ groupDid: string; controllerDid: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity: caller } = authResult;
  const { groupDid, controllerDid } = await params;

  const [callerMembership] = await db
    .select({ role: identityMembers.role })
    .from(identityMembers)
    .where(
      and(
        eq(identityMembers.identityDid, groupDid),
        eq(identityMembers.memberDid, caller.id),
        isNull(identityMembers.removedAt)
      )
    )
    .limit(1);

  if (!callerMembership || !['owner', 'admin'].includes(callerMembership.role)) {
    return NextResponse.json({ error: 'Must be owner or admin to remove controllers' }, { status: 403 });
  }

  if (callerMembership.role === 'owner' && caller.id === controllerDid) {
    return NextResponse.json({ error: 'Owner cannot remove themselves' }, { status: 400 });
  }

  // Check target's role
  const [targetMembership] = await db
    .select({ role: identityMembers.role })
    .from(identityMembers)
    .where(
      and(
        eq(identityMembers.identityDid, groupDid),
        eq(identityMembers.memberDid, controllerDid),
        isNull(identityMembers.removedAt)
      )
    )
    .limit(1);

  if (!targetMembership) {
    return NextResponse.json({ error: 'Controller not found' }, { status: 404 });
  }

  if (callerMembership.role === 'admin' && targetMembership.role !== 'member') {
    return NextResponse.json({ error: 'Admin can only remove members' }, { status: 403 });
  }

  try {
    await db
      .update(identityMembers)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(identityMembers.identityDid, groupDid),
          eq(identityMembers.memberDid, controllerDid)
        )
      );

    emitAttestation({
      issuer_did: caller.id,
      subject_did: controllerDid,
      type: 'group.member.removed',
      context_id: groupDid,
      context_type: 'group',
      payload: {},
    }).catch((err) => log.error({ err: String(err) }, '[groups] Attestation failed (non-fatal)'));

    return NextResponse.json({ ok: true });
  } catch (error) {
    log.error({ err: String(error) }, '[groups] Remove controller error');
    return NextResponse.json({ error: 'Failed to remove controller' }, { status: 500 });
  }
}

/**
 * GET /api/groups/[groupDid]/controllers/[controllerDid]
 * Internal: check if a DID is an active controller with owner or admin role.
 * Used by act-as middleware validation.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ groupDid: string; controllerDid: string }> }
) {
  const { groupDid, controllerDid } = await params;

  // This endpoint is internal — validate via ATTESTATION_INTERNAL_API_KEY
  const apiKey = request.headers.get('authorization')?.replace('Bearer ', '');
  const expectedKey = process.env.ATTESTATION_INTERNAL_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [membership] = await db
      .select({
        role: identityMembers.role,
        removedAt: identityMembers.removedAt,
        allowedServices: identityMembers.allowedServices,
      })
      .from(identityMembers)
      .where(
        and(
          eq(identityMembers.identityDid, groupDid),
          eq(identityMembers.memberDid, controllerDid),
          isNull(identityMembers.removedAt)
        )
      )
      .limit(1);

    if (!membership) {
      return NextResponse.json({ valid: false }, { status: 200 });
    }

    return NextResponse.json({
      valid: true,
      role: membership.role,
      allowedServices: membership.allowedServices ?? null, // null = full access
    });
  } catch (error) {
    log.error({ err: String(error) }, '[groups] Controller check error');
    return NextResponse.json({ error: 'Failed to check controller' }, { status: 500 });
  }
}
