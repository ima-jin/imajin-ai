/**
 * POST /auth/api/grants/:grantId/renew — extend a grant's lease (#1882 item 4:
 * "grants are leases with expiry").
 *
 * Session-authenticated; only the delegator who issued the grant may renew,
 * and only while it is still active — a revoked grant must be re-issued, not
 * resurrected via renewal.
 *
 * Body: { ttlMs?: number }  // clamped to [default, max] lease bounds
 */
import { NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@imajin/auth';
import { renewGrant } from '@/src/lib/auth/grants';

export async function POST(request: Request, props: { params: Promise<{ grantId: string }> }) {
  const { grantId } = await props.params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  const requestedBy = authResult.identity.actingAs ?? authResult.identity.id;

  let ttlMs: number | undefined;
  try {
    const body = await request.json();
    if (typeof body?.ttlMs === 'number') ttlMs = body.ttlMs;
  } catch {
    // Empty/absent body is fine — renewal falls back to the default TTL.
  }

  const result = await renewGrant({ grantId, requestedBy, ttlMs });
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ grant: result });
}
