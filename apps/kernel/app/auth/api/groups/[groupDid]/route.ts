import { NextRequest, NextResponse } from 'next/server';
import { db, identities, identityMembers, profiles } from '@/src/db';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { isMemberAddedVia } from '@/src/lib/auth/membership';

const log = createLogger('kernel');
const VALID_SCOPES = ['business', 'community', 'family'];

interface ResolvedIdentity {
  did: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  scope: string | null;
  subtype: string | null;
}

/**
 * Resolve a set of DIDs to their display identity in one query.
 *
 * Members are stored as bare DIDs, which tells a human nothing. Rather than
 * making the client fan out to `/auth/api/lookup/:did` once per row, resolve
 * them here and return names alongside the membership rows.
 */
async function resolveIdentities(dids: string[]): Promise<Map<string, ResolvedIdentity>> {
  const unique = [...new Set(dids.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const rows = await db
    .select({
      did: identities.id,
      name: identities.name,
      handle: identities.handle,
      avatarUrl: identities.avatarUrl,
      scope: identities.scope,
      subtype: identities.subtype,
    })
    .from(identities)
    .where(inArray(identities.id, unique));

  return new Map(rows.map((r) => [r.did, r]));
}

/**
 * GET /api/groups/[groupDid]
 * Get group details. Caller must be an active controller.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ groupDid: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity: caller } = authResult;
  const { groupDid } = await params;

  try {
    // Check caller is active controller
    const [membership] = await db
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

    if (!membership) {
      return NextResponse.json({ error: 'Not a controller of this group' }, { status: 403 });
    }

    const [ownerRow] = await db
      .select({ controllerDid: identityMembers.memberDid, addedAt: identityMembers.addedAt })
      .from(identityMembers)
      .where(and(eq(identityMembers.identityDid, groupDid), eq(identityMembers.role, 'owner'), isNull(identityMembers.removedAt)))
      .limit(1);

    const [group] = await db
      .select({
        groupDid: identities.id,
        scope: identities.scope,
        createdAt: identities.createdAt,
        name: identities.name,
        handle: identities.handle,
      })
      .from(identities)
      .where(eq(identities.id, groupDid))
      .limit(1);

    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 });
    }

    const memberRows = await db
      .select({
        controllerDid: identityMembers.memberDid,
        role: identityMembers.role,
        addedBy: identityMembers.addedBy,
        addedVia: identityMembers.addedVia,
        addedAt: identityMembers.addedAt,
        allowedServices: identityMembers.allowedServices,
      })
      .from(identityMembers)
      .where(
        and(
          eq(identityMembers.identityDid, groupDid),
          isNull(identityMembers.removedAt)
        )
      );

    const resolved = await resolveIdentities(
      memberRows.flatMap((m) => [m.controllerDid, m.addedBy ?? '']),
    );

    const controllers = memberRows.map((m) => {
      const member = resolved.get(m.controllerDid) ?? null;
      const addedByIdentity = m.addedBy ? (resolved.get(m.addedBy) ?? null) : null;
      return {
        ...m,
        // `added_via` is free-form TEXT in the DB; only surface known values so
        // the client never renders a chip for something it cannot explain.
        addedVia: isMemberAddedVia(m.addedVia) ? m.addedVia : null,
        name: member?.name ?? null,
        handle: member?.handle ?? null,
        avatarUrl: member?.avatarUrl ?? null,
        subtype: member?.subtype ?? null,
        scope: member?.scope ?? null,
        addedByName: addedByIdentity?.name ?? null,
        addedByHandle: addedByIdentity?.handle ?? null,
      };
    });

    return NextResponse.json({ ...group, createdBy: ownerRow?.controllerDid ?? null, controllers });
  } catch (error) {
    log.error({ err: String(error) }, '[groups] Get error');
    return NextResponse.json({ error: 'Failed to get group' }, { status: 500 });
  }
}

/**
 * PATCH /api/groups/[groupDid]
 * Update group (name, description, scope). Caller must be owner or admin.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ groupDid: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity: caller } = authResult;
  const { groupDid } = await params;

  const [membership] = await db
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

  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Must be owner or admin' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { name, description, scope } = body as { name?: string; description?: string; scope?: string };

  if (scope && !VALID_SCOPES.includes(scope)) {
    return NextResponse.json({ error: `scope must be one of: ${VALID_SCOPES.join(', ')}` }, { status: 400 });
  }

  try {
    if (name) {
      await db
        .update(identities)
        .set({ name: name.trim().slice(0, 100), updatedAt: new Date() })
        .where(eq(identities.id, groupDid));

      // Update profile (fire-and-forget)
      try {
        await db
          .update(profiles)
          .set({ displayName: name.trim().slice(0, 100), bio: description || null, updatedAt: new Date() })
          .where(eq(profiles.did, groupDid));
      } catch (err) {
        log.error({ err: String(err) }, '[groups] Profile update failed (non-fatal)');
      }
    }

    if (scope) {
      await db
        .update(identities)
        .set({ scope, updatedAt: new Date() })
        .where(eq(identities.id, groupDid));
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    log.error({ err: String(error) }, '[groups] Update error');
    return NextResponse.json({ error: 'Failed to update group' }, { status: 500 });
  }
}
