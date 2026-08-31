/**
 * DELETE /auth/api/grants/:grantId/capabilities/:capability — revoke a
 * single capability (#1882 item 4), leaving every other capability on the
 * grant — and the grant itself — untouched.
 *
 * Session-authenticated; only the delegator who issued the grant may revoke.
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { revokeGrantCapability } from '@/src/lib/auth/grants';

export async function DELETE(
  request: Request,
  props: { params: Promise<{ grantId: string; capability: string }> },
) {
  const { grantId, capability } = await props.params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
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
