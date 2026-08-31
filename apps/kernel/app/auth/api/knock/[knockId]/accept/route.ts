/**
 * POST /auth/api/knock/:knockId/accept — mint-on-accept (#1883).
 *
 * Session-authenticated; only the declared target may accept. Zero grants:
 * this mints (or, for a returning multi-tenant agent keypair, reuses) an
 * identity and links it to the accepting principal — nothing more. Actual
 * authority is a separate, strictly user-push act via POST /auth/api/grants
 * (#1882): "Accept must never be optimized into accept+grant."
 */
import { NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@imajin/auth';
import { acceptKnock } from '@/src/lib/auth/knock';

export async function POST(request: Request, props: { params: Promise<{ knockId: string }> }) {
  const { knockId } = await props.params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  const requestedBy = authResult.identity.actingAs ?? authResult.identity.id;

  const result = await acceptKnock({ knockId, requestedBy });
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result.result);
}
