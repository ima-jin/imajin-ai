/**
 * DELETE /auth/api/grants/:grantId/capabilities/:capability — revoke a
 * single capability (#1882 item 4), leaving every other capability on the
 * grant — and the grant itself — untouched.
 *
 * PUT /auth/api/grants/:grantId/capabilities/:capability — add a single
 * capability to an existing, active grant (#2108), the additive mirror of
 * the DELETE above. No request body: the capability comes entirely from the
 * path, exactly like DELETE. Idempotent — adding a capability the grant
 * already actively holds is a no-op 200.
 *
 * Both verbs are session-authenticated; only the delegator who issued the
 * grant may revoke or add capabilities on it.
 */
import { NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@imajin/auth';
import { revokeGrantCapability, addGrantCapability } from '@/src/lib/auth/grants';

export async function DELETE(
  request: Request,
  props: { params: Promise<{ grantId: string; capability: string }> },
) {
  const { grantId, capability } = await props.params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  const requestedBy = authResult.identity.actingAs ?? authResult.identity.id;

  const result = await revokeGrantCapability({
    grantId,
    capability: decodeURIComponent(capability),
    requestedBy,
  });
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result);
}

export async function PUT(
  request: Request,
  props: { params: Promise<{ grantId: string; capability: string }> },
) {
  const { grantId, capability } = await props.params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  const requestedBy = authResult.identity.actingAs ?? authResult.identity.id;

  const result = await addGrantCapability({
    grantId,
    capability: decodeURIComponent(capability),
    requestedBy,
  });
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result);
}
