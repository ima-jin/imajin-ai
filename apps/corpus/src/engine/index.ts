import { collectEvidenceText } from './chunker';
import { CorpusStore, type CorpusStoreOptions, type StoredSearchRow } from './store';
import type {
  CorpusSearchHit,
  CorpusSearchProvenance,
  CorpusSearchRequest,
  CorpusSearchResult,
  CorpusStatus,
  ThreadDocument,
} from './types';
import { addFreshnessWarnings } from '../lib/freshness';
import { DEFAULT_SEARCH_LIMIT, DEFAULT_TOKEN_BUDGET, estimateTokens, truncateToTokenBudget } from '../lib/tokens';

export interface CorpusEngineOptions extends CorpusStoreOptions {
  now?: () => Date;
}

export class CorpusEngine {
  private readonly store: CorpusStore;
  private readonly now: () => Date;

  constructor(options: CorpusEngineOptions = {}) {
    this.store = new CorpusStore(options);
    this.now = options.now ?? (() => new Date());
  }

  close(): void {
    this.store.close();
  }

  ingest(did: string, documents: ThreadDocument[], ref?: string): { ingested: number } {
    validateDid(did);
    for (const document of documents) {
      validateThreadDocument(document);
    }

    this.store.ingest(did, documents, this.now().toISOString(), ref);
    return { ingested: documents.length };
  }

  search(did: string, request: CorpusSearchRequest): CorpusSearchResult {
    validateDid(did);
    validateSearchRequest(request);

    const limit = clampInteger(request.limit ?? DEFAULT_SEARCH_LIMIT, 1, 100);
    const budget = clampInteger(request.budget ?? DEFAULT_TOKEN_BUDGET, 0, 100_000);

    if (request.ref && request.source) {
      const rows = this.store.searchAtRef(did, request.source, request.ref, { ...request, limit });
      return this.buildSearchResult(did, rows, request.query, budget, { ref: request.ref, source: request.source });
    }

    const rows = this.store.search(did, { ...request, limit });
    return this.buildSearchResult(did, rows, request.query, budget);
  }

  private buildSearchResult(
    did: string,
    rows: StoredSearchRow[],
    query: string,
    budget: number,
    provenanceScope?: { ref: string; source: string },
  ): CorpusSearchResult {
    const scoredRows = rows
      .map(row => ({ row, score: scoreRow(row) }))
      .sort((left, right) => right.score - left.score);

    let remainingBudget = budget;
    const results: CorpusSearchHit[] = [];
    let tokensUsed = 0;

    for (const scoredRow of scoredRows) {
      const evidence = buildEvidence(scoredRow.row, query, remainingBudget);
      const evidenceTokens = evidence.reduce((total, quote) => total + estimateTokens(quote), 0);
      remainingBudget = Math.max(0, remainingBudget - evidenceTokens);
      tokensUsed += evidenceTokens;

      results.push({
        source: scoredRow.row.source,
        id: scoredRow.row.docId,
        type: scoredRow.row.threadType,
        title: scoredRow.row.title,
        state: scoredRow.row.state,
        resolution: scoredRow.row.resolution,
        score: scoredRow.score,
        evidence,
        url: scoredRow.row.url,
        updated: scoredRow.row.updated,
        contentHash: scoredRow.row.contentHash,
      });
    }

    return {
      results,
      totalHits: scoredRows.length,
      freshness: this.freshness(did),
      tokensUsed,
      provenance: provenanceScope ? buildProvenance(provenanceScope, results) : undefined,
    };
  }

  status(did: string): CorpusStatus {
    validateDid(did);
    const status = this.store.status(did);
    return {
      sources: addFreshnessWarnings(status.sources, this.now()),
      threadCount: status.threadCount,
    };
  }

  freshness(did: string): CorpusStatus['sources'] {
    validateDid(did);
    return addFreshnessWarnings(this.store.freshness(did), this.now());
  }

  deleteSource(did: string, source: string): { deleted: number } {
    validateDid(did);
    if (!source) {
      throw new Error('source is required');
    }

    return { deleted: this.store.deleteSource(did, source) };
  }
}

function validateDid(did: string): void {
  if (!did) {
    throw new Error('did is required');
  }
}

function validateSearchRequest(request: CorpusSearchRequest): void {
  if (!request.query || typeof request.query !== 'string') {
    throw new Error('query is required');
  }
  if (request.ref && !request.source) {
    throw new Error('source is required when ref is set');
  }
}

/** Builds the `provenance` block for a ref-pinned search result (#1921). */
function buildProvenance(scope: { ref: string; source: string }, results: CorpusSearchHit[]): CorpusSearchProvenance {
  return {
    ref: scope.ref,
    source: scope.source,
    chunks: results
      .filter((hit): hit is CorpusSearchHit & { contentHash: string } => hit.contentHash !== undefined)
      .map(hit => ({ docId: hit.id, contentHash: hit.contentHash })),
  };
}

function validateThreadDocument(document: ThreadDocument): void {
  const required = [
    document.source,
    document.sourceType,
    document.id,
    document.type,
    document.title,
    document.state,
    document.author,
    document.created,
    document.updated,
    document.body,
  ];
  if (required.some(value => typeof value !== 'string')) {
    throw new Error('ThreadDocument is missing required string fields');
  }
  if (!Array.isArray(document.labels) || !Array.isArray(document.linkedRefs) || !Array.isArray(document.comments)) {
    throw new Error('ThreadDocument is missing required array fields');
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, Math.floor(value)));
}

function scoreRow(row: StoredSearchRow): number {
  // SQLite FTS5's bm25() returns a negative real number where a *smaller*
  // (more negative) value means a *better* match. Flip the sign so larger
  // means better, then squash into [0, 1) with x / (1 + x) — monotonic in
  // match quality and keeps the resolution boost meaningful for close ties.
  const normalizedRank = Math.max(0, -row.rank);
  const base = normalizedRank / (1 + normalizedRank);
  const resolutionBoost = row.resolution?.kind === 'fixed' || row.resolution?.kind === 'merged' ? 0.15 : 0;

  return Math.min(1, Number((base + resolutionBoost).toFixed(6)));
}

function buildEvidence(row: StoredSearchRow, query: string, tokenBudget: number): string[] {
  if (tokenBudget <= 0) {
    return [];
  }

  const document: ThreadDocument = {
    source: row.source,
    sourceType: row.sourceType,
    id: row.docId,
    type: row.threadType,
    title: row.title,
    state: row.state,
    labels: row.labels,
    author: row.author,
    created: row.updated,
    updated: row.updated,
    linkedRefs: [],
    body: row.body,
    comments: row.comments,
    resolution: row.resolution,
    url: row.url,
  };
  const evidenceText = collectEvidenceText(document);
  const excerpt = excerptAroundQuery(evidenceText, query, tokenBudget);
  const truncated = truncateToTokenBudget(excerpt, tokenBudget);

  return truncated ? [truncated] : [];
}

function excerptAroundQuery(text: string, query: string, tokenBudget: number): string {
  const charBudget = Math.max(0, tokenBudget * 4);
  if (text.length <= charBudget) {
    return text;
  }

  const firstTerm = query.match(/[\p{L}\p{N}_-]+/u)?.[0].toLowerCase();
  const index = firstTerm ? text.toLowerCase().indexOf(firstTerm) : -1;
  if (index < 0) {
    return text.slice(0, charBudget);
  }

  const start = Math.max(0, index - Math.floor(charBudget / 3));
  return text.slice(start, start + charBudget);
}
