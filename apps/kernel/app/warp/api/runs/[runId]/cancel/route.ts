/**
 * POST /warp/api/runs/{runId}/cancel (#1639)
 *
 * Kill a queued or in-progress run, using the caller's own sealed Warp Agent key.
 * Cancellation needs no extra scope: the key can only reach runs it created, so
 * "may I cancel this" and "may I see this" are the same question.
 *
 * No request body. Returns `{ runId, cancelled: true }`.
 *
 * Warp's refusals are passed through with their own status rather than flattened,
 * because they mean different things to the caller: 400 the run already ended,
 * 409 it is still PENDING and the cancel should be retried in a moment, 422 this
 * run type cannot be cancelled at all.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { cancelAgentRun } from '@/src/lib/warp/dispatch';
import { warpActingDid, warpRunId } from '@/src/lib/warp/route-context';
import { warpErrorResponse } from '@/src/lib/warp/route-errors';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function POST(request: NextRequest, props: { params: Promise<{ runId: string }> }) {
  const params = await props.params;
  const cors = corsHeaders(request);

  const acting = await warpActingDid(request, cors);
  if ('response' in acting) return acting.response;

  const run = warpRunId(params, cors);
  if ('response' in run) return run.response;

  try {
    const cancellation = await cancelAgentRun(acting.did, run.runId);
    return NextResponse.json(cancellation, { headers: cors });
  } catch (err) {
    log.error(
      { err: String(err), principalDid: acting.did, runId: run.runId },
      'Warp run cancel failed',
    );
    return warpErrorResponse(err, cors);
  }
}
