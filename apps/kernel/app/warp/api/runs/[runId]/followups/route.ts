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
 *
 * ## Re-arming the watch for the resumed segment (#2055)
 * Before this fix, a resumed run's second (and later) terminal was only ever
 * observed by the scheduled sweep (`run-watch-sweep.ts`, a 10-minute cron) —
 * unlike a fresh dispatch, which gets both that sweep AND an immediate
 * in-request watch (`apps/kernel/app/warp/api/dispatch/route.ts`) as two
 * independent paths to the same outcome. When {@link sendFollowup} reports
 * `ack.resumed` (i.e. this call actually resumed an already-terminal run),
 * this route re-arms one here too, exactly the way the dispatch route arms
 * its own — same `watchRun`, same injected `claimTerminalPublish` — so a
 * resumed run gets the same fast (~seconds, not ~minutes) and
 * doubly-redundant detection a fresh dispatch always had. `countPriorResumes`
 * is read BEFORE `sendFollowup` is called specifically to avoid racing this
 * resume's own (fire-and-forget) durable-log write — see that function's doc.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { sendFollowup, watchRun, type WarpFollowupMode } from '@/src/lib/warp/dispatch';
import { warpActingDid, warpRunId } from '@/src/lib/warp/route-context';
import { warpErrorResponse } from '@/src/lib/warp/route-errors';
import { claimTerminalPublish, countPriorResumes } from '@/src/lib/warp/run-watch-sweep';

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

  // #2055: read before `sendFollowup` proxies the resume — see this file's
  // module doc for why counting after would race the resume's own durable
  // log write. Zero cost when `resume` was not requested at all.
  const priorResumes = resume === true ? await countPriorResumes(run.runId) : 0;

  try {
    const ack = await sendFollowup(acting.did, run.runId, {
      message,
      ...(mode === undefined ? {} : { mode }),
      ...(resume === undefined ? {} : { resume }),
    });

    if (ack.resumed !== undefined) {
      // Fire-and-forget, deliberately un-awaited — same reasoning as the
      // dispatch route's own `void watchRun(...)`. `priorResumes + 2`: this
      // resume is the `priorResumes + 1`th ever recorded for the run, so the
      // segment it just started is one past that (#2055).
      void watchRun(acting.did, run.runId, {
        claimTerminalPublish,
        resumeContext: { resumedFrom: ack.resumed.previousSessionId, segment: priorResumes + 2 },
      });
    }

    return NextResponse.json(ack, { status: 202, headers: cors });
  } catch (err) {
    log.error(
      { err: String(err), principalDid: acting.did, runId: run.runId },
      'Warp run follow-up failed',
    );
    return warpErrorResponse(err, cors);
  }
}
