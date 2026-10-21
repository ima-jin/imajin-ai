/**
 * POST /auth/api/grants/:grantId/renew — extend a grant's lease (#1882 item 4:
 * "grants are leases with expiry").
 *
 * Session-authenticated; only the delegator who issued the grant may renew,
 * and only while it is still active — a revoked grant must be re-issued, not
 * resurrected via renewal.
 *
 * Body: { ttlMs?: number }  // positive TTL capped at max; absent preserves the last lease
 */
import { NextResponse } from 'next/server';
import { authErrorResponse } from '@imajin/auth';
import { requireGrantPrincipal } from '@/src/lib/auth/grant-principal';
import { renewGrant } from '@/src/lib/auth/grants';

export async function POST(request: Request, props: { params: Promise<{ grantId: string }> }) {
  const { grantId } = await props.params;

  const authResult = await requireGrantPrincipal(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  const requestedBy = authResult.identity.actingAs ?? authResult.identity.id;

  let ttlMs: number | undefined;
  try {
    const text = await request.text();
    const body = text.trim() ? JSON.parse(text) : {};
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Body must be an object' }, { status: 400 });
    }
    if (body.ttlMs !== undefined) {
      if (typeof body.ttlMs !== 'number' || !Number.isFinite(body.ttlMs) || body.ttlMs <= 0) {
        return NextResponse.json({ error: 'ttlMs must be a positive finite number' }, { status: 400 });
      }
      ttlMs = body.ttlMs;
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const result = await renewGrant({ grantId, requestedBy, actorDid: authResult.identity.id, ttlMs });
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ grant: result });
}
