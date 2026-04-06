import { NextRequest, NextResponse } from 'next/server';
import { db, groupControllers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth, emitAttestation } from '@imajin/auth';

const VALID_ROLES = ['owner', 'admin', 'member'];

/**
 * POST /api/groups/[groupDid]/controllers
 * Add a controller to the group. Caller must be owner or admin.
 * Only owner can add admins.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ groupDid: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity: caller } = authResult;
  const { groupDid } = await params;

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
    return NextResponse.json({ error: 'Must be owner or admin to add controllers' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { did, role = 'member', allowedServices = null } = body as {
    did?: string;
    role?: string;
    allowedServices?: string[] | null;
  };

  if (!did || typeof did !== 'string') {
    return NextResponse.json({ error: 'did required' }, { status: 400 });
  }
  if (!VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` }, { status: 400 });
  }
  if (role === 'admin' && callerMembership.role !== 'owner') {
    return NextResponse.json({ error: 'Only owner can add admins' }, { status: 403 });
  }

  try {
    // Check if controller was previously removed (soft delete)
    const [existing] = await db
      .select({ removedAt: groupControllers.removedAt, role: groupControllers.role })
      .from(groupControllers)
      .where(
        and(
          eq(groupControllers.groupDid, groupDid),
          eq(groupControllers.controllerDid, did)
        )
      )
      .limit(1);

    if (existing && !existing.removedAt) {
      return NextResponse.json({ error: 'Already a controller' }, { status: 409 });
    }

    if (existing && existing.removedAt) {
      // Reactivate
      await db
        .update(groupControllers)
        .set({ removedAt: null, role, allowedServices, addedBy: caller.id, addedAt: new Date() })
        .where(
          and(
            eq(groupControllers.groupDid, groupDid),
            eq(groupControllers.controllerDid, did)
          )
        );
    } else {
      await db.insert(groupControllers).values({
        groupDid,
        controllerDid: did,
        role,
        allowedServices,
        addedBy: caller.id,
      });
    }

    emitAttestation({
      issuer_did: caller.id,
      subject_did: did,
      type: 'group.member.added',
      context_id: groupDid,
      context_type: 'group',
      payload: { role },
    }).catch((err) => console.error('[groups] Attestation failed (non-fatal):', err));

    return NextResponse.json({ ok: true, groupDid, controllerDid: did, role }, { status: 201 });
  } catch (error) {
    console.error('[groups] Add controller error:', error);
    return NextResponse.json({ error: 'Failed to add controller' }, { status: 500 });
  }
}
