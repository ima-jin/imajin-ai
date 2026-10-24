import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { crypto as authCrypto } from '@imajin/auth';
import { buildIngestionAttestation } from './attestation';
import { chunkThread, type ThreadChunk } from './chunker';
import { AttestationNotFoundError, UnknownRefError } from './errors';
import type { CorpusIdentity } from '../lib/corpus-identity';
import { migrateOwnerSchema, transferSource } from './owner-transfer';
import type {
  CorpusAttestationStats,
  CorpusSearchRequest,
  CorpusSourceFreshness,
  CorpusStatus,
  IngestionAttestation,
  ThreadDocument,
  ThreadResolution,
  ThreadState,
  ThreadType,
} from './types';
import {
  deleteChunksForThreads,
  loadVectorExtension,
  listPendingChunks,
  markChunkPendingWithError,
  migrateVectorSchema,
  pendingChunkCount,
  searchSemantic,
  storeEmbedding,
  upsertPendingChunksForThread,
  type PendingEmbeddingChunk,
  type SemanticHit,
} from './vector-store';

/** Bounds how many pending forwards a single `ingest()` call retries (#1750). */
const MAX_FORWARD_RETRY_BATCH = 5;
/** After this many failed attempts, a pending forward is no longer retried automatically. */
const MAX_FORWARD_ATTEMPTS = 10;

/**
 * Default retention knobs for ref-pinned snapshots (#1921): keep the most
 * recent `maxRefsPerSource` refs per source, or any ref ingested within the
 * last `refRetentionDays` days, whichever keeps more. Mirrors the
 * `DEFAULT_STALE_AFTER_DAYS` constructor-option pattern in `../lib/freshness.ts`.
 */
export const DEFAULT_MAX_REFS_PER_SOURCE = 20;
export const DEFAULT_REF_RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface StoredSearchRow {
  source: string;
  docId: string;
  sourceType: string;
  threadType: ThreadType;
  state: ThreadState;
  labels: string[];
  author: string;
  title: string;
  body: string;
  comments: ThreadDocument['comments'];
  resolution?: ThreadResolution;
  url?: string;
  updated: string;
  rank: number;
  /** Content hash of the matched snapshot version; set only for ref-pinned queries (#1921). */
  contentHash?: string;
  /** Internal `threads.pk`; set only by `getThreadsByPk` (#1599), used to key semantic-hit merges. */
  threadPk?: number;
  /** Ingestion attestation that wrote/last-touched this thread (#1750). */
  attestationId?: string;
}

interface ThreadRow {
  pk: number;
  source: string;
  doc_id: string;
  source_type: string;
  thread_type: ThreadType;
  state: ThreadState;
  labels_json: string;
  author: string;
  title: string;
  body: string;
  comments_json: string;
  resolution_json: string | null;
  url: string | null;
  updated: string;
  rank: number;
  attestation_id: string | null;
}

interface SourceRow {
  source: string;
  last_sync: string;
  thread_count: number;
}

/** Row shape returned by the `blob_fts`/`thread_blobs`/`thread_versions` join in `searchAtRef` (#1921). */
interface BlobSearchRow {
  source: string;
  doc_id: string;
  title: string;
  body: string;
  comments_json: string;
  state: ThreadState;
  thread_type: ThreadType;
  labels_json: string;
  author: string;
  url: string | null;
  updated: string;
  content_hash: string;
  rank: number;
}

/** Row shape for `ingestion_attestations` (#1750). */
interface AttestationRow {
  id: string;
  owner_did: string;
  source: string;
  corpus_did: string;
  ingester_did: string;
  content_hash: string;
  doc_count: number;
  ref: string | null;
  signed_at: string;
  signature: string;
  signer_public_key: string;
  payload_json: string;
  forwarded_at: string | null;
  kernel_attestation_id: string | null;
  forward_error: string | null;
  forward_attempts: number;
}

export interface CorpusStoreOptions {
  dataDir?: string;
  /** Keep the most recent N distinct refs per source (#1921 retention). Default 20. */
  maxRefsPerSource?: number;
  /** Also keep any ref ingested within this many days, whichever set is larger. Default 30. */
  refRetentionDays?: number;
}

export class CorpusStore {
  private readonly rootDir: string;
  private readonly maxRefsPerSource: number;
  private readonly refRetentionDays: number;
  private readonly handles = new Map<string, Database.Database>();

  constructor(options: CorpusStoreOptions = {}) {
    this.rootDir = options.dataDir ?? join(process.cwd(), 'data', 'corpus');
    this.maxRefsPerSource = options.maxRefsPerSource ?? DEFAULT_MAX_REFS_PER_SOURCE;
    this.refRetentionDays = options.refRetentionDays ?? DEFAULT_REF_RETENTION_DAYS;
  }

  close(): void {
    for (const db of this.handles.values()) {
      db.close();
    }
    this.handles.clear();
  }

  transferSource(fromDid: string, toDid: string, source: string, identity: CorpusIdentity): { moved: number } {
    this.databaseForDid(fromDid);
    const target = this.databaseForDid(toDid);
    const hash = createHash('sha256').update(fromDid).digest('hex');
    return transferSource(target, join(this.rootDir, hash, 'index.db'), source, fromDid, toDid, identity);
  }

  /**
   * Ingests `documents`, then — when `identity` is provided — builds, signs,
   * and persists one `IngestionAttestation` per distinct `source` in the
   * batch, backfilling `threads.attestation_id` for exactly the rows just
   * written (#1750). Returns the attestations created so `CorpusEngine` can
   * forward them to the kernel; empty when `identity` is `null` (no
   * CORPUS_DID/CORPUS_DID_PRIVATE_KEY configured) — ingestion always
   * succeeds either way.
   */
  ingest(
    did: string,
    documents: ThreadDocument[],
    syncedAt = new Date().toISOString(),
    ref?: string,
    identity: CorpusIdentity | null = null,
    ingesterDid: string = did,
  ): IngestionAttestation[] {
    const db = this.databaseForDid(did);
    for (const source of new Set(documents.map(document => document.source))) {
      this.assertSourceActive(db, source, did);
    }
    const upsertThread = db.prepare(`
      INSERT INTO threads (
        source, doc_id, source_type, thread_type, state, labels_json, author, author_did,
        created, closed, updated, linked_refs_json, title, body, comments_json,
        resolution_json, url, meta_json, search_text, ingested_at
      ) VALUES (
        @source, @docId, @sourceType, @threadType, @state, @labelsJson, @author, @authorDid,
        @created, @closed, @updated, @linkedRefsJson, @title, @body, @commentsJson,
        @resolutionJson, @url, @metaJson, @searchText, @ingestedAt
      )
      ON CONFLICT(source, doc_id) DO UPDATE SET
        source_type = excluded.source_type,
        thread_type = excluded.thread_type,
        state = excluded.state,
        labels_json = excluded.labels_json,
        author = excluded.author,
        author_did = excluded.author_did,
        created = excluded.created,
        closed = excluded.closed,
        updated = excluded.updated,
        linked_refs_json = excluded.linked_refs_json,
        title = excluded.title,
        body = excluded.body,
        comments_json = excluded.comments_json,
        resolution_json = excluded.resolution_json,
        url = excluded.url,
        meta_json = excluded.meta_json,
        search_text = excluded.search_text,
        ingested_at = excluded.ingested_at
    `);
    const selectThreadPk = db.prepare('SELECT pk FROM threads WHERE source = ? AND doc_id = ?');
    const deleteFts = db.prepare('DELETE FROM thread_fts WHERE rowid = ?');
    const insertFts = db.prepare('INSERT INTO thread_fts(rowid, title, body, comments) VALUES (?, ?, ?, ?)');
    const updateThreadAttestation = db.prepare('UPDATE threads SET attestation_id = ? WHERE source = ? AND doc_id = ?');
    const insertAttestation = this.prepareInsertAttestation(db);
    const blobStatements = this.prepareBlobStatements(db);

    const createdAttestations: IngestionAttestation[] = [];

    const transaction = db.transaction((batch: ThreadDocument[]) => {
      for (const document of batch) {
        const chunk = chunkThread(document);
        upsertThread.run({
          source: document.source,
          docId: document.id,
          sourceType: document.sourceType,
          threadType: document.type,
          state: document.state,
          labelsJson: JSON.stringify(document.labels),
          author: document.author,
          authorDid: document.authorDid ?? null,
          created: document.created,
          closed: document.closed ?? null,
          updated: document.updated,
          linkedRefsJson: JSON.stringify(document.linkedRefs),
          title: document.title,
          body: document.body,
          commentsJson: JSON.stringify(document.comments),
          resolutionJson: document.resolution ? JSON.stringify(document.resolution) : null,
          url: document.url ?? null,
          metaJson: document.meta ? JSON.stringify(document.meta) : null,
          searchText: chunk.searchText,
          ingestedAt: syncedAt,
        });

        const row = selectThreadPk.get(document.source, document.id) as { pk: number } | undefined;
        if (!row) {
          throw new Error(`Failed to read stored thread ${document.source}:${document.id}`);
        }

        deleteFts.run(row.pk);
        insertFts.run(row.pk, chunk.title, chunk.body, chunk.comments);
        upsertPendingChunksForThread(db, row.pk, document, did, hashChunkText, syncedAt);

        if (ref) {
          this.recordBlobVersion(blobStatements, document, chunk, ref, syncedAt);
        }
      }

      const sources = new Set(batch.map(document => document.source));
      for (const source of sources) {
        this.refreshSource(db, source, syncedAt);
        if (ref) {
          this.pruneVersions(db, source, syncedAt);
        }

        if (!identity) continue;

        const attestation = this.signSourceAttestation({
          identity,
          source,
          did,
          ingesterDid,
          ref,
          syncedAt,
          sourceDocuments: batch.filter(document => document.source === source),
          insertAttestation,
          updateThreadAttestation,
        });
        createdAttestations.push(attestation);
      }
    });

    transaction(documents);
    return createdAttestations;
  }

  /** Builds, signs, and persists one `IngestionAttestation` for `source`'s slice of a batch; backfills `threads.attestation_id` for those rows. */
  private signSourceAttestation(params: {
    identity: CorpusIdentity;
    source: string;
    did: string;
    ingesterDid: string;
    ref: string | undefined;
    syncedAt: string;
    sourceDocuments: ThreadDocument[];
    insertAttestation: Database.Statement;
    updateThreadAttestation: Database.Statement;
  }): IngestionAttestation {
    const { identity, source, did, ingesterDid, ref, syncedAt, sourceDocuments, insertAttestation, updateThreadAttestation } = params;

    const attestation = buildIngestionAttestation({
      identity,
      source,
      corpusDid: did,
      ingesterDid,
      documentPairs: sourceDocuments.map(document => ({ docId: document.id, updated: document.updated })),
      timestamp: syncedAt,
    });

    insertAttestation.run({
      id: attestation.id,
      ownerDid: did,
      source: attestation.source,
      corpusDid: attestation.corpusDid,
      ingesterDid: attestation.ingesterDid,
      contentHash: attestation.contentHash,
      docCount: attestation.threadCount,
      ref: ref ?? null,
      signedAt: attestation.timestamp,
      signature: attestation.signature,
      signerPublicKey: authCrypto.getPublicKey(identity.privateKey),
      payloadJson: JSON.stringify(attestation),
    });

    for (const document of sourceDocuments) {
      updateThreadAttestation.run(attestation.id, source, document.id);
    }

    return attestation;
  }

  search(did: string, request: Required<Pick<CorpusSearchRequest, 'limit'>> & CorpusSearchRequest): StoredSearchRow[] {
    const db = this.databaseForDid(did);
    const matchQuery = toFtsQuery(request.query);
    if (!matchQuery) {
      return [];
    }

    const where: string[] = ['thread_fts MATCH @matchQuery', 't.source NOT IN (SELECT source FROM corpus_owner_transfers WHERE from_did = @ownerDid)'];
    const params: Record<string, unknown> = { matchQuery, limit: request.limit, ownerDid: did };

    if (request.sourceType) {
      where.push('t.source_type = @sourceType');
      params.sourceType = request.sourceType;
    }
    if (request.source) {
      where.push('t.source = @source');
      params.source = request.source;
    }
    appendArrayFilter(where, params, 'state', 't.state', request.state);
    appendArrayFilter(where, params, 'type', 't.thread_type', request.type);
    if (request.author) {
      where.push('t.author = @author');
      params.author = request.author;
    }
    if (request.labels?.length) {
      request.labels.forEach((label, index) => {
        where.push(`EXISTS (SELECT 1 FROM json_each(t.labels_json) WHERE value = @label${index})`);
        params[`label${index}`] = label;
      });
    }

    const rows = db
      .prepare(`
        SELECT
          t.pk,
          t.source,
          t.doc_id,
          t.source_type,
          t.thread_type,
          t.state,
          t.labels_json,
          t.author,
          t.title,
          t.body,
          t.comments_json,
          t.resolution_json,
          t.url,
          t.updated,
          t.attestation_id,
          bm25(thread_fts, 2.0, 1.0, 1.0) AS rank
        FROM thread_fts
        JOIN threads t ON t.pk = thread_fts.rowid
        WHERE ${where.join(' AND ')}
        ORDER BY rank ASC
        LIMIT @limit
      `)
      .all(params) as ThreadRow[];

    return rows.map(row => ({
      source: row.source,
      docId: row.doc_id,
      sourceType: row.source_type,
      threadType: row.thread_type,
      state: row.state,
      labels: parseJson<string[]>(row.labels_json, []),
      author: row.author,
      title: row.title,
      body: row.body,
      comments: parseJson<ThreadDocument['comments']>(row.comments_json, []),
      resolution: row.resolution_json ? parseJson<ThreadResolution | undefined>(row.resolution_json, undefined) : undefined,
      url: row.url ?? undefined,
      updated: row.updated,
      rank: row.rank,
      threadPk: row.pk,
      attestationId: row.attestation_id ?? undefined,
    }));
  }

  /**
   * Ref-pinned search (#1921): resolves hits only from `blob_fts`/`thread_blobs`
   * rows the `(source, ref)` manifest in `thread_versions` actually points to,
   * never from the live `threads`/`thread_fts` tables. Throws `UnknownRefError`
   * when no ingest has ever recorded that `(source, ref)` pair — callers must
   * map this to a 404, never a silent fallback to HEAD.
   */
  searchAtRef(
    did: string,
    source: string,
    ref: string,
    request: Required<Pick<CorpusSearchRequest, 'limit'>> & CorpusSearchRequest,
  ): StoredSearchRow[] {
    const db = this.databaseForDid(did);
    this.assertSourceActive(db, source, did);
    this.assertRefIndexed(db, source, ref);

    const matchQuery = toFtsQuery(request.query);
    if (!matchQuery) {
      return [];
    }

    const where: string[] = ['blob_fts MATCH @matchQuery', 'tv.source = @source', 'tv.ref = @ref'];
    const params: Record<string, unknown> = { matchQuery, source, ref, limit: request.limit };
    appendArrayFilter(where, params, 'state', 'b.state', request.state);
    appendArrayFilter(where, params, 'type', 'b.thread_type', request.type);
    if (request.author) {
      where.push('b.author = @author');
      params.author = request.author;
    }

    const rows = db
      .prepare(`
        SELECT
          tv.source AS source,
          tv.doc_id AS doc_id,
          b.title,
          b.body,
          b.comments_json,
          b.state,
          b.thread_type,
          b.labels_json,
          b.author,
          b.url,
          b.updated,
          b.content_hash,
          bm25(blob_fts, 2.0, 1.0, 1.0) AS rank
        FROM blob_fts
        JOIN thread_blobs b ON b.rowid = blob_fts.rowid
        JOIN thread_versions tv ON tv.content_hash = b.content_hash
        WHERE ${where.join(' AND ')}
        ORDER BY rank ASC
        LIMIT @limit
      `)
      .all(params) as BlobSearchRow[];

    return rows.map(rowToStoredSearchRow);
  }

  status(did: string): CorpusStatus {
    const db = this.databaseForDid(did);
    const threadCount = this.freshness(did).reduce((total, source) => total + source.threadCount, 0);

    return {
      sources: this.freshness(did),
      threadCount,
      pendingEmbeddings: pendingChunkCount(db),
      attestations: this.attestationStats(db),
    };
  }

  /** Counters for `GET /corpus/:did/status`'s `attestations` field (#1750). */
  private attestationStats(db: Database.Database): CorpusAttestationStats {
    const row = db
      .prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN forwarded_at IS NULL THEN 1 ELSE 0 END) AS pending FROM ingestion_attestations')
      .get() as { total: number; pending: number | null };

    return { total: row.total, pendingForward: row.pending ?? 0 };
  }

  /**
   * Returns the signed payload for `id` under `did`'s corpus — or throws
   * `AttestationNotFoundError` when `id` doesn't exist in *this* DID's
   * database, including when it exists under a different DID's (#1750's
   * "DID isolation" requirement: each DID's attestations live in a separate
   * SQLite file, so there is nothing to filter — the lookup is naturally scoped).
   */
  getAttestation(did: string, id: string): { attestation: IngestionAttestation; corpusPublicKey: string } {
    const db = this.databaseForDid(did);
    const row = db.prepare('SELECT payload_json, signer_public_key FROM ingestion_attestations WHERE id = ?').get(id) as
      | Pick<AttestationRow, 'payload_json' | 'signer_public_key'>
      | undefined;

    if (!row) {
      throw new AttestationNotFoundError(did, id);
    }

    return {
      attestation: JSON.parse(row.payload_json) as IngestionAttestation,
      corpusPublicKey: row.signer_public_key,
    };
  }

  /**
   * Attestations still awaiting a successful forward to the kernel, oldest
   * first, capped at `limit` and excluding rows that already exhausted
   * `MAX_FORWARD_ATTEMPTS` — the bounded retry #1750 asks for.
   */
  listPendingForwards(did: string, limit: number = MAX_FORWARD_RETRY_BATCH): IngestionAttestation[] {
    const db = this.databaseForDid(did);
    const rows = db
      .prepare(
        'SELECT payload_json FROM ingestion_attestations WHERE forwarded_at IS NULL AND forward_attempts < ? ORDER BY signed_at ASC LIMIT ?',
      )
      .all(MAX_FORWARD_ATTEMPTS, limit) as Pick<AttestationRow, 'payload_json'>[];

    return rows.map(row => JSON.parse(row.payload_json) as IngestionAttestation);
  }

  /** Records the outcome of a forward attempt for `id`, incrementing its attempt counter. */
  recordForwardResult(
    did: string,
    id: string,
    result: { ok: boolean; kernelAttestationId?: string; error?: string },
  ): void {
    const db = this.databaseForDid(did);
    db.prepare(
      `UPDATE ingestion_attestations
       SET forwarded_at = ?, kernel_attestation_id = ?, forward_error = ?, forward_attempts = forward_attempts + 1
       WHERE id = ?`,
    ).run(result.ok ? new Date().toISOString() : null, result.kernelAttestationId ?? null, result.error ?? null, id);
  }

  freshness(did: string): CorpusSourceFreshness[] {
    const db = this.databaseForDid(did);
    const rows = db.prepare(`SELECT source, last_sync, thread_count FROM corpus_sources
      WHERE source NOT IN (SELECT source FROM corpus_owner_transfers WHERE from_did = ?) ORDER BY source`).all(did) as SourceRow[];

    return rows.map(row => ({
      source: row.source,
      ownerDid: did,
      lastSync: row.last_sync,
      threadCount: row.thread_count,
    }));
  }

  deleteSource(did: string, source: string): number {
    const db = this.databaseForDid(did);
    this.assertSourceActive(db, source, did);
    const selectRows = db.prepare('SELECT pk FROM threads WHERE source = ?');
    const deleteFts = db.prepare('DELETE FROM thread_fts WHERE rowid = ?');
    const deleteThreads = db.prepare('DELETE FROM threads WHERE source = ?');
    const deleteSource = db.prepare('DELETE FROM corpus_sources WHERE source = ?');

    const transaction = db.transaction(() => {
      const rows = selectRows.all(source) as { pk: number }[];
      deleteChunksForThreads(db, rows.map(row => row.pk));
      for (const row of rows) {
        deleteFts.run(row.pk);
      }
      const result = deleteThreads.run(source);
      deleteSource.run(source);
      return result.changes;
    });

    return transaction() as number;
  }

  // ─── Semantic layer (#1599, #1601) ────────────────────────────────────────

  /** Chunks awaiting an embed pass, oldest first. */
  pendingChunks(did: string, limit: number): PendingEmbeddingChunk[] {
    return listPendingChunks(this.databaseForDid(did), limit);
  }

  /** Persists `vector` for `chunkId` and marks it embedded. */
  storeChunkEmbedding(did: string, chunkId: number, vector: number[]): void {
    storeEmbedding(this.databaseForDid(did), chunkId, did, vector);
  }

  /** Leaves `chunkId` pending (for retry on the next sweep/ingest) and records why it failed. */
  markChunkFailed(did: string, chunkId: number, message: string): void {
    markChunkPendingWithError(this.databaseForDid(did), chunkId, message);
  }

  /** KNN search over `did`'s embeddings, filtered by owner_did first (see vector-store.ts). */
  semanticSearch(did: string, queryVector: number[], k: number): SemanticHit[] {
    return searchSemantic(this.databaseForDid(did), did, queryVector, k);
  }

  /** Full thread rows for a set of internal `thread_pk`s, in the same shape `search()` returns. */
  getThreadsByPk(did: string, threadPks: number[]): StoredSearchRow[] {
    if (threadPks.length === 0) return [];
    const db = this.databaseForDid(did);
    const placeholders = threadPks.map(() => '?').join(', ');
    const rows = db
      .prepare(`
        SELECT pk, source, doc_id, source_type, thread_type, state, labels_json, author, title, body, comments_json, resolution_json, url, updated
        FROM threads
        WHERE pk IN (${placeholders}) AND source NOT IN (SELECT source FROM corpus_owner_transfers WHERE from_did = ?)
      `)
      .all(...threadPks, did) as ThreadByPkRow[];

    return rows.map(row => threadRowToStoredSearchRow(row));
  }

  private databaseForDid(did: string): Database.Database {
    const didHash = createHash('sha256').update(did).digest('hex');
    const existing = this.handles.get(didHash);
    if (existing) {
      return existing;
    }

    const didDir = join(this.rootDir, didHash);
    mkdirSync(didDir, { recursive: true });
    const db = new Database(join(didDir, 'index.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    loadVectorExtension(db);
    this.migrate(db);
    migrateVectorSchema(db);
    migrateOwnerSchema(db);
    this.handles.set(didHash, db);
    return db;
  }

  private assertSourceActive(db: Database.Database, source: string, did: string): void {
    if (db.prepare('SELECT id FROM corpus_owner_transfers WHERE source = ? AND from_did = ?').get(source, did)) {
      throw new Error('Source ownership transferred; use the resolved corpus owner');
    }
  }

  private migrate(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        pk INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        thread_type TEXT NOT NULL,
        state TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        author TEXT NOT NULL,
        author_did TEXT,
        created TEXT NOT NULL,
        closed TEXT,
        updated TEXT NOT NULL,
        linked_refs_json TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        comments_json TEXT NOT NULL,
        resolution_json TEXT,
        url TEXT,
        meta_json TEXT,
        search_text TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        UNIQUE(source, doc_id)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS thread_fts USING fts5(
        title,
        body,
        comments,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS corpus_sources (
        source TEXT PRIMARY KEY,
        last_sync TEXT NOT NULL,
        thread_count INTEGER NOT NULL
      );

      -- Sha-pinned snapshot queries (#1921): thread_blobs/blob_fts are an
      -- immutable, content-addressed store of every historical version of a
      -- document ever seen; thread_versions is the manifest recording which
      -- content_hash was live for (source, doc_id) at a given git ref.
      -- Purely additive — threads/thread_fts and unpinned search() are untouched.
      CREATE TABLE IF NOT EXISTS thread_blobs (
        content_hash TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        comments_json TEXT NOT NULL,
        state TEXT NOT NULL,
        thread_type TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        author TEXT NOT NULL,
        url TEXT,
        updated TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS blob_fts USING fts5(
        title,
        body,
        comments,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS thread_versions (
        source TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        PRIMARY KEY (source, doc_id, ref)
      );

      -- Ingestion attestations (#1750): the corpus service's own signed,
      -- low-latency record that it ingested a batch of documents for
      -- (owner_did, source), independent of whether the kernel forward
      -- below has succeeded yet. "ref" is the git ref pinned at ingest time,
      -- when known — null for non-git sources (e.g. github: adapter).
      CREATE TABLE IF NOT EXISTS ingestion_attestations (
        id TEXT PRIMARY KEY,
        owner_did TEXT NOT NULL,
        source TEXT NOT NULL,
        corpus_did TEXT NOT NULL,
        ingester_did TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        doc_count INTEGER NOT NULL,
        ref TEXT,
        signed_at TEXT NOT NULL,
        signature TEXT NOT NULL,
        signer_public_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        forwarded_at TEXT,
        kernel_attestation_id TEXT,
        forward_error TEXT,
        forward_attempts INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_ingestion_attestations_pending
        ON ingestion_attestations(forwarded_at)
        WHERE forwarded_at IS NULL;
    `);

    // threads predates ingestion attestations, so existing databases need
    // this column backfilled — CREATE TABLE IF NOT EXISTS above only helps
    // brand-new databases. Safe to call on every open: it's a no-op once
    // the column exists.
    this.ensureColumn(db, 'threads', 'attestation_id', 'attestation_id TEXT');
  }

  /** Idempotently adds `column` to `table` if it isn't already present (for additive migrations on pre-existing databases). */
  private ensureColumn(db: Database.Database, table: string, column: string, ddl: string): void {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some(existing => existing.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }

  private prepareInsertAttestation(db: Database.Database): Database.Statement {
    return db.prepare(`
      INSERT INTO ingestion_attestations (
        id, owner_did, source, corpus_did, ingester_did, content_hash, doc_count, ref,
        signed_at, signature, signer_public_key, payload_json
      ) VALUES (
        @id, @ownerDid, @source, @corpusDid, @ingesterDid, @contentHash, @docCount, @ref,
        @signedAt, @signature, @signerPublicKey, @payloadJson
      )
    `);
  }

  private refreshSource(db: Database.Database, source: string, syncedAt: string): void {
    const threadCount = (db.prepare('SELECT COUNT(*) AS count FROM threads WHERE source = ?').get(source) as { count: number }).count;
    db.prepare(`
      INSERT INTO corpus_sources(source, last_sync, thread_count)
      VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        last_sync = excluded.last_sync,
        thread_count = excluded.thread_count
    `).run(source, syncedAt, threadCount);
  }

  private assertRefIndexed(db: Database.Database, source: string, ref: string): void {
    const row = db
      .prepare('SELECT COUNT(*) AS count FROM thread_versions WHERE source = ? AND ref = ?')
      .get(source, ref) as { count: number };
    if (row.count === 0) {
      throw new UnknownRefError(source, ref);
    }
  }

  private prepareBlobStatements(db: Database.Database): BlobStatements {
    return {
      insertBlob: db.prepare(`
        INSERT OR IGNORE INTO thread_blobs (
          content_hash, source, doc_id, title, body, comments_json, state, thread_type, labels_json, author, url, updated
        ) VALUES (
          @contentHash, @source, @docId, @title, @body, @commentsJson, @state, @threadType, @labelsJson, @author, @url, @updated
        )
      `),
      selectBlobRowid: db.prepare('SELECT rowid AS rowid FROM thread_blobs WHERE content_hash = ?'),
      insertBlobFts: db.prepare('INSERT INTO blob_fts(rowid, title, body, comments) VALUES (?, ?, ?, ?)'),
      upsertVersion: db.prepare(`
        INSERT INTO thread_versions (source, doc_id, ref, content_hash, ingested_at)
        VALUES (@source, @docId, @ref, @contentHash, @ingestedAt)
        ON CONFLICT(source, doc_id, ref) DO UPDATE SET
          content_hash = excluded.content_hash,
          ingested_at = excluded.ingested_at
      `),
    };
  }

  /** Content-addresses `document` into `thread_blobs`/`blob_fts` and records it in the `(source, doc_id, ref)` manifest. */
  private recordBlobVersion(
    statements: BlobStatements,
    document: ThreadDocument,
    chunk: ThreadChunk,
    ref: string,
    syncedAt: string,
  ): void {
    const contentHash = createHash('sha256').update(document.body).digest('hex');
    const insertResult = statements.insertBlob.run({
      contentHash,
      source: document.source,
      docId: document.id,
      title: document.title,
      body: document.body,
      commentsJson: JSON.stringify(document.comments),
      state: document.state,
      threadType: document.type,
      labelsJson: JSON.stringify(document.labels),
      author: document.author,
      url: document.url ?? null,
      updated: document.updated,
    });

    if (insertResult.changes > 0) {
      const blobRow = statements.selectBlobRowid.get(contentHash) as { rowid: number };
      statements.insertBlobFts.run(blobRow.rowid, chunk.title, chunk.body, chunk.comments);
    }

    statements.upsertVersion.run({
      source: document.source,
      docId: document.id,
      ref,
      contentHash,
      ingestedAt: syncedAt,
    });
  }

  /**
   * Retention (#1921): keeps the most recent `maxRefsPerSource` distinct refs
   * for `source`, plus any ref ingested within `refRetentionDays` days,
   * whichever set is larger; then GCs any `thread_blobs`/`blob_fts` rows no
   * longer referenced by a surviving manifest row.
   */
  private pruneVersions(db: Database.Database, source: string, nowIso: string): void {
    const cutoffIso = new Date(Date.parse(nowIso) - this.refRetentionDays * MS_PER_DAY).toISOString();
    const refs = db
      .prepare('SELECT ref, MAX(ingested_at) AS latest FROM thread_versions WHERE source = ? GROUP BY ref ORDER BY latest DESC')
      .all(source) as { ref: string; latest: string }[];

    const staleRefs = refs
      .filter((row, index) => index >= this.maxRefsPerSource && row.latest < cutoffIso)
      .map(row => row.ref);

    if (staleRefs.length > 0) {
      const placeholders = staleRefs.map(() => '?').join(', ');
      db.prepare(`DELETE FROM thread_versions WHERE source = ? AND ref IN (${placeholders})`).run(source, ...staleRefs);
    }

    this.gcOrphanedBlobs(db);
  }

  private gcOrphanedBlobs(db: Database.Database): void {
    const orphaned = db
      .prepare('SELECT rowid, content_hash FROM thread_blobs WHERE content_hash NOT IN (SELECT content_hash FROM thread_versions)')
      .all() as { rowid: number; content_hash: string }[];

    const deleteBlobFts = db.prepare('DELETE FROM blob_fts WHERE rowid = ?');
    const deleteBlob = db.prepare('DELETE FROM thread_blobs WHERE content_hash = ?');
    for (const row of orphaned) {
      deleteBlobFts.run(row.rowid);
      deleteBlob.run(row.content_hash);
    }
  }
}

interface BlobStatements {
  insertBlob: Database.Statement;
  selectBlobRowid: Database.Statement;
  insertBlobFts: Database.Statement;
  upsertVersion: Database.Statement;
}

function rowToStoredSearchRow(row: BlobSearchRow): StoredSearchRow {
  return {
    source: row.source,
    docId: row.doc_id,
    // thread_blobs (#1921) tracks only git-backed local:workspace content, so
    // sourceType is fixed here rather than stored per-row (unlike `threads`).
    sourceType: 'local',
    threadType: row.thread_type,
    state: row.state,
    labels: parseJson<string[]>(row.labels_json, []),
    author: row.author,
    title: row.title,
    body: row.body,
    comments: parseJson<ThreadDocument['comments']>(row.comments_json, []),
    url: row.url ?? undefined,
    updated: row.updated,
    rank: row.rank,
    contentHash: row.content_hash,
  };
}

function appendArrayFilter(
  where: string[],
  params: Record<string, unknown>,
  name: string,
  column: string,
  value: string | string[] | undefined,
): void {
  if (!value) {
    return;
  }

  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) {
    return;
  }

  const placeholders = values.map((_, index) => `@${name}${index}`);
  where.push(`${column} IN (${placeholders.join(', ')})`);
  values.forEach((item, index) => {
    params[`${name}${index}`] = item;
  });
}

function toFtsQuery(query: string): string {
  // Space-separated quoted terms are implicitly ANDed by FTS5's default
  // query syntax, so all terms must appear in a thread for it to match.
  // Quoting each term (with internal quotes escaped) also protects against
  // FTS5 syntax errors from user-supplied punctuation.
  const terms = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' ');
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Content hash used to detect an embedding chunk's text is unchanged since it was last embedded. */
function hashChunkText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface ThreadByPkRow {
  pk: number;
  source: string;
  doc_id: string;
  source_type: string;
  thread_type: ThreadType;
  state: ThreadState;
  labels_json: string;
  author: string;
  title: string;
  body: string;
  comments_json: string;
  resolution_json: string | null;
  url: string | null;
  updated: string;
}

/**
 * Converts a plain `threads` row (fetched by pk, not via FTS) into the same
 * `StoredSearchRow` shape `search()` returns, for semantic-only hits that
 * never matched BM25. `rank` has no BM25 meaning here, so it's `0` —
 * `CorpusEngine`'s hybrid merge scores these rows from vector distance
 * instead of `rank`.
 */
function threadRowToStoredSearchRow(row: ThreadByPkRow): StoredSearchRow {
  return {
    source: row.source,
    docId: row.doc_id,
    sourceType: row.source_type,
    threadType: row.thread_type,
    state: row.state,
    labels: parseJson<string[]>(row.labels_json, []),
    author: row.author,
    title: row.title,
    body: row.body,
    comments: parseJson<ThreadDocument['comments']>(row.comments_json, []),
    resolution: row.resolution_json ? parseJson<ThreadResolution | undefined>(row.resolution_json, undefined) : undefined,
    url: row.url ?? undefined,
    updated: row.updated,
    rank: 0,
    threadPk: row.pk,
  };
}
