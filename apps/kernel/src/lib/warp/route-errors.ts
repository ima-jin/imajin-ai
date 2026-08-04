/**
 * Error → HTTP mapping for the Warp connector routes (#1428).
 *
 * Shared by the dispatch and run-status routes so both fail identically. Kept
 * separate from `dispatch.ts` because that module must stay usable from non-HTTP
 * callers (MCP tools), which have no NextResponse.
 *
 * Nothing here can leak the sealed Warp Agent key: gate failures are our own
 * error strings, and upstream failures arrive already reduced to RFC-7807
 * problem metadata by {@link WarpApiError}.
 */
import { NextResponse } from 'next/server';
import { WarpApiError } from './errors';

/** Status Warp returned, mapped to what *our* caller should see. */
function statusForUpstream(upstream: number): number {
  // Our sealed key being rejected is not the caller's authentication problem —
  // returning 401 here would invite a client to re-authenticate against us,
  // which cannot fix a bad or revoked Warp key. It is an upstream fault.
  if (upstream === 401 || upstream === 403) return 502;
  if (upstream >= 500) return 502;
  return upstream;
}

/**
 * Translate a dispatch/status failure into a JSON response.
 *
 * Gate failures are deliberately distinguishable from upstream failures: a
 * caller that is missing the grant needs to visit the connector, whereas an
 * upstream failure is nothing they can act on.
 */
export function warpErrorResponse(err: unknown, cors: Record<string, string>): NextResponse {
  if (err instanceof WarpApiError) {
    return NextResponse.json(
      {
        error: 'warp_upstream_error',
        upstreamStatus: err.status,
        ...(err.code === undefined ? {} : { code: err.code }),
        ...(err.detail === undefined ? {} : { detail: err.detail }),
        ...(err.retryable === undefined ? {} : { retryable: err.retryable }),
        ...(err.traceId === undefined ? {} : { traceId: err.traceId }),
      },
      { status: statusForUpstream(err.status), headers: cors },
    );
  }

  const message = err instanceof Error ? err.message : String(err);

  if (message.startsWith('warp_no_grant')) {
    return NextResponse.json(
      {
        error: 'warp_no_grant',
        detail: 'No active warp:dispatch grant — enable the scope on the Warp connector first.',
      },
      { status: 403, headers: cors },
    );
  }

  if (message.startsWith('warp_no_secret')) {
    return NextResponse.json(
      {
        error: 'warp_no_secret',
        detail: 'No Warp Agent key is sealed for this DID, or its delegation grant was revoked.',
      },
      { status: 409, headers: cors },
    );
  }

  if (message.startsWith('warp_invalid_')) {
    return NextResponse.json({ error: message }, { status: 400, headers: cors });
  }

  return NextResponse.json({ error: 'warp_dispatch_failed' }, { status: 500, headers: cors });
}
