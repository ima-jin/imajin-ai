/**
 * TypeSafe.ai (Jev) HTTP client (#2197).
 *
 * TypeSafe's API is bespoke, not chat-completions-shaped: no `messages[]`,
 * no sampling params, no streaming (docs.typesafe.ai/api). This client
 * speaks exactly the two endpoints the connector needs:
 *
 *   `GET  /v1/models`     — the key-validation probe (401 = bad key).
 *   `POST /v1/systemone`  — the calibrated-decision primitive.
 *
 * Retry policy (per the issue): `429`/`529` retry with exponential backoff
 * honouring the upstream `retry-after` header, capped at 3 total attempts;
 * `422` (caller bug) and every other status are surfaced to the caller
 * immediately, never retried. The raw API key is used only in the
 * `Authorization` header of the outbound request — it is never logged, and
 * upstream error bodies are surfaced opaque (JSON, verbatim) rather than
 * re-derived, so nothing here can echo the key back into a response.
 *
 * Deliberately does NOT import from `./connector`: that module pulls in the
 * vault/DB stack transitively (`createConnectorTokenPaste`), which this
 * module (and its unit tests, which stub only `fetch`) must stay free of --
 * the same reasoning `../openrouter/model-handlers.ts` documents for the
 * same split.
 */

/** TypeSafe.ai's public API base (docs.typesafe.ai/api). Re-exported by `./connector`. */
export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';

/** Maximum number of attempts (1 initial + up to 2 retries) for a retryable status. */
const MAX_ATTEMPTS = 3;

/** Fallback backoff (ms) when the upstream response carries no `retry-after` header. */
const BASE_BACKOFF_MS = 500;

export type TypesafeModelId = 'jev-latest' | 'jev-1.13.0' | 'jev-preview';

export interface TypesafeModel {
  name: string;
  description?: string;
  release_date?: string;
}

export interface TypesafeModelsResponse {
  models: TypesafeModel[];
}

export type TypesafeQuestionType = 'noul' | 'choice' | 'score';

export interface TypesafeQuestion {
  type: TypesafeQuestionType;
  instructions: string;
  /** Required for `choice` (`map<option, rubric|null>`) and `score` (ordered levels); absent for `noul`. */
  criteria?: unknown;
}

export interface TypesafeSystemOneRequest {
  state: string | Record<string, unknown> | unknown[];
  model?: TypesafeModelId;
  questions: Record<string, TypesafeQuestion>;
}

/** An individual answer, passed through byte-for-byte — shape is whatever TypeSafe returns. */
export type TypesafeAnswer = Record<string, unknown>;

export interface TypesafeSystemOneResponse {
  /** The resolved, versioned model id (e.g. `jev-1.13.0`), even when the request named `jev-latest`. */
  model: string;
  answers: Record<string, TypesafeAnswer>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface TypesafeApiResult<T> {
  data: T;
  requestId: string | null;
}

/** Thrown for any non-2xx TypeSafe response, after retries (if any) are exhausted. Never carries the API key. */
export class TypesafeUpstreamError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly requestId: string | null;

  constructor(status: number, body: unknown, requestId: string | null) {
    super(`typesafe_upstream: ${status}`);
    this.name = 'TypesafeUpstreamError';
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 529;
}

/**
 * Resolve the retry delay from the upstream `retry-after` header (seconds,
 * per RFC 9110 — TypeSafe does not document the HTTP-date form and neither
 * do any of the callers this client has, so only the delay-seconds form is
 * honoured), falling back to exponential backoff when the header is absent
 * or unparseable.
 */
function retryDelayMs(retryAfterHeader: string | null, attempt: number): number {
  if (retryAfterHeader !== null) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  return BASE_BACKOFF_MS * 2 ** (attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a response body as JSON, degrading to `null` for an empty/non-JSON body rather than throwing. */
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch `path` with the owner's sealed key, retrying 429/529 up to
 * {@link MAX_ATTEMPTS} total attempts with backoff honouring `retry-after`.
 * Every other status (including 422) is returned as-is on the first
 * attempt — the caller maps a non-ok response to {@link TypesafeUpstreamError}.
 */
async function typesafeFetch(path: string, init: RequestInit, apiKey: string): Promise<Response> {
  let response: Response;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    response = await fetch(`${TYPESAFE_BASE_URL}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${apiKey}`,
      },
    });

    const shouldRetry = !response.ok && isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS;
    if (!shouldRetry) {
      return response;
    }

    await sleep(retryDelayMs(response.headers.get('retry-after'), attempt));
  }
  // Unreachable — the loop always returns by its final iteration — but kept
  // for exhaustiveness so this function's return type stays non-optional.
  throw new Error('typesafe_client: retry loop exited without a response');
}

function requestId(res: Response): string | null {
  return res.headers.get('x-typesafe-request-id');
}

/**
 * `GET /v1/models` — the key-validation probe. 401 = bad key, surfaced as a
 * {@link TypesafeUpstreamError} so the caller can map it without inspecting
 * response internals.
 */
export async function getModels(apiKey: string): Promise<TypesafeApiResult<TypesafeModelsResponse>> {
  const res = await typesafeFetch('/v1/models', { method: 'GET', headers: { Accept: 'application/json' } }, apiKey);
  const reqId = requestId(res);
  if (!res.ok) {
    throw new TypesafeUpstreamError(res.status, await safeJson(res), reqId);
  }
  return { data: (await res.json()) as TypesafeModelsResponse, requestId: reqId };
}

/**
 * `POST /v1/systemone` — the calibrated-decision primitive. Forwards `body`
 * verbatim; the response's `answers`/`usage`/`model` are returned untouched
 * for the route to pass through byte-for-byte.
 */
export async function postSystemOne(
  apiKey: string,
  body: TypesafeSystemOneRequest,
): Promise<TypesafeApiResult<TypesafeSystemOneResponse>> {
  const res = await typesafeFetch(
    '/v1/systemone',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    },
    apiKey,
  );
  const reqId = requestId(res);
  if (!res.ok) {
    throw new TypesafeUpstreamError(res.status, await safeJson(res), reqId);
  }
  return { data: (await res.json()) as TypesafeSystemOneResponse, requestId: reqId };
}
