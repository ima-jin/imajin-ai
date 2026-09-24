/**
 * Upstream HTTP calls: the kernel passthrough, and the break-glass direct
 * provider fallback (imajin-ai#1926).
 *
 * Every call below bounds time-to-first-byte only, not total response time —
 * a slow but healthy stream must not be aborted mid-flight just because the
 * whole completion takes longer than the TTFB deadline (imajin-ai#2342). This
 * is NOT what `AbortSignal.timeout(timeoutMs)` gives you: that signal fires
 * `timeoutMs` after the request started regardless of whether headers have
 * already arrived, and an abort on the signal `fetch()` was given tears down
 * the in-flight body too, not just an unstarted request. `fetchWithTtfbTimeout`
 * below uses its own `AbortController` and clears the timer the instant
 * `fetch()` resolves (headers received), so the abort can only ever fire
 * before the first byte.
 */
import type { ProviderRouteConfig } from './types.js';
import { stripTrailingSlashes } from './url-utils.js';

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

/**
 * `fetch()` with an abort bound ONLY to time-to-first-byte. The timer starts
 * when the request is issued and is cleared as soon as `fetch()` settles —
 * on resolution (headers arrived) the body stream is then free to run for as
 * long as it needs; on rejection there is nothing left to abort. Throws
 * `UpstreamTimeoutError` when the timer fires first, `UpstreamUnavailableError`
 * for any other network failure.
 */
async function fetchWithTtfbTimeout(url: string, init: RequestInit, timeoutMs: number, what: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new UpstreamTimeoutError(what, timeoutMs);
    }
    throw new UpstreamUnavailableError(what, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
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
  /** OpenClaw's Warp run id, when this session was spawned from one (imajin-ai#2204). */
  warpRunId?: string;
}

/**
 * Attach the correlation headers the kernel folds into `usage.incurred`'s
 * `session_id`/`turn_id`/metadata (imajin-ai#2204) — `X-Imajin-Session` /
 * `X-Imajin-Turn` / `X-Imajin-Run`, the canonical names the auditor-chain
 * issue settles on. Shared by both wire formats' forwarders below so the
 * header set never drifts between them.
 */
function correlationHeaders(headers: ForwardHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers.sessionId) out['X-Imajin-Session'] = headers.sessionId;
  if (headers.turnId) out['X-Imajin-Turn'] = headers.turnId;
  if (headers.warpRunId) out['X-Imajin-Run'] = headers.warpRunId;
  return out;
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
  const url = `${stripTrailingSlashes(kernelBaseUrl)}/infer/v1/chat/completions`;
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...correlationHeaders(headers),
  };

  return fetchWithTtfbTimeout(url, { method: 'POST', headers: reqHeaders, body: bodyText }, timeoutMs, 'Kernel');
}

/**
 * Forward `GET /openai/v1/models` to the kernel's `GET /infer/v1/models/usable`
 * (imajin-ai#2201) — same bearer-token auth as the completions passthrough,
 * no request body. Returns the raw `Response` for any HTTP status the
 * kernel returns; only a network failure or TTFB timeout throws.
 */
export async function forwardModelsToKernel(
  kernelBaseUrl: string,
  token: string,
  timeoutMs: number,
): Promise<Response> {
  const url = `${stripTrailingSlashes(kernelBaseUrl)}/infer/v1/models/usable`;
  return fetchWithTtfbTimeout(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, timeoutMs, 'Kernel');
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
  const url = `${stripTrailingSlashes(route.directBaseUrl)}/chat/completions`;
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${directApiKey}`,
  };
  return fetchWithTtfbTimeout(url, { method: 'POST', headers: reqHeaders, body: bodyText }, timeoutMs, `Direct provider '${route.id}'`);
}

/** The two Anthropic-format endpoints this shim forwards (imajin-ai#1959). */
export type AnthropicPath = 'messages' | 'messages/count_tokens';

export interface AnthropicForwardHeaders extends ForwardHeaders {
  anthropicVersion?: string;
  anthropicBeta?: string;
}

/**
 * Forward an Anthropic-format request (`POST /anthropic/v1/messages` or
 * `.../count_tokens`) to the kernel's raw passthrough
 * (`POST /infer/v1/messages` or `.../count_tokens`, imajin-ai#1959).
 *
 * The credential rides as `x-api-key`, not `Authorization` — the Claude
 * Agent SDK / Claude Code CLI have no other header to carry it on, and the
 * kernel's `resolveInferenceAuth` accepts an app-token JWT there for exactly
 * this reason. `anthropic-version`/`anthropic-beta`, when the caller sent
 * them, are forwarded unchanged, mirroring the kernel route's own contract.
 */
export async function forwardAnthropicToKernel(
  kernelBaseUrl: string,
  path: AnthropicPath,
  token: string,
  bodyText: string,
  timeoutMs: number,
  headers: AnthropicForwardHeaders = {},
): Promise<Response> {
  const url = `${stripTrailingSlashes(kernelBaseUrl)}/infer/v1/${path}`;
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': token,
    ...correlationHeaders(headers),
  };
  if (headers.anthropicVersion) reqHeaders['anthropic-version'] = headers.anthropicVersion;
  if (headers.anthropicBeta) reqHeaders['anthropic-beta'] = headers.anthropicBeta;

  return fetchWithTtfbTimeout(url, { method: 'POST', headers: reqHeaders, body: bodyText }, timeoutMs, 'Kernel');
}

/**
 * Break-glass: forward the same raw request body straight to
 * `api.anthropic.com` (or the route's configured `directBaseUrl`), bypassing
 * the kernel entirely. Only called on a kernel 5xx or TTFB timeout, and only
 * for a route with both `directBaseUrl` and a resolvable direct API key —
 * same rule `forwardDirect` enforces for the OpenAI-compatible path, reusing
 * the SAME `directBaseUrl`/`directApiKeyEnvVar` config fields (imajin-ai#1959:
 * "no separate config surface for this wire format").
 */
export async function forwardAnthropicDirect(
  route: ProviderRouteConfig,
  directApiKey: string,
  path: AnthropicPath,
  bodyText: string,
  timeoutMs: number,
  headers: Pick<AnthropicForwardHeaders, 'anthropicVersion' | 'anthropicBeta'> = {},
): Promise<Response> {
  if (!route.directBaseUrl) {
    throw new NoDirectFallbackError(route.id);
  }
  const url = `${stripTrailingSlashes(route.directBaseUrl)}/${path}`;
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': directApiKey,
    'anthropic-version': headers.anthropicVersion ?? '2023-06-01',
  };
  if (headers.anthropicBeta) reqHeaders['anthropic-beta'] = headers.anthropicBeta;

  return fetchWithTtfbTimeout(url, { method: 'POST', headers: reqHeaders, body: bodyText }, timeoutMs, `Direct provider '${route.id}'`);
}
