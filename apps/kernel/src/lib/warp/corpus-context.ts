/**
 * Corpus-backed retrieval context for Warp dispatch (#2021's "one real
 * consumer" checklist item).
 *
 * Every Warp brief today is hand-written context. This module is what lets a
 * dispatch instead prepend retrieved, provenance-stamped evidence from the
 * *acting principal's own corpus* — never a caller-named DID, see
 * {@link fetchCorpusContext} — ahead of the caller's own prompt.
 *
 * Fails closed (#2021): a corpus search failure throws {@link CorpusContextError}
 * rather than silently dispatching without the requested context, because a
 * run's provenance would otherwise be a lie about what the agent was actually
 * shown. `dispatch.ts` lets this error propagate out of `dispatchAgentRun`
 * instead of swallowing it, and the dispatch route maps it to a 4xx/502 so the
 * caller can retry without `corpusContext`.
 *
 * Only `corpus-client.ts`'s `searchCorpus` is used to reach the corpus
 * service — see that module's docs for why (the shared `CorpusAccessClaim`
 * proxy is the only sanctioned way to call corpus).
 */
import {
  CorpusServiceError,
  searchCorpus,
  type CorpusSearchHit,
  type CorpusSearchResult,
} from '../kernel/corpus-client';

/** Caller-supplied shape of an optional `corpusContext` on a dispatch request. */
export interface CorpusContextInput {
  source: string;
  query: string;
  /** Pin the query to a previously-ingested git sha for `source` (#1921). */
  ref?: string;
  limit?: number;
  maxChars?: number;
}

/** What the run's stored metadata records about a corpus-context retrieval. */
export interface CorpusContextMetadata {
  source: string;
  ref?: string;
  /** Number of hits actually placed in the prompt. */
  hits: number;
  /** Deduplicated content hashes of the hits shown, when the corpus reported any (#1921). */
  contentHashes: string[];
  retrievedAt: string;
}

export interface CorpusContextResult {
  /** The `## Retrieved context (corpus)` block, ready to prepend to the prompt. */
  promptPrefix: string;
  metadata: CorpusContextMetadata;
}

export const CORPUS_CONTEXT_DEFAULT_LIMIT = 8;
export const CORPUS_CONTEXT_MAX_LIMIT = 20;
export const CORPUS_CONTEXT_DEFAULT_MAX_CHARS = 6000;

/** Separator placed between the retrieved-context block and the caller's own prompt, unchanged. */
export const CORPUS_CONTEXT_SEPARATOR = '\n\n---\n\n';

/**
 * Thrown when corpus context retrieval fails for any reason — corpus
 * unreachable, an access-claim rejection (401/403), or an unknown ref (404).
 *
 * `status` is what the dispatch route should answer the caller with;
 * `corpusStatus` is the raw upstream status (0 when corpus was never reached
 * at all, e.g. a network error), carried for diagnostics only.
 */
export class CorpusContextError extends Error {
  readonly status: number;
  readonly corpusStatus: number;

  constructor(message: string, corpusStatus: number, status: number) {
    super(message);
    this.name = 'CorpusContextError';
    this.corpusStatus = corpusStatus;
    this.status = status;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return CORPUS_CONTEXT_DEFAULT_LIMIT;
  return Math.min(CORPUS_CONTEXT_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function clampMaxChars(maxChars: number | undefined): number {
  if (maxChars === undefined || !Number.isFinite(maxChars) || maxChars <= 0) {
    return CORPUS_CONTEXT_DEFAULT_MAX_CHARS;
  }
  return Math.trunc(maxChars);
}

/**
 * Maps a corpus HTTP status to what the dispatch caller should see.
 *
 * 401/403/404 are the corpus service rejecting the *request itself*
 * (malformed access claim, unknown ref) — a caller problem, so 400. Anything
 * else (5xx, an unreachable service) is an upstream fault, so 502.
 */
function statusForCorpusFailure(corpusStatus: number): number {
  return corpusStatus === 401 || corpusStatus === 403 || corpusStatus === 404 ? 400 : 502;
}

/** One line of provenance: what was searched, at what ref, how many hits, and when. */
function provenanceLine(source: string, ref: string | undefined, hits: number, retrievedAt: string): string {
  return `source=${source} ref=${ref ?? 'unpinned'} hits=${hits} retrievedAt=${retrievedAt}`;
}

function hitHeading(hit: CorpusSearchHit): string {
  const score = hit.score.toFixed(2);
  const hash = hit.contentHash === undefined ? '' : `, contentHash=${hit.contentHash}`;
  return `### ${hit.title || hit.id} (score=${score}${hash})`;
}

function hitSection(hit: CorpusSearchHit): string {
  const snippet = hit.evidence.join('\n');
  return `${hitHeading(hit)}\n${snippet}`;
}

/** Drop every trailing `char` — same linear-scan pattern `dispatch.ts` uses, no backtracking regex. */
function truncateToChars(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function uniqueContentHashes(hits: CorpusSearchHit[]): string[] {
  const hashes: string[] = [];
  for (const hit of hits) {
    if (hit.contentHash !== undefined && !hashes.includes(hit.contentHash)) {
      hashes.push(hit.contentHash);
    }
  }
  return hashes;
}

/**
 * Build the `## Retrieved context (corpus)` block for `hits`, truncated to
 * `maxChars` total.
 *
 * Exported standalone (not folded into {@link fetchCorpusContext}) so the
 * block's shape — provenance line, hit ordering, truncation — is unit
 * testable without a corpus-client mock.
 */
export function buildCorpusContextBlock(
  hits: CorpusSearchHit[],
  scope: { source: string; ref: string | undefined; retrievedAt: string },
  maxChars: number,
): { block: string; contentHashes: string[] } {
  const heading = '## Retrieved context (corpus)';
  const provenance = provenanceLine(scope.source, scope.ref, hits.length, scope.retrievedAt);
  const sections = hits.map(hitSection);
  const body = [heading, provenance, ...sections].join('\n\n');

  return { block: truncateToChars(body, maxChars), contentHashes: uniqueContentHashes(hits) };
}

/**
 * Fetch retrieval context from `did`'s own corpus and build the prompt block
 * plus the metadata the run's stored record should keep.
 *
 * `did` is always the dispatch's acting principal (see `dispatch.ts` — it is
 * never taken from `input`, and `CorpusContextInput` has no DID field at all)
 * so a dispatch can only ever be shown its own corpus.
 *
 * Throws {@link CorpusContextError} on any failure — see the class docs for
 * the fail-closed rationale.
 */
export async function fetchCorpusContext(did: string, input: CorpusContextInput): Promise<CorpusContextResult> {
  const limit = clampLimit(input.limit);
  const maxChars = clampMaxChars(input.maxChars);

  let result: CorpusSearchResult;
  try {
    result = await searchCorpus(did, {
      query: input.query,
      source: input.source,
      limit,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
    });
  } catch (err) {
    if (err instanceof CorpusServiceError) {
      throw new CorpusContextError(
        `corpus_context_failed: ${err.status} ${err.message}`,
        err.status,
        statusForCorpusFailure(err.status),
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new CorpusContextError(`corpus_context_failed: ${message}`, 0, 502);
  }

  const retrievedAt = new Date().toISOString();
  const { block, contentHashes } = buildCorpusContextBlock(
    result.results,
    { source: input.source, ref: input.ref, retrievedAt },
    maxChars,
  );

  return {
    promptPrefix: block,
    metadata: {
      source: input.source,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      hits: result.results.length,
      contentHashes,
      retrievedAt,
    },
  };
}
