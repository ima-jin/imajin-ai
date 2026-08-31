/**
 * POST /auth/api/knock/:knockId/decline — discard a pending knock (#1883).
 *
 * Session-authenticated; only the declared target may decline. No identity
 * was ever created, so decline is a pure state transition — nothing to
 * undo.
 */
import { NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@imajin/auth';
import { declineKnock } from '@/src/lib/auth/knock';

export async function POST(request: Request, props: { params: Promise<{ knockId: string }> }) {
  const { knockId } = await props.params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  const requestedBy = authResult.identity.actingAs ?? authResult.identity.id;

  const result = await declineKnock({ knockId, requestedBy });
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result);
}
