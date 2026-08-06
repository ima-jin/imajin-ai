/**
 * GET /warp/api/runs/{runId}/transcript (#1639)
 *
 * The raw conversation transcript of a run, read with the caller's own sealed
 * Warp Agent key. This is the self-diagnosis path: when a dispatched run fails,
 * the transcript is the only place that says why, and it is auth-gated upstream —
 * which is exactly why it has to be proxied rather than linked.
 *
 * The pre-signed download URL Warp redirects to is *not* returned. It is a
 * time-limited bearer capability for the transcript, so handing it to the client
 * would convert a per-DID read into a shareable one.
 *
 * Query params:
 *   ?maxChars=200000 — cap the returned text; defaults to TRANSCRIPT_MAX_CHARS
 *
 * Returns `{ runId, content, contentType, truncated }`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { getAgentRunTranscript } from '@/src/lib/warp/dispatch';
import { warpActingDid, warpRunId } from '@/src/lib/warp/route-context';
import { warpErrorResponse } from '@/src/lib/warp/route-errors';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest, { params }: { params: { runId: string } }) {
  const cors = corsHeaders(request);

  const acting = await warpActingDid(request, cors);
  if ('response' in acting) return acting.response;

  const run = warpRunId(params, cors);
  if ('response' in run) return run.response;

  // A bad cap degrades to the default rather than 400'ing: it only narrows a read
  // the caller is already entitled to.
  const maxChars = Number(new URL(request.url).searchParams.get('maxChars'));

  try {
    const transcript = await getAgentRunTranscript(
      acting.did,
      run.runId,
      Number.isFinite(maxChars) && maxChars > 0 ? { maxChars } : {},
    );
    return NextResponse.json(transcript, { headers: cors });
  } catch (err) {
    log.error(
      { err: String(err), principalDid: acting.did, runId: run.runId },
      'Warp run transcript read failed',
    );
    return warpErrorResponse(err, cors);
  }
}
