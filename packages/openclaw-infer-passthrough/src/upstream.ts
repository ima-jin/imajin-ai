/**
 * Upstream HTTP calls: the kernel passthrough, and the break-glass direct
 * provider fallback (imajin-ai#1926).
 *
 * Both use `AbortSignal.timeout` around the initial `fetch()` call only —
 * `fetch()`'s promise resolves as soon as response headers arrive, so this
 * bounds time-to-first-byte, not total response time. That is exactly the
 * "kernel returns 5xx or times out" trigger the epic specifies: a slow but
 * healthy stream must not be aborted mid-flight just because the whole
 * completion takes longer than the TTFB deadline.
 */
import type { ProviderRouteConfig } from './types.js';

export class UpstreamTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`${what} did not respond within ${timeoutMs}ms (time-to-first-byte)`);
    this.name = 'UpstreamTimeoutError';
  }
}

export class UpstreamUnavailableError extends Error {
  constructor(what: string, cause: string) {
    super(`${what} could not be reached: ${cause}`);
    this.name = 'UpstreamUnavailableError';
  }
}

export class NoDirectFallbackError extends Error {
  constructor(routeId: string) {
    super(`No break-glass direct endpoint configured for route '${routeId}'`);
    this.name = 'NoDirectFallbackError';
  }
}

export interface ForwardHeaders {
  sessionId?: string;
  turnId?: string;
}

/**
 * Forward a chat-completions request to the kernel passthrough. Never
 * inspects or rewrites `bodyText` — a raw byte passthrough, as the epic
 * requires — beyond attaching the bearer token and optional metering
 * headers. Returns the raw `Response` for any HTTP status the kernel
 * returns (2xx/4xx/5xx); only a network failure or TTFB timeout throws.
 */
export async function forwardToKernel(
  kernelBaseUrl: string,
  token: string,
  bodyText: string,
  timeoutMs: number,
  headers: ForwardHeaders = {},
): Promise<Response> {
  const url = `${kernelBaseUrl.replace(/\/+$/, '')}/infer/v1/chat/completions`;
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (headers.sessionId) reqHeaders['X-Session-Id'] = headers.sessionId;
  if (headers.turnId) reqHeaders['X-Turn-Id'] = headers.turnId;

  try {
    return await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: bodyText,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new UpstreamTimeoutError('Kernel', timeoutMs);
    }
    throw new UpstreamUnavailableError('Kernel', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Break-glass: forward the same raw request body straight to the provider's
 * own OpenAI-compatible endpoint, bypassing the kernel entirely. Only called
 * on a kernel 5xx or TTFB timeout, and only for a route with both
 * `directBaseUrl` and a resolvable direct API key — see `handle-completions.ts`.
 */
export async function forwardDirect(
  route: ProviderRouteConfig,
  directApiKey: string,
  bodyText: string,
  timeoutMs: number,
): Promise<Response> {
  if (!route.directBaseUrl) {
    throw new NoDirectFallbackError(route.id);
  }
  const url = `${route.directBaseUrl.replace(/\/+$/, '')}/chat/completions`;
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${directApiKey}`,
      },
      body: bodyText,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new UpstreamTimeoutError(`Direct provider '${route.id}'`, timeoutMs);
    }
    throw new UpstreamUnavailableError(`Direct provider '${route.id}'`, err instanceof Error ? err.message : String(err));
  }
}
