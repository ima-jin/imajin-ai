import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chunkThread } from './chunker';
import type {
  CorpusSearchRequest,
  CorpusSourceFreshness,
  CorpusStatus,
  ThreadDocument,
  ThreadResolution,
  ThreadState,
  ThreadType,
} from './types';

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
}

interface ThreadRow {
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
}

interface SourceRow {
  source: string;
  last_sync: string;
  thread_count: number;
}

export interface CorpusStoreOptions {
  dataDir?: string;
}

export class CorpusStore {
  private readonly rootDir: string;
  private readonly handles = new Map<string, Database.Database>();

  constructor(options: CorpusStoreOptions = {}) {
    this.rootDir = options.dataDir ?? join(process.cwd(), 'data', 'corpus');
  }

  close(): void {
    for (const db of this.handles.values()) {
      db.close();
    }
    this.handles.clear();
  }

  ingest(did: string, documents: ThreadDocument[], syncedAt = new Date().toISOString()): void {
    const db = this.databaseForDid(did);
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
      }

      const sources = new Set(batch.map(document => document.source));
      for (const source of sources) {
        this.refreshSource(db, source, syncedAt);
      }
    });

    transaction(documents);
  }

  search(did: string, request: Required<Pick<CorpusSearchRequest, 'limit'>> & CorpusSearchRequest): StoredSearchRow[] {
    const db = this.databaseForDid(did);
    const matchQuery = toFtsQuery(request.query);
    if (!matchQuery) {
      return [];
    }

    const where: string[] = ['thread_fts MATCH @matchQuery'];
    const params: Record<string, unknown> = { matchQuery, limit: request.limit };

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
    }));
  }

  status(did: string): CorpusStatus {
    const db = this.databaseForDid(did);
    const threadCount = (db.prepare('SELECT COUNT(*) AS count FROM threads').get() as { count: number }).count;

    return {
      sources: this.freshness(did),
      threadCount,
    };
  }

  freshness(did: string): CorpusSourceFreshness[] {
    const db = this.databaseForDid(did);
    const rows = db.prepare('SELECT source, last_sync, thread_count FROM corpus_sources ORDER BY source').all() as SourceRow[];

    return rows.map(row => ({
      source: row.source,
      lastSync: row.last_sync,
      threadCount: row.thread_count,
    }));
  }

  deleteSource(did: string, source: string): number {
    const db = this.databaseForDid(did);
    const selectRows = db.prepare('SELECT pk FROM threads WHERE source = ?');
    const deleteFts = db.prepare('DELETE FROM thread_fts WHERE rowid = ?');
    const deleteThreads = db.prepare('DELETE FROM threads WHERE source = ?');
    const deleteSource = db.prepare('DELETE FROM corpus_sources WHERE source = ?');

    const transaction = db.transaction(() => {
      const rows = selectRows.all(source) as { pk: number }[];
      for (const row of rows) {
        deleteFts.run(row.pk);
      }
      const result = deleteThreads.run(source);
      deleteSource.run(source);
      return result.changes;
    });

    return transaction() as number;
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
    this.migrate(db);
    this.handles.set(didHash, db);
    return db;
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
