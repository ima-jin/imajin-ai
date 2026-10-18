import { NextRequest, NextResponse } from 'next/server';
import { db, identities, identityMembers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { MEMBER_ROLES } from '@/src/lib/auth/membership';
import { recordMemberEvent } from '@/src/lib/auth/member-attestation';
import { parseMemberServices } from '@/src/lib/auth/member-service-scope';
import { OwnershipError } from '@/src/lib/auth/ownership-policy';

const log = createLogger('kernel');

const VALID_ROLES: readonly string[] = MEMBER_ROLES;

interface AddControllerRequest {
  did: string;
  role: string;
  /** null = full access for any non-owner authority role. */
  allowedServices: string[] | null;
}

/**
 * Validate an add-controller payload against the caller's own role.
 *
 * Returns the normalized request, or a NextResponse to return verbatim.
 */
function parseAddControllerBody(
  body: Record<string, unknown>,
  callerRole: string
): AddControllerRequest | NextResponse {
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
  if (role === 'owner') {
    return NextResponse.json({ error: 'Ownership cannot be granted from here' }, { status: 400 });
  }
  if (role === 'admin' && callerRole !== 'owner') {
    return NextResponse.json({ error: 'Only owner can add admins' }, { status: 403 });
  }

  const scoped = parseMemberServices(allowedServices);

  return { did, role, allowedServices: scoped };
}

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
  return db.transaction(async (tx) => {
    await tx.select({ id: identities.id }).from(identities).where(eq(identities.id, groupDid)).for('update');
    const [callerMembership] = await tx
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
      return NextResponse.json({ error: 'Must be owner or admin to add controllers' }, { status: 403 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const parsed = parseAddControllerBody(body, callerMembership.role);
    if (parsed instanceof NextResponse) return parsed;
    const { did, role, allowedServices: normalizedServices } = parsed;

    // An agent adding members under X-Acting-For is programmatic provenance;
    // anything else came from a controller clicking Add in the UI.
    const addedVia = caller.actingFor === groupDid ? 'agent' : 'direct';

    // Check if controller was previously removed (soft delete)
    const [existing] = await tx
      .select({
        removedAt: identityMembers.removedAt,
        role: identityMembers.role,
        allowedServices: identityMembers.allowedServices,
      })
      .from(identityMembers)
      .where(
        and(
          eq(identityMembers.identityDid, groupDid),
          eq(identityMembers.memberDid, did)
        )
      )
      .limit(1);

    if (existing && !existing.removedAt) {
      return NextResponse.json({ error: 'Already a controller' }, { status: 409 });
    }

    if (existing?.removedAt) {
      // Reactivate
      await tx
        .update(identityMembers)
        .set({
          removedAt: null,
          role,
          allowedServices: normalizedServices,
          addedBy: caller.id,
          addedVia,
          addedAt: new Date(),
        })
        .where(
          and(
            eq(identityMembers.identityDid, groupDid),
            eq(identityMembers.memberDid, did)
          )
        );
    } else {
      await tx.insert(identityMembers).values({
        identityDid: groupDid,
        memberDid: did,
        role,
        allowedServices: normalizedServices,
        addedBy: caller.id,
        addedVia,
      });
    }

    await recordMemberEvent(tx, 'group.member.added', groupDid, did, caller, {
      role, added_via: addedVia,
      oldAllowedServices: existing?.allowedServices ?? null,
      allowedServices: normalizedServices,
    });

    return NextResponse.json(
      { ok: true, identityDid: groupDid, memberDid: did, role, addedVia, allowedServices: normalizedServices },
      { status: 201 }
    );
  }).catch((error) => {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    log.error({ err: String(error) }, '[groups] Add controller error');
    return NextResponse.json({ error: 'Failed to add controller' }, { status: 500 });
  });
}
