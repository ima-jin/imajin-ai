/**
 * Shared types for the Corpus Service (#1726).
 *
 * These types are the contract between corpus *adapters* (e.g. the GitHub
 * adapter in `../adapters/github.ts`) and the corpus *engine* (#1728). Adapters
 * produce `ThreadDocument`s; the engine indexes and searches them. Neither
 * side depends on the other's implementation — only on this file — so the two
 * can be built and shipped independently.
 */

/**
 * Where a `ThreadDocument` originated. The open union (`string & {}`) lets
 * adapters introduce new source types without a change here, while still
 * giving autocomplete for the known ones.
 */
export type SourceType =
  | 'github'
  | 'gitlab'
  | 'gdocs'
  | 'discord'
  | 'slack'
  | 'local'
  | 'email'
  | 'code'
  | (string & {});

export type ThreadState = 'open' | 'closed' | 'merged' | 'archived' | 'draft' | 'unknown';

export type ThreadType = 'issue' | 'pr' | 'discussion' | 'doc' | 'thread' | 'email' | 'code' | (string & {});

/** A single comment/reply/review within a thread, in chronological order. */
export interface ThreadComment {
  author: string;
  authorDid?: string;
  body: string;
  /** ISO 8601 timestamp. */
  created: string;
  type?: 'comment' | 'review' | 'system' | 'reaction' | (string & {});
  /** Id of the comment this one is replying to, if the source models that. */
  replyTo?: string;
}

/** How a thread was resolved, if it has been. */
export interface ThreadResolution {
  kind: 'fixed' | 'wontfix' | 'duplicate' | 'stale' | 'merged' | 'other';
  note?: string;
  /** Source-scoped reference to whatever closed/fixed this thread, e.g. "#123". */
  fixedBy?: string;
}

/**
 * A normalized, source-agnostic representation of a "thread" — an issue, PR,
 * discussion, doc, email thread, etc. This is the unit the corpus engine
 * indexes and searches over.
 */
export interface ThreadDocument {
  /** e.g. "github:ima-jin/imajin-ai" */
  source: string;
  sourceType: SourceType;
  /** Source-scoped, stable id. `source + id` is the dedup key. */
  id: string;
  type: ThreadType;
  title: string;
  state: ThreadState;
  labels: string[];
  author: string;
  authorDid?: string;
  /** ISO 8601 timestamp. */
  created: string;
  /** ISO 8601 timestamp, if closed. */
  closed?: string;
  /** ISO 8601 timestamp of the last update. */
  updated: string;
  /** References to other threads/URLs found in the body or timeline. */
  linkedRefs: string[];
  body: string;
  comments: ThreadComment[];
  resolution?: ThreadResolution;
  url?: string;
  meta?: Record<string, unknown>;
}

export interface AdapterFetchOptions {
  /** Maximum number of documents to yield/return. */
  limit?: number;
  signal?: AbortSignal;
}

export interface AdapterSyncResult {
  documents: ThreadDocument[];
  /** Opaque cursor to pass to the next `sync()` call, or null if unavailable. */
  cursor: string | null;
  /** True if this call did not exhaust all changes since `cursor`. */
  hasMore: boolean;
}

/**
 * A corpus adapter fetches and normalizes documents from one external
 * source (GitHub, GitLab, Slack, etc.) into `ThreadDocument`s.
 */
export interface CorpusAdapter {
  readonly sourceType: SourceType;
  /** Full fetch of every document for `source`, streamed as it is produced. */
  fetch(source: string, options?: AdapterFetchOptions): AsyncIterable<ThreadDocument>;
  /** Incremental fetch of documents updated since `cursor`. */
  sync(source: string, cursor: string | null, options?: AdapterFetchOptions): Promise<AdapterSyncResult>;
}

/** Retrieval strategy for `CorpusEngine.search` (#1599, #1601). */
export type CorpusSearchMode = 'bm25' | 'semantic' | 'hybrid';

export interface CorpusSearchRequest {
  query: string;
  sourceType?: SourceType;
  source?: string;
  state?: ThreadState | ThreadState[];
  type?: ThreadType | ThreadType[];
  labels?: string[];
  author?: string;
  limit?: number;
  budget?: number;
  /**
   * Pin the query to a previously-ingested git sha for `source` (#1921).
   * Only meaningful for git-backed repo sources ingested via the
   * `local:workspace` path — `source` is required when `ref` is set, and an
   * unindexed `(source, ref)` pair throws `UnknownRefError` rather than
   * silently falling back to the live index.
   */
  ref?: string;
  /**
   * Force a retrieval strategy (#1599, #1601). Defaults to `hybrid` when a
   * PGX embedder is configured, `bm25` otherwise. Always downgraded to
   * `bm25` for a `ref`-pinned query, regardless of this field — see
   * `CorpusEngine.search`.
   */
  mode?: CorpusSearchMode;
}

export interface CorpusSearchHit {
  source: string;
  id: string;
  type: ThreadType;
  title: string;
  state: ThreadState;
  resolution?: ThreadResolution;
  score: number;
  evidence: string[];
  url?: string;
  updated: string;
  /** Content hash of the snapshot version matched, present only for `ref`-pinned queries. */
  contentHash?: string;
  /**
   * Ingestion attestation that wrote/last-touched this thread (#1750), a
   * plain stored column on the same `SELECT` `search()` already runs — no
   * join, no added latency. Undefined for rows ingested before the corpus
   * service had a signing identity configured.
   */
  attestationId?: string;
}

export interface CorpusSourceFreshness {
  source: string;
  lastSync: string;
  threadCount: number;
  warning?: string;
  credentialRef?: string;
  error?: string;
}

/** Provenance of a ref-pinned search result, for reproducibility audits (#1921). */
export interface CorpusSearchProvenance {
  ref: string;
  source: string;
  chunks: { docId: string; contentHash: string }[];
}

export interface CorpusSearchResult {
  results: CorpusSearchHit[];
  totalHits: number;
  freshness: CorpusSourceFreshness[];
  tokensUsed: number;
  /** Present only when the request was pinned to a `ref`. */
  provenance?: CorpusSearchProvenance;
  /** Retrieval strategy actually used to produce `results` (#1599, #1601). */
  mode: CorpusSearchMode;
  /**
   * Present only when a requested capability couldn't run and the response
   * silently fell back instead of erroring — e.g. `['semantic']` when PGX
   * embedding failed and results are BM25-only, or `['rerank']` when the
   * PGX reranker was unavailable but semantic retrieval still ran.
   */
  degraded?: ('semantic' | 'rerank')[];
}

/** Ingestion-attestation counters (#1750) surfaced on `GET /corpus/:did/status`. */
export interface CorpusAttestationStats {
  total: number;
  pendingForward: number;
}

export interface CorpusStatus {
  sources: CorpusSourceFreshness[];
  threadCount: number;
  /** Embedding chunks awaiting (or re-awaiting, after a failed attempt) a PGX embed pass (#1599, #1601). */
  pendingEmbeddings: number;
  attestations: CorpusAttestationStats;
}

/**
 * A corpus-signed ingestion attestation (#1750): the corpus service's own,
 * low-latency record that it ingested `threadCount` documents for `source`
 * at `timestamp`, signed with its own service DID key (never the kernel's).
 * Forwarded (fire-and-forget) to the kernel's durable `auth.attestations`
 * as the cross-service record — see `apps/corpus/src/lib/attestation-forwarder.ts`.
 */
export interface IngestionAttestation {
  /** Corpus-local id (e.g. "ing_xxx"), distinct from the kernel's auth.attestations.id. */
  id: string;
  /** e.g. "github:ima-jin/imajin-ai" */
  source: string;
  /**
   * The corpus DID this ingestion targets. Today this is the `:did` route
   * param (the existing partition key — see `CorpusStore.databaseForDid`),
   * pending #1749's `resolveCorpusDid(source)` landing separately.
   */
  corpusDid: string;
  /** DID from the CorpusAccessClaim that authorized this ingest. */
  ingesterDid: string;
  /** sha256 over the sorted (docId, updated) pairs of the ingested batch. */
  contentHash: string;
  /** Documents written in this batch (for this source). */
  threadCount: number;
  /** ISO 8601. */
  timestamp: string;
  /** Ed25519 hex — corpus DID signs canonicalize({source, corpusDid, ingesterDid, contentHash, threadCount, timestamp}). */
  signature: string;
}
