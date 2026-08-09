/**
 * Shared types for the Corpus Service (#1726).
 *
 * These types are the contract between corpus *adapters* (e.g. the GitHub
 * adapter in `../adapters/github.ts`) and the corpus *engine* (#1728, not yet
 * built). Adapters produce `ThreadDocument`s; the engine indexes and searches
 * them. Neither side depends on the other's implementation — only on this
 * file — so the two can be built and shipped independently.
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
