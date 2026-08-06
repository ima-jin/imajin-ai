/**
 * POST /warp/api/runs/{runId}/followups (#1639)
 *
 * Send a message to a run that is already going — mid-run course correction
 * instead of cancel-and-redispatch. Delivered with the caller's own sealed Warp
 * Agent key, so a DID can only talk to runs its own credential created.
 *
 * Body:
 *   {
 *     "message": "…",                    // required, non-empty
 *     "mode"?: "normal" | "plan" | "orchestrate"
 *   }
 *
 * Returns `{ runId, accepted: true }`. Acceptance is not application: Warp routes
 * the message according to whatever the run is doing, and the effect is observed
 * through `GET /warp/api/runs/{runId}`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { sendFollowup, type WarpFollowupMode } from '@/src/lib/warp/dispatch';
import { warpActingDid, warpRunId } from '@/src/lib/warp/route-context';
import { warpErrorResponse } from '@/src/lib/warp/route-errors';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function POST(request: NextRequest, { params }: { params: { runId: string } }) {
  const cors = corsHeaders(request);

  const acting = await warpActingDid(request, cors);
  if ('response' in acting) return acting.response;

  const run = warpRunId(params, cors);
  if ('response' in run) return run.response;

  let body: { message?: unknown; mode?: unknown };
  try {
    body = (await request.json()) as { message?: unknown; mode?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message.length === 0) {
    return NextResponse.json(
      { error: 'message must be a non-empty string' },
      { status: 400, headers: cors },
    );
  }

  // `mode` is left to the client library to validate against the closed set, so
  // the rule lives in one place for HTTP and MCP callers alike.
  const mode = typeof body.mode === 'string' ? (body.mode as WarpFollowupMode) : undefined;

  try {
    const ack = await sendFollowup(acting.did, run.runId, {
      message,
      ...(mode === undefined ? {} : { mode }),
    });
    return NextResponse.json(ack, { status: 202, headers: cors });
  } catch (err) {
    log.error(
      { err: String(err), principalDid: acting.did, runId: run.runId },
      'Warp run follow-up failed',
    );
    return warpErrorResponse(err, cors);
  }
}
