/**
 * Shared correlation-header resolution for the inference passthrough routes
 * and the TypeSafe.ai `/decide` route (imajin-ai#2204, the auditor chain
 * view).
 *
 * `X-Imajin-Session` / `X-Imajin-Turn` are the canonical header names the
 * OpenClaw plugin sends (imajin-ai#36) — the OpenClaw session key and turn
 * id. `X-Imajin-Run` is the Warp run id, present only when the session was
 * spawned from one. Every reader falls back to the pre-#2204
 * `X-Session-Id`/`X-Turn-Id` names (still forwarded by older proxy builds
 * and any other existing caller) so this is a purely additive rename, not a
 * breaking one.
 */
export interface SessionHeaders {
  sessionId?: string;
  turnId?: string;
  /** Warp run id, when this session was spawned from one. Never has a legacy fallback — it is new in #2204. */
  warpRunId?: string;
}

function readHeader(request: Request, canonical: string, legacy?: string): string | undefined {
  return request.headers.get(canonical) ?? (legacy ? request.headers.get(legacy) : null) ?? undefined;
}

/** Resolve `{ sessionId, turnId, warpRunId }` off one request's headers. */
export function resolveSessionHeaders(request: Request): SessionHeaders {
  return {
    sessionId: readHeader(request, 'x-imajin-session', 'x-session-id'),
    turnId: readHeader(request, 'x-imajin-turn', 'x-turn-id'),
    warpRunId: readHeader(request, 'x-imajin-run'),
  };
}
