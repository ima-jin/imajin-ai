/**
 * GET /warp/api/runs/{runId} (#1428)
 *
 * Surface a dispatched run's lifecycle state and `session_link` back to the
 * caller, read with the caller's own sealed Warp Agent key. A DID can therefore
 * only see runs its own credential created — cross-DID reads are not gated by a
 * check here, they are structurally impossible.
 *
 * Gated by the same `warp:dispatch` grant as dispatch itself: a run is only
 * visible to the credential that fired it, so there is nothing to grant
 * separately.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { getAgentRun } from '@/src/lib/warp/dispatch';
import { warpErrorResponse } from '@/src/lib/warp/route-errors';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(
  request: NextRequest,
  { params }: { params: { runId: string } },
) {
  const cors = corsHeaders(request);

  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const principalDid = resolveActingDid(auth.identity);

  const runId = params.runId?.trim() ?? '';
  if (runId.length === 0) {
    return NextResponse.json({ error: 'runId is required' }, { status: 400, headers: cors });
  }

  try {
    const run = await getAgentRun(principalDid, runId);
    return NextResponse.json(run, { headers: cors });
  } catch (err) {
    log.error({ err: String(err), principalDid, runId }, 'Warp run lookup failed');
    return warpErrorResponse(err, cors);
  }
}
