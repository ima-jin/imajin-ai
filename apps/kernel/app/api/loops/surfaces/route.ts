/** Authenticated, per-principal warn-only surface observations (#2405). */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { listLoopSurfaces } from '@/src/lib/loops/surface-query';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const effectiveDid = resolveActingDid(auth.identity);
  const { searchParams } = new URL(request.url);
  if (searchParams.getAll('principal').some((principal) => principal !== effectiveDid)) {
    return NextResponse.json(
      { error: 'principal must match the authenticated caller' },
      { status: 403, headers: cors },
    );
  }

  const limit = searchParams.get('limit');
  const surfaces = await listLoopSurfaces({
    principal: effectiveDid,
    loopId: searchParams.get('loopId'),
    limit: limit ? Number(limit) : undefined,
  });

  return NextResponse.json(surfaces, { headers: cors });
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
