/**
 * GET /auth/api/knock/pending — the target-side review surface (#1883):
 * lists the authenticated principal's own pending, unexpired knocks.
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { listPendingKnocksForTarget } from '@/src/lib/auth/knock';

export async function GET(request: Request) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const targetDid = authResult.identity.actingAs ?? authResult.identity.id;

  const knocks = await listPendingKnocksForTarget(targetDid);
  return NextResponse.json({ knocks });
}
