import { NextRequest, NextResponse } from 'next/server';
import { db, groupControllers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth, emitAttestation } from '@imajin/auth';

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
    .select({ role: groupControllers.role })
    .from(groupControllers)
    .where(
      and(
        eq(groupControllers.groupDid, groupDid),
        eq(groupControllers.controllerDid, caller.id),
        isNull(groupControllers.removedAt)
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
    .select({ role: groupControllers.role })
    .from(groupControllers)
    .where(
      and(
        eq(groupControllers.groupDid, groupDid),
        eq(groupControllers.controllerDid, controllerDid),
        isNull(groupControllers.removedAt)
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
      .update(groupControllers)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(groupControllers.groupDid, groupDid),
          eq(groupControllers.controllerDid, controllerDid)
        )
      );

    emitAttestation({
      issuer_did: caller.id,
      subject_did: controllerDid,
      type: 'group.member.removed',
      context_id: groupDid,
      context_type: 'group',
      payload: {},
    }).catch((err) => console.error('[groups] Attestation failed (non-fatal):', err));

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[groups] Remove controller error:', error);
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
        role: groupControllers.role,
        removedAt: groupControllers.removedAt,
        allowedServices: groupControllers.allowedServices,
      })
      .from(groupControllers)
      .where(
        and(
          eq(groupControllers.groupDid, groupDid),
          eq(groupControllers.controllerDid, controllerDid),
          isNull(groupControllers.removedAt)
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
    console.error('[groups] Controller check error:', error);
    return NextResponse.json({ error: 'Failed to check controller' }, { status: 500 });
  }
}
