/**
 * Corpus service HTTP client for the `/auth/corpus` DID dashboard (#1731).
 *
 * The kernel is the auth gateway; the corpus engine (`apps/corpus/`, #1726) is
 * the backend that actually indexes and searches threads. These helpers do
 * nothing but proxy a call to the corpus service over the internal network,
 * keyed by the caller's resolved DID — the same shape as the MCP corpus
 * tools' proxy (`src/lib/mcp/tools/corpus.ts`, #1730), but used by the
 * dashboard's session-authenticated route handlers instead of MCP tool calls.
 *
 * No indexing/search/sync logic lives here — see apps/corpus/src/engine for
 * that. The kernel does not depend on apps/corpus; the two talk HTTP.
 */

import { corpusAccessClaimHeader, type CorpusAccessScope } from './corpus-access-claim';

export interface CorpusSourceFreshness {
  source: string;
  lastSync: string;
  threadCount: number;
  warning?: string;
}

export interface CorpusStatus {
  sources: CorpusSourceFreshness[];
  threadCount: number;
}

/** Base URL of the corpus service (internal network only). */
function corpusServiceUrl(): string {
  return process.env.CORPUS_SERVICE_URL || 'http://localhost:8003';
}

/** Thrown when the corpus service answers with a non-2xx status. */
export class CorpusServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CorpusServiceError';
    this.status = status;
  }
}

/**
 * Call `/corpus/:did/<path>` on the corpus service and return the parsed JSON
 * body. Every call carries a fresh, kernel-signed `CorpusAccessClaim` (#1772)
 * scoped to `did`/`scope`, mirroring the MCP corpus tools' proxy. Throws
 * `CorpusServiceError` on a non-2xx response so route handlers can map it to
 * an appropriate HTTP status instead of a blanket 500.
 */
async function corpusRequest(
  method: 'GET' | 'POST' | 'DELETE',
  did: string,
  scope: CorpusAccessScope,
  path: string,
  body?: unknown,
): Promise<unknown> {
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

  if (!response.ok) {
    const errorMessage =
      payload !== null && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : response.statusText || 'request failed';
    throw new CorpusServiceError(response.status, errorMessage);
  }

  return payload;
}

/** `GET /corpus/:did/status` — sources, per-source thread counts, freshness. */
export function fetchCorpusStatus(did: string): Promise<CorpusStatus> {
  return corpusRequest('GET', did, 'corpus:read', '/status') as Promise<CorpusStatus>;
}

/** `POST /corpus/:did/ingest` — load a new source into the corpus. */
export function loadCorpusSource(did: string, body: unknown): Promise<unknown> {
  return corpusRequest('POST', did, 'corpus:write', '/ingest', body);
}

/** `POST /corpus/:did/sync` — trigger an incremental refresh of a source. */
export function syncCorpusSource(did: string, body: unknown): Promise<unknown> {
  return corpusRequest('POST', did, 'corpus:write', '/sync', body);
}

/** `DELETE /corpus/:did/source` — remove a source from the corpus. */
export function deleteCorpusSource(did: string, body: unknown): Promise<unknown> {
  return corpusRequest('DELETE', did, 'corpus:write', '/source', body);
}
