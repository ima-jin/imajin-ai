import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import type { CorpusIdentity } from '../lib/corpus-identity';

type Row = Record<string, string | number | bigint | Buffer | null>;

export function migrateOwnerSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS corpus_owner_transfers (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, from_did TEXT NOT NULL, to_did TEXT NOT NULL,
    payload_json TEXT NOT NULL, signature TEXT NOT NULL, signer_public_key TEXT NOT NULL
  )`);
}

/** Retain the original partition as hidden history, and copy all retrieval state. */
export function transferSource(
  target: Database.Database, legacyPath: string, source: string,
  fromDid: string, toDid: string, identity: CorpusIdentity,
): { moved: number } {
  if (fromDid === toDid) return { moved: 0 };
  const id = createHash('sha256').update(JSON.stringify([source, fromDid, toDid])).digest('hex');
  target.prepare('ATTACH DATABASE ? AS legacy').run(legacyPath);
  try {
    return target.transaction(() => {
      if (target.prepare('SELECT id FROM corpus_owner_transfers WHERE id = ?').get(id)) return { moved: 0 };
      if (target.prepare('SELECT id FROM legacy.corpus_owner_transfers WHERE source = ? AND from_did = ?').get(source, fromDid)) {
        throw new Error('Legacy source already transferred to another partition');
      }
      if (target.prepare('SELECT pk FROM threads WHERE source = ? LIMIT 1').get(source)) {
        throw new Error('Target source is not empty; reconcile before migration');
      }
      const threads = target.prepare('SELECT * FROM legacy.threads WHERE source = ? ORDER BY pk').all(source) as Row[];
      if (threads.length === 0) return { moved: 0 };
      for (const thread of threads) copyThread(target, thread, toDid);
      copySourceRows(target, 'thread_blobs', source);
      target.prepare(`INSERT INTO blob_fts(rowid, title, body, comments)
        SELECT rowid, title, body, comments_json FROM thread_blobs
        WHERE source = ? AND rowid NOT IN (SELECT rowid FROM blob_fts)`).run(source);
      copySourceRows(target, 'thread_versions', source);
      copySourceRows(target, 'ingestion_attestations', source);
      copySourceRows(target, 'corpus_sources', source);

      const payload = canonicalize({
        type: 'corpus.owner.transferred', source, fromDid, toDid, threadCount: threads.length,
        contentHash: createHash('sha256').update(canonicalize(threads)).digest('hex'),
        timestamp: new Date().toISOString(), issuerDid: identity.did,
      });
      const values = [id, source, fromDid, toDid, payload, authCrypto.signSync(payload, identity.privateKey), authCrypto.getPublicKey(identity.privateKey)];
      for (const prefix of ['', 'legacy.']) {
        target.prepare(`INSERT INTO ${prefix}corpus_owner_transfers
          (id, source, from_did, to_did, payload_json, signature, signer_public_key) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(...values);
      }
      return { moved: threads.length };
    })();
  } finally {
    target.exec('DETACH DATABASE legacy');
  }
}

function insertRow(db: Database.Database, table: string, row: Row): number | bigint {
  const columns = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...Object.values(row)).lastInsertRowid;
}

function copySourceRows(db: Database.Database, table: string, source: string): void {
  const rows = db.prepare(`SELECT * FROM legacy.${table} WHERE source = ?`).all(source) as Row[];
  for (const row of rows) insertRow(db, table, row);
}

function copyThread(db: Database.Database, thread: Row, ownerDid: string): void {
  const { pk, ...fields } = thread;
  const newPk = insertRow(db, 'threads', fields);
  const fts = db.prepare('SELECT title, body, comments FROM legacy.thread_fts WHERE rowid = ?').get(pk) as Row;
  insertRow(db, 'thread_fts', { rowid: newPk, ...fts });
  const chunks = db.prepare('SELECT * FROM legacy.embedding_chunks WHERE thread_pk = ?').all(pk) as Row[];
  for (const chunk of chunks) {
    const { id, ...chunkFields } = chunk;
    const newId = insertRow(db, 'embedding_chunks', { ...chunkFields, thread_pk: newPk, owner_did: ownerDid });
    const vector = db.prepare('SELECT embedding FROM legacy.vec_embeddings WHERE rowid = ?').get(BigInt(id as number)) as Row | undefined;
    if (vector) insertRow(db, 'vec_embeddings', { rowid: BigInt(newId), embedding: vector.embedding, owner_did: ownerDid });
  }
}
