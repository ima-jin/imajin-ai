/**
 * GET /warp/api/runs/{runId} (#1428, expanded in #1639)
 *
 * Surface a dispatched run back to the caller, read with the caller's own sealed
 * Warp Agent key. A DID can therefore only see runs its own credential created —
 * cross-DID reads are not gated by a check here, they are structurally impossible.
 *
 * Gated by the same `warp:dispatch` grant as dispatch itself: a run is only
 * visible to the credential that fired it, so there is nothing to grant
 * separately.
 *
 * As of #1639 the response carries everything Warp's run body holds except the
 * prompt — `createdAt`/`startedAt`/`updatedAt`, `runTime`, `statusMessage`,
 * `requestUsage`, and the run's `artifacts` (including PR url and branch) — for no
 * extra upstream call.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { getAgentRun } from '@/src/lib/warp/dispatch';
import { warpActingDid, warpRunId } from '@/src/lib/warp/route-context';
import { warpErrorResponse } from '@/src/lib/warp/route-errors';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest, props: { params: Promise<{ runId: string }> }) {
  const params = await props.params;
  const cors = corsHeaders(request);

  const acting = await warpActingDid(request, cors);
  if ('response' in acting) return acting.response;

  const run = warpRunId(params, cors);
  if ('response' in run) return run.response;

  try {
    const detail = await getAgentRun(acting.did, run.runId);
    return NextResponse.json(detail, { headers: cors });
  } catch (err) {
    log.error(
      { err: String(err), principalDid: acting.did, runId: run.runId },
      'Warp run lookup failed',
    );
    return warpErrorResponse(err, cors);
  }
}
