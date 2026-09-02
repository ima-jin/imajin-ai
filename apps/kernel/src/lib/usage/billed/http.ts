/**
 * Shared HTTP primitive for provider billing adapters (#1076 Stage 1).
 *
 * Anthropic's and OpenAI's admin-key HTTP calls differ only in base URL,
 * auth header shape, and which provider id/label go into a thrown
 * `BillingApiError` — the URL/query-param assembly and the
 * ok/401/403/other-error handling are identical. Extracted once here so the
 * two adapters (`anthropic.ts` / `openai.ts`) share the shape instead of
 * hand-copying it.
 */
import { BillingApiError } from './types';

/** Build a URL, appending `key[]=value` for array params and `key=value` otherwise. */
export function buildBillingApiUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string | string[]>,
): URL {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(`${key}[]`, v);
    } else {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

export interface FetchBillingJsonOptions {
  /** Provider id stamped onto a thrown `BillingApiError`, e.g. `'anthropic'`. */
  providerId: string;
  /** Display label used in the thrown error's message, e.g. `'Anthropic'`. */
  providerLabel: string;
  baseUrl: string;
  path: string;
  params: Record<string, string | string[]>;
  /** Request headers — providers differ here (API-key header vs Bearer token). */
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
}

/**
 * GET one page from a provider's billing API and parse it as JSON.
 *
 * Throws {@link BillingApiError} on a non-2xx response: 401/403 is reported
 * as an auth error (missing/insufficiently-scoped admin key) so the
 * ingestion job can fail-open per provider; any other status is reported as
 * a plain (non-auth) `BillingApiError` and propagates.
 */
export async function fetchBillingJson<T>(opts: FetchBillingJsonOptions): Promise<T> {
  const { providerId, providerLabel, baseUrl, path, params, headers, fetchImpl } = opts;
  const url = buildBillingApiUrl(baseUrl, path, params);

  const response = await fetchImpl(url.toString(), { headers });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new BillingApiError(providerId, response.status, `${providerLabel} billing API returned ${response.status} — admin key missing or insufficiently scoped`);
    }
    throw new BillingApiError(providerId, response.status, `${providerLabel} billing API returned ${response.status}`);
  }

  return response.json() as Promise<T>;
}
