import { collectEvidenceText } from './chunker';
import { CorpusStore, type CorpusStoreOptions, type StoredSearchRow } from './store';
import type {
  CorpusSearchHit,
  CorpusSearchMode,
  CorpusSearchProvenance,
  CorpusSearchRequest,
  CorpusSearchResult,
  CorpusStatus,
  IngestionAttestation,
  ThreadDocument,
} from './types';
import { PgxNotConfiguredError, PgxUnavailableError } from './errors';
import { addFreshnessWarnings } from '../lib/freshness';
import { forwardIngestionAttestation } from '../lib/attestation-forwarder';
import { loadCorpusIdentity } from '../lib/corpus-identity';
import { PgxClient } from '../lib/pgx-client';
import { DEFAULT_SEARCH_LIMIT, DEFAULT_TOKEN_BUDGET, estimateTokens, truncateToTokenBudget } from '../lib/tokens';

type DegradedCapability = 'semantic' | 'rerank';

/** How many chunks past `chunk_no` boundaries are considered per KNN pass — candidate pool before rerank/merge. */
const DEFAULT_SEMANTIC_CANDIDATES = 20;
/** Cap on how much of a candidate's text is sent to the PGX reranker per document. */
const RERANK_DOC_CHARS = 2000;

interface HybridCandidate {
  row: StoredSearchRow;
  bm25Score?: number;
  vectorScore?: number;
}

/** Signed view of an ingestion attestation returned by `GET /corpus/:did/attestations/:id` (#1750). */
export interface SignedAttestationView {
  attestation: IngestionAttestation;
  corpusPublicKey: string;
}

export interface CorpusEngineOptions extends CorpusStoreOptions {
  now?: () => Date;
  /** Injectable for tests — defaults to a `PgxClient` reading `PGX_EMBED_URL`/`PGX_RERANK_URL` from env. */
  pgxClient?: PgxClient;
  /** Vector KNN candidate pool size per query. Defaults to 20. */
  semanticCandidates?: number;
}

export class CorpusEngine {
  private readonly store: CorpusStore;
  private readonly now: () => Date;
  private readonly pgxClient: PgxClient;
  private readonly semanticCandidates: number;

  constructor(options: CorpusEngineOptions = {}) {
    this.store = new CorpusStore(options);
    this.now = options.now ?? (() => new Date());
    this.pgxClient = options.pgxClient ?? new PgxClient();
    this.semanticCandidates = options.semanticCandidates ?? DEFAULT_SEMANTIC_CANDIDATES;
  }

  close(): void {
    this.store.close();
  }

  /**
   * Ingests `documents`, signing+persisting an `IngestionAttestation` per
   * source when a corpus identity is configured, then fire-and-forgets a
   * forward to the kernel for every attestation just created plus any still
   * pending from earlier ingests (#1750). `ingesterDid` defaults to `did`
   * when a caller (e.g. a direct engine test) doesn't supply one.
   */
  ingest(did: string, documents: ThreadDocument[], ref?: string, ingesterDid: string = did): { ingested: number } {
    validateDid(did);
    for (const document of documents) {
      validateThreadDocument(document);
    }

    const identity = loadCorpusIdentity();
    const attestations = this.store.ingest(did, documents, this.now().toISOString(), ref, identity, ingesterDid);

    if (identity) {
      for (const attestation of attestations) {
        this.forwardAttestation(did, identity.did, attestation);
      }
      for (const pending of this.store.listPendingForwards(did)) {
        this.forwardAttestation(did, identity.did, pending);
      }
    }

    return { ingested: documents.length };
  }

  /**
   * Embeds up to `limit` chunks still marked `pending` (#1599, #1601) and
   * stores their vectors. Safe to call repeatedly — e.g. fire-and-forget
   * after every ingest, or from a periodic sweep — since a PGX failure
   * leaves every chunk in this batch `pending` again for the next call
   * rather than throwing. Returns `{ embedded: 0, failed: 0 }` immediately
   * when no PGX embedder is configured or there is nothing to do.
   */
  async embedPending(did: string, limit = 100): Promise<{ embedded: number; failed: number }> {
    validateDid(did);
    if (!this.pgxClient.isConfigured()) {
      return { embedded: 0, failed: 0 };
    }

    const chunks = this.store.pendingChunks(did, limit);
    if (chunks.length === 0) {
      return { embedded: 0, failed: 0 };
    }

    try {
      const vectors = await this.pgxClient.embed(chunks.map(chunk => chunk.chunkText));
      chunks.forEach((chunk, index) => this.store.storeChunkEmbedding(did, chunk.id, vectors[index]));
      return { embedded: chunks.length, failed: 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const chunk of chunks) {
        this.store.markChunkFailed(did, chunk.id, message);
      }
      return { embedded: 0, failed: chunks.length };
    }
  }

  /** Fire-and-forget: never awaited by callers, records the outcome back onto the stored row. */
  private forwardAttestation(did: string, corpusServiceDid: string, attestation: IngestionAttestation): void {
    forwardIngestionAttestation(attestation, corpusServiceDid)
      .then(result => this.store.recordForwardResult(did, attestation.id, result))
      .catch(() => {
        this.store.recordForwardResult(did, attestation.id, { ok: false, error: 'unexpected forward failure' });
      });
  }

  /**
   * Returns the signed payload + corpus public key for a previously-created
   * ingestion attestation. Naturally DID-isolated: `id` is looked up only
   * within `did`'s own corpus database (#1750).
   */
  getAttestation(did: string, id: string): SignedAttestationView {
    validateDid(did);
    if (!id) {
      throw new Error('id is required');
    }
    return this.store.getAttestation(did, id);
  }

  async search(did: string, request: CorpusSearchRequest): Promise<CorpusSearchResult> {
    validateDid(did);
    validateSearchRequest(request);

    const limit = clampInteger(request.limit ?? DEFAULT_SEARCH_LIMIT, 1, 100);
    const budget = clampInteger(request.budget ?? DEFAULT_TOKEN_BUDGET, 0, 100_000);

    // Ref-pinned queries (#1921) always stay BM25-only: the vector index has
    // no notion of "as of this ref", so a pinned query must never surface a
    // chunk embedded after that ref. See vector-store.ts's module comment.
    if (request.ref && request.source) {
      const rows = this.store.searchAtRef(did, request.source, request.ref, { ...request, limit });
      return this.buildSearchResult(did, sortedByBm25(rows), request.query, budget, 'bm25', {
        provenanceScope: { ref: request.ref, source: request.source },
      });
    }

    const bm25Rows = this.store.search(did, { ...request, limit });
    if (!this.shouldAttemptSemantic(request)) {
      return this.buildSearchResult(did, sortedByBm25(bm25Rows), request.query, budget, 'bm25');
    }

    return this.searchWithSemantics(did, request, bm25Rows, limit, budget);
  }

  private shouldAttemptSemantic(request: CorpusSearchRequest): boolean {
    if (request.mode === 'bm25') return false;
    if (!request.mode && !this.pgxClient.isConfigured()) return false;
    return true;
  }

  private async searchWithSemantics(
    did: string,
    request: CorpusSearchRequest,
    bm25Rows: StoredSearchRow[],
    limit: number,
    budget: number,
  ): Promise<CorpusSearchResult> {
    const degraded: DegradedCapability[] = [];
    const semanticOnly = request.mode === 'semantic';

    const semanticRows = await this.retrieveSemanticRows(did, request.query, degraded);
    if (semanticRows === null) {
      return this.buildSearchResult(did, sortedByBm25(bm25Rows), request.query, budget, 'bm25', { degraded });
    }

    const candidates = buildHybridCandidates(semanticOnly ? [] : bm25Rows, semanticRows);
    const ranked = await this.rerankCandidates(candidates, request.query, degraded);
    const finalRows = ranked.slice(0, limit).map(candidate => ({ row: candidate.row, score: combinedScore(candidate) }));

    return this.buildSearchResult(did, finalRows, request.query, budget, semanticOnly ? 'semantic' : 'hybrid', { degraded });
  }

  /** Embeds `query` and runs the vector KNN. Returns `null` (never throws) when PGX embedding isn't available. */
  private async retrieveSemanticRows(
    did: string,
    query: string,
    degraded: DegradedCapability[],
  ): Promise<Map<number, { row: StoredSearchRow; vectorScore: number }> | null> {
    let queryVectors: number[][];
    try {
      queryVectors = await this.pgxClient.embed([query]);
    } catch (error) {
      if (!(error instanceof PgxNotConfiguredError) && !(error instanceof PgxUnavailableError)) {
        throw error;
      }
      degraded.push('semantic');
      return null;
    }

    const queryVector = queryVectors[0];
    if (!queryVector) {
      degraded.push('semantic');
      return null;
    }

    const hits = this.store.semanticSearch(did, queryVector, this.semanticCandidates);
    return this.hitsToRowsByThreadPk(did, hits);
  }

  private hitsToRowsByThreadPk(
    did: string,
    hits: { threadPk: number; distance: number }[],
  ): Map<number, { row: StoredSearchRow; vectorScore: number }> {
    const bestDistanceByPk = new Map<number, number>();
    for (const hit of hits) {
      const existing = bestDistanceByPk.get(hit.threadPk);
      if (existing === undefined || hit.distance < existing) {
        bestDistanceByPk.set(hit.threadPk, hit.distance);
      }
    }

    const rows = this.store.getThreadsByPk(did, [...bestDistanceByPk.keys()]);
    const rowsByPk = new Map<number, StoredSearchRow>();
    for (const row of rows) {
      if (row.threadPk !== undefined) {
        rowsByPk.set(row.threadPk, row);
      }
    }

    const result = new Map<number, { row: StoredSearchRow; vectorScore: number }>();
    for (const [threadPk, distance] of bestDistanceByPk) {
      const row = rowsByPk.get(threadPk);
      if (row) {
        result.set(threadPk, { row, vectorScore: vectorDistanceToScore(distance) });
      }
    }
    return result;
  }

  /** Reranks `candidates` via the PGX when configured; otherwise (or on failure) sorts by `combinedScore` descending. */
  private async rerankCandidates(
    candidates: HybridCandidate[],
    query: string,
    degraded: DegradedCapability[],
  ): Promise<HybridCandidate[]> {
    const byCombinedScore = [...candidates].sort((left, right) => combinedScore(right) - combinedScore(left));
    if (!this.pgxClient.hasRerank() || byCombinedScore.length === 0) {
      return byCombinedScore;
    }

    try {
      const docs = byCombinedScore.map(candidate => collectEvidenceText(rowToThreadDocument(candidate.row)).slice(0, RERANK_DOC_CHARS));
      const reranked = await this.pgxClient.rerank(query, docs);
      const reordered = reranked.map(result => byCombinedScore[result.index]).filter((c): c is HybridCandidate => c !== undefined);
      return reordered.length === byCombinedScore.length ? reordered : byCombinedScore;
    } catch {
      degraded.push('rerank');
      return byCombinedScore;
    }
  }

  private buildSearchResult(
    did: string,
    scoredRows: { row: StoredSearchRow; score: number }[],
    query: string,
    budget: number,
    mode: CorpusSearchMode,
    options: { provenanceScope?: { ref: string; source: string }; degraded?: DegradedCapability[] } = {},
  ): CorpusSearchResult {
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
        attestationId: scoredRow.row.attestationId,
      });
    }

    const degraded = options.degraded;
    return {
      results,
      totalHits: scoredRows.length,
      freshness: this.freshness(did),
      tokensUsed,
      provenance: options.provenanceScope ? buildProvenance(options.provenanceScope, results) : undefined,
      mode,
      degraded: degraded && degraded.length > 0 ? degraded : undefined,
    };
  }

  status(did: string): CorpusStatus {
    validateDid(did);
    const status = this.store.status(did);
    return {
      sources: addFreshnessWarnings(status.sources, this.now()),
      threadCount: status.threadCount,
      pendingEmbeddings: status.pendingEmbeddings,
      attestations: status.attestations,
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
    throw new TypeError('ThreadDocument is missing required array fields');
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

/** Reconstructs a `ThreadDocument` from a `StoredSearchRow` — enough to feed `collectEvidenceText`. `created` isn't stored on the row, so `updated` stands in; it's never read by the chunker. */
function rowToThreadDocument(row: StoredSearchRow): ThreadDocument {
  return {
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
}

function sortedByBm25(rows: StoredSearchRow[]): { row: StoredSearchRow; score: number }[] {
  return rows.map(row => ({ row, score: scoreRow(row) })).sort((left, right) => right.score - left.score);
}

function rowKey(row: StoredSearchRow): string {
  return `${row.source}\u0000${row.docId}`;
}

/** Maps a cosine distance in `[0, 2]` (0 = identical) to a `[0, 1]` similarity-style score. */
function vectorDistanceToScore(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance));
}

function combinedScore(candidate: HybridCandidate): number {
  return Math.max(candidate.bm25Score ?? 0, candidate.vectorScore ?? 0);
}

/** Merges BM25 and vector candidates into one deduped list, keyed by `(source, docId)`. */
function buildHybridCandidates(
  bm25Rows: StoredSearchRow[],
  semanticRowsByThreadPk: Map<number, { row: StoredSearchRow; vectorScore: number }>,
): HybridCandidate[] {
  const candidates = new Map<string, HybridCandidate>();
  for (const row of bm25Rows) {
    candidates.set(rowKey(row), { row, bm25Score: scoreRow(row) });
  }
  for (const { row, vectorScore } of semanticRowsByThreadPk.values()) {
    const key = rowKey(row);
    const existing = candidates.get(key);
    if (existing) {
      existing.vectorScore = vectorScore;
    } else {
      candidates.set(key, { row, vectorScore });
    }
  }
  return [...candidates.values()];
}

function buildEvidence(row: StoredSearchRow, query: string, tokenBudget: number): string[] {
  if (tokenBudget <= 0) {
    return [];
  }

  const evidenceText = collectEvidenceText(rowToThreadDocument(row));
  const excerpt = excerptAroundQuery(evidenceText, query, tokenBudget);
  const truncated = truncateToTokenBudget(excerpt, tokenBudget);

  return truncated ? [truncated] : [];
}

function excerptAroundQuery(text: string, query: string, tokenBudget: number): string {
  const charBudget = Math.max(0, tokenBudget * 4);
  if (text.length <= charBudget) {
    return text;
  }

  const firstTerm = /[\p{L}\p{N}_-]+/u.exec(query)?.[0].toLowerCase();
  const index = firstTerm ? text.toLowerCase().indexOf(firstTerm) : -1;
  if (index < 0) {
    return text.slice(0, charBudget);
  }

  const start = Math.max(0, index - Math.floor(charBudget / 3));
  return text.slice(start, start + charBudget);
}
