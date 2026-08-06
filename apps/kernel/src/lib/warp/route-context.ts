/**
 * Shared preamble for the Warp connector routes (#1428, #1639).
 *
 * Every `/warp/api/**` handler starts the same way — resolve the session, resolve
 * the *acting* DID, and (for per-run routes) validate the run id — and every one
 * of them must start that way identically. #1639 turned two such routes into
 * seven, so the preamble lives here rather than being retyped: a variation in it
 * would be a variation in who a run is read as, which is the one thing this wire
 * is not allowed to get wrong.
 *
 * Deliberately no scope check: reaching Warp at all requires unwrapping the
 * caller's sealed Agent key, and `requireAgentKey` refuses without an active
 * `warp:dispatch` grant. A check here would be a second, weaker copy of a gate
 * the credential already enforces structurally.
 *
 * Kept out of `route-errors.ts` because that module is the error → HTTP mapping
 * and must stay importable by anything that can throw a {@link WarpApiError};
 * this one pulls in `@imajin/auth`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';

/**
 * Either the value the handler asked for, or the response it should return.
 *
 * Returned rather than thrown so each handler's happy path stays flat — the same
 * shape `app/warp/api/environment/route.ts` uses for its three verbs.
 */
export type WarpRouteStep<T> = T | { response: NextResponse };

/** The acting DID for this request, or the 401 to return instead. */
export async function warpActingDid(
  request: NextRequest,
  cors: Record<string, string>,
): Promise<WarpRouteStep<{ did: string }>> {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return {
      response: NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors }),
    };
  }
  return { did: resolveActingDid(auth.identity) };
}

/**
 * The trimmed `runId` route parameter, or the 400 to return instead.
 *
 * A blank id is rejected here so it never reaches Warp as a malformed path — the
 * client library re-checks it for non-HTTP callers.
 */
export function warpRunId(
  params: { runId?: string },
  cors: Record<string, string>,
): WarpRouteStep<{ runId: string }> {
  const runId = params.runId?.trim() ?? '';
  if (runId.length === 0) {
    return {
      response: NextResponse.json({ error: 'runId is required' }, { status: 400, headers: cors }),
    };
  }
  return { runId };
}
