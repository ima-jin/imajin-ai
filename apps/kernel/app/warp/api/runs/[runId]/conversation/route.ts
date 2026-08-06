/**
 * GET /warp/api/runs/{runId}/conversation (#1639)
 *
 * Warp's normalized view of what a run actually did — ordered messages, tool
 * calls with their results, and lifecycle events, grouped into steps. Where the
 * transcript is for a human to read, this is the shape a program walks.
 *
 * Read with the caller's own sealed Agent key, so only their own runs resolve.
 *
 * Returns `{ runId, conversationId, steps }`. The step tree is Warp's own shape,
 * passed through — see `WarpConversationBlock`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { getAgentRunConversation } from '@/src/lib/warp/dispatch';
import { warpActingDid, warpRunId } from '@/src/lib/warp/route-context';
import { warpErrorResponse } from '@/src/lib/warp/route-errors';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest, { params }: { params: { runId: string } }) {
  const cors = corsHeaders(request);

  const acting = await warpActingDid(request, cors);
  if ('response' in acting) return acting.response;

  const run = warpRunId(params, cors);
  if ('response' in run) return run.response;

  try {
    const conversation = await getAgentRunConversation(acting.did, run.runId);
    return NextResponse.json(conversation, { headers: cors });
  } catch (err) {
    log.error(
      { err: String(err), principalDid: acting.did, runId: run.runId },
      'Warp run conversation read failed',
    );
    return warpErrorResponse(err, cors);
  }
}
