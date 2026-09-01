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
 *     "mode"?: "normal" | "plan" | "orchestrate",
 *     "resume"?: boolean                  // continue a terminal run via handoff (#1939)
 *   }
 *
 * Returns `{ runId, accepted: true }`. Acceptance is not application: Warp routes
 * the message according to whatever the run is doing, and the effect is observed
 * through `GET /warp/api/runs/{runId}`.
 *
 * A terminal run is refused with 409 `warp_run_terminal` unless `resume: true`
 * is given (#1939) — refusal-by-default, so a follow-up cannot accidentally wake
 * a finished run back up. With `resume: true`, the follow-up is proxied to
 * Warp's cloud-to-cloud handoff and the resume is recorded on the kernel run
 * record as a `warp.run.resumed` bus event.
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

export async function POST(request: NextRequest, props: { params: Promise<{ runId: string }> }) {
  const params = await props.params;
  const cors = corsHeaders(request);

  const acting = await warpActingDid(request, cors);
  if ('response' in acting) return acting.response;

  const run = warpRunId(params, cors);
  if ('response' in run) return run.response;

  let body: { message?: unknown; mode?: unknown; resume?: unknown };
  try {
    body = (await request.json()) as { message?: unknown; mode?: unknown; resume?: unknown };
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
  const resume = typeof body.resume === 'boolean' ? body.resume : undefined;

  try {
    const ack = await sendFollowup(acting.did, run.runId, {
      message,
      ...(mode === undefined ? {} : { mode }),
      ...(resume === undefined ? {} : { resume }),
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
