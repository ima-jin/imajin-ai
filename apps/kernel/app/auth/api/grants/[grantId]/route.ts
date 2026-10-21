/**
 * DELETE /auth/api/grants/:grantId — revoke an entire grant (#1882).
 *
 * Session-authenticated; only the delegator who issued the grant may revoke
 * it. Revocation is immediate — the next introspection check fails closed.
 */
import { NextResponse } from 'next/server';
import { authErrorResponse } from '@imajin/auth';
import { requireGrantPrincipal } from '@/src/lib/auth/grant-principal';
import { revokeGrant } from '@/src/lib/auth/grants';

export async function DELETE(request: Request, props: { params: Promise<{ grantId: string }> }) {
  const { grantId } = await props.params;

  const authResult = await requireGrantPrincipal(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  const requestedBy = authResult.identity.actingAs ?? authResult.identity.id;

  const result = await revokeGrant({ grantId, requestedBy, actorDid: authResult.identity.id });
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result);
}
