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

import type { CorpusAccessScope } from './corpus-access-claim';
import { corpusErrorMessage, corpusHttpRequest } from './corpus-http';
import { forEachSequential } from '../async/sequential';

export interface CorpusSourceFreshness {
  source: string;
  ownerDid: string;
  lastSync: string;
  threadCount: number;
  warning?: string;
  credentialRef?: string;
  error?: string;
}

export interface CorpusStatus {
  sources: CorpusSourceFreshness[];
  threadCount: number;
}

/** Request body for `POST /corpus/:did/search` — mirrors `CorpusSearchRequest` (apps/corpus/src/engine/types.ts). */
export interface CorpusSearchParams {
  query: string;
  source?: string;
  /** Pin the query to a previously-ingested git sha for `source` (#1921). Requires `source`. */
  ref?: string;
  limit?: number;
  budget?: number;
  sourceType?: string;
  state?: string | string[];
  type?: string | string[];
  labels?: string[];
  author?: string;
}

/** One scored evidence hit — mirrors `CorpusSearchHit` (apps/corpus/src/engine/types.ts). */
export interface CorpusSearchHit {
  source: string;
  id: string;
  type: string;
  title: string;
  state: string;
  score: number;
  evidence: string[];
  url?: string;
  updated: string;
  /** Present only for `ref`-pinned queries once the corpus service supports #1921. */
  contentHash?: string;
}

/** Present only when the request was pinned to a `ref` — mirrors `CorpusSearchProvenance` (#1921). */
export interface CorpusSearchProvenance {
  ref: string;
  source: string;
  chunks: Array<{ docId: string; contentHash: string }>;
}

export interface CorpusSearchResult {
  results: CorpusSearchHit[];
  totalHits: number;
  tokensUsed: number;
  provenance?: CorpusSearchProvenance;
  freshness?: CorpusSourceFreshness[];
  mode?: string;
  degraded?: string[];
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
 * scoped to `did`/`scope` (see `corpus-http.ts`, shared with the MCP corpus
 * tools' proxy). Throws `CorpusServiceError` on a non-2xx response so route
 * handlers can map it to an appropriate HTTP status instead of a blanket 500.
 */
async function corpusRequest(
  method: 'GET' | 'POST' | 'DELETE',
  did: string,
  scope: CorpusAccessScope,
  path: string,
  body?: unknown,
  targetDid?: string,
): Promise<unknown> {
  const result = await corpusHttpRequest(method, did, scope, path, body, targetDid);
  if (!result.ok) {
    throw new CorpusServiceError(result.status, corpusErrorMessage(result));
  }
  return result.payload;
}

/** `GET /corpus/:did/status` — sources, per-source thread counts, freshness. */
async function readGrantedCorpora<T>(did: string, read: (ownerDid: string) => Promise<T>): Promise<{ ownerDid: string; value: T }[]> {
  const { grantedCorpusOwners, authorizeCorpusOwner } = await import('./corpus-owner');
  const owners = [did, ...await grantedCorpusOwners(did)];
  const values: { ownerDid: string; value: T }[] = [];
  await forEachSequential(owners, async ownerDid => {
    if (!await authorizeCorpusOwner(did, ownerDid, 'corpus:read')) throw new CorpusServiceError(403, 'Corpus grant is no longer active');
    values.push({ ownerDid, value: await read(ownerDid) });
  });
  return values;
}

export async function fetchCorpusStatus(did: string): Promise<CorpusStatus> {
  const statuses = await readGrantedCorpora(did, ownerDid =>
    corpusRequest('GET', did, 'corpus:read', '/status', undefined, ownerDid) as Promise<CorpusStatus>);
  return {
    sources: statuses.flatMap(({ value, ownerDid }) => value.sources.map(source => ({ ...source, ownerDid }))),
    threadCount: statuses.reduce((total, { value }) => total + value.threadCount, 0),
  };
}

/**
 * `POST /corpus/:did/search` — scored evidence excerpts for `params.query`.
 *
 * Used by the Warp dispatch corpus-context feature (#2021's first-consumer
 * checklist item): `did` is always the dispatch's acting principal, never a
 * caller-supplied value. Unscoped reads also cover the same currently granted
 * owner partitions as the status view, with the same fail-closed checks.
 */
export async function searchCorpus(did: string, params: CorpusSearchParams): Promise<CorpusSearchResult> {
  if (params.source) return corpusRequest('POST', did, 'corpus:read', '/search', params) as Promise<CorpusSearchResult>;
  const responses = await readGrantedCorpora(did, ownerDid =>
    corpusRequest('POST', did, 'corpus:read', '/search', params, ownerDid) as Promise<CorpusSearchResult>);
  if (responses.length === 1) return responses[0].value;
  return mergeSearchResults(responses.map(response => response.value), params);
}

function mergeSearchResults(responses: CorpusSearchResult[], params: CorpusSearchParams): CorpusSearchResult {
  const hits = responses.flatMap(response => response.results).sort((left, right) => right.score - left.score);
  const unique = new Map<string, CorpusSearchHit>();
  for (const hit of hits) {
    const key = `${hit.source}\0${hit.id}`;
    if (!unique.has(key)) unique.set(key, hit);
  }
  const limit = Math.max(1, Math.min(100, Math.floor(params.limit ?? 10) || 1));
  let remaining = Math.max(0, Math.min(100_000, Math.floor(params.budget ?? 4000) || 0));
  const budget = remaining;
  const results = [...unique.values()].slice(0, limit).map(hit => ({
    ...hit,
    evidence: hit.evidence.map(quote => {
      const excerpt = quote.slice(0, remaining * 4);
      remaining -= Math.ceil(excerpt.length / 4);
      return excerpt;
    }).filter(Boolean),
  }));
  return {
    ...responses[0], results, totalHits: unique.size, tokensUsed: budget - remaining,
    freshness: responses.flatMap(response => response.freshness ?? []),
    degraded: [...new Set(responses.flatMap(response => response.degraded ?? []))],
  };
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
