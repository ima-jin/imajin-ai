import { NextRequest, NextResponse } from 'next/server';
import { db, identities, groupControllers, profiles } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');
const VALID_SCOPES = ['business', 'community', 'family'];

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

    if (!membership) {
      return NextResponse.json({ error: 'Not a controller of this group' }, { status: 403 });
    }

    const [ownerRow] = await db
      .select({ controllerDid: groupControllers.controllerDid, addedAt: groupControllers.addedAt })
      .from(groupControllers)
      .where(and(eq(groupControllers.groupDid, groupDid), eq(groupControllers.role, 'owner'), isNull(groupControllers.removedAt)))
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

    const controllers = await db
      .select({
        controllerDid: groupControllers.controllerDid,
        role: groupControllers.role,
        addedBy: groupControllers.addedBy,
        addedAt: groupControllers.addedAt,
      })
      .from(groupControllers)
      .where(
        and(
          eq(groupControllers.groupDid, groupDid),
          isNull(groupControllers.removedAt)
        )
      );

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
