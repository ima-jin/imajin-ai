/**
 * Shared low-level HTTP call to the corpus service (#1730 / #1772).
 *
 * Both consumers of the corpus service — the MCP proxy tools
 * (`mcp/tools/corpus.ts`) and the DID-dashboard client (`corpus-client.ts`) —
 * make the exact same kind of call: `METHOD /corpus/:did/<path>` with a fresh
 * `CorpusAccessClaim` attached. This module is the single place that shape
 * lives, so the two callers differ only in which error type they throw on a
 * non-2xx response (an in-band `Error` for the MCP tool-call convention vs.
 * `CorpusServiceError` for the dashboard route-handler convention).
 */
import { corpusAccessClaimHeader, type CorpusAccessScope } from './corpus-access-claim';

/** Base URL of the corpus service (internal network only). */
export function corpusServiceUrl(): string {
  return process.env.CORPUS_SERVICE_URL || 'http://localhost:8003';
}

export interface CorpusHttpResult {
  ok: boolean;
  status: number;
  statusText: string;
  payload: unknown;
}

/**
 * Calls `/corpus/:did/<path>` on the corpus service and returns the raw
 * result (status + parsed JSON body, if any). Never throws on a non-2xx
 * response — callers decide what to raise, via `corpusErrorMessage` below.
 */
export async function corpusHttpRequest(
  method: 'GET' | 'POST' | 'DELETE',
  did: string,
  scope: CorpusAccessScope,
  path: string,
  body?: unknown,
): Promise<CorpusHttpResult> {
  const url = `${corpusServiceUrl()}/corpus/${encodeURIComponent(did)}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: await corpusAccessClaimHeader(did, scope),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON body (e.g. an empty error page from an intermediary). The status
    // code alone still drives the ok/error branch below.
  }

  return { ok: response.ok, status: response.status, statusText: response.statusText, payload };
}

/** Extracts a human-readable error message from a failed `CorpusHttpResult`. */
export function corpusErrorMessage(result: CorpusHttpResult): string {
  const { payload, statusText } = result;
  return payload !== null && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
    ? (payload as { error: string }).error
    : statusText || 'request failed';
}
