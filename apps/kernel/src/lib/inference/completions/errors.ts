/**
 * Completions-passthrough-specific failure types (#1925).
 *
 * Distinct from `brain-http-errors.ts`: those map failures from resolving
 * WHICH credential to use (brain.ts); these map failures from the actual
 * upstream call once a credential was resolved and forwarding began — a
 * connection that timed out or could never be reached, as opposed to "no
 * brain sealed" or "rate limited" (which the provider itself reports as a
 * proper HTTP response, not a `fetch()` failure).
 */

/** The upstream provider did not respond before the passthrough's deadline. */
export class UpstreamTimeoutError extends Error {
  readonly connector: string;

  constructor(connector: string) {
    super(`upstream_timeout: ${connector} did not respond in time`);
    this.name = 'UpstreamTimeoutError';
    this.connector = connector;
  }
}

/** The upstream provider could not be reached at all (DNS, TCP, TLS, etc.). */
export class UpstreamUnavailableError extends Error {
  readonly connector: string;

  constructor(connector: string, cause: string) {
    super(`upstream_unavailable: ${connector} could not be reached — ${cause}`);
    this.name = 'UpstreamUnavailableError';
    this.connector = connector;
  }
}

/**
 * Map an upstream-call failure (as opposed to a brain-resolution failure —
 * see `brain-http-errors.ts`) to a typed HTTP response, or `undefined` when
 * `err` is not one of these two cases.
 */
export function mapUpstreamErrorToHttp(err: unknown): { status: number; body: Record<string, unknown> } | undefined {
  if (err instanceof UpstreamTimeoutError) {
    return {
      status: 504,
      body: { error: 'upstream_timeout', message: 'The model provider did not respond in time', detail: err.message },
    };
  }
  if (err instanceof UpstreamUnavailableError) {
    return {
      status: 502,
      body: { error: 'upstream_unavailable', message: 'The model provider could not be reached', detail: err.message },
    };
  }
  return undefined;
}

/**
 * Run `fetch` with a deadline, translating an abort or network failure into
 * the typed errors above rather than letting an `AbortError`/`TypeError`
 * reach the route as an unrecognized crash. Used directly by the
 * OpenAI-compatible adapter's raw fetch; the Anthropic adapter drives the
 * same AI SDK call with an equivalent `abortSignal` + catch, so a timeout
 * reads identically as `UpstreamTimeoutError` regardless of which upstream
 * shape it hit.
 */
export async function fetchUpstream(
  connector: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new UpstreamTimeoutError(connector);
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new UpstreamTimeoutError(connector);
    }
    throw new UpstreamUnavailableError(connector, err instanceof Error ? err.message : String(err));
  }
}
