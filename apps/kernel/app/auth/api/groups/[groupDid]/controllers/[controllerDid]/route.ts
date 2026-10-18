import { NextRequest, NextResponse } from 'next/server';
import { db, identityMembers } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { requireInternalApiKey } from '@/src/lib/auth/require-internal-api-key';
import { removeGroupController } from '@/src/lib/auth/remove-group-controller';
import { OwnershipError } from '@/src/lib/auth/ownership-policy';
import { updateGroupMember } from '@/src/lib/auth/update-group-member';

const log = createLogger('kernel');
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/groups/[groupDid]/controllers/[controllerDid]
 * Remove a controller (soft delete).
 * Owners cannot be removed. Admins may remove members or leave themselves.
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


  try {
    await removeGroupController(groupDid, caller, controllerDid);

    const response = NextResponse.json({ ok: true });
    if (caller.id === controllerDid && request.cookies.get('x-acting-as')?.value === groupDid) {
      response.cookies.set('x-acting-as', '', { path: '/', maxAge: 0, sameSite: 'lax' });
    }
    return response;
  } catch (error) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    log.error({ err: String(error) }, '[groups] Remove controller error');
    return NextResponse.json({ error: 'Failed to remove controller' }, { status: 500 });
  }
}
/** PATCH edits an existing member, never ownership or membership provenance. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ groupDid: string; controllerDid: string }> }
) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { groupDid, controllerDid } = await params;
  try {
    return NextResponse.json(await updateGroupMember(groupDid, auth.identity, controllerDid, body));
  } catch (error) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    log.error({ err: String(error) }, '[groups] Edit member error');
    return NextResponse.json({ error: 'Failed to edit member' }, { status: 500 });
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
  const authError = await requireInternalApiKey(request);
  if (authError) return authError;

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
