/**
 * `GET /api/loops/{loopId}` — one loop's current-state projection plus its
 * ordered event history (#2295, epic #2288/#2290).
 *
 * Same per-principal scoping as `GET /api/loops`: a loop that exists but
 * belongs to a different principal is reported as 404, identical to one
 * that doesn't exist at all — never confirms existence to a caller who
 * isn't allowed to see it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { getLoopWithHistory } from '@/src/lib/loops/query';

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest, props: { params: Promise<{ loopId: string }> }) {
  const params = await props.params;
  const cors = corsHeaders(request);

  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const effectiveDid = resolveActingDid(auth.identity);

  const loopId = params.loopId?.trim() ?? '';
  if (loopId.length === 0) {
    return NextResponse.json({ error: 'loopId is required' }, { status: 400, headers: cors });
  }

  const result = await getLoopWithHistory(loopId, effectiveDid);
  if (!result) {
    return NextResponse.json({ error: 'Not found' }, { status: 404, headers: cors });
  }

  return NextResponse.json(result, { headers: cors });
}
