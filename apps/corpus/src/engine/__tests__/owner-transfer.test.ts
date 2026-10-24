import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
import { CorpusStore } from '../store';
import { EMBEDDING_DIMENSIONS } from '../vector-store';
import { thread } from './support/thread-fixture';

const source = 'github:ima-jin/imajin-ai';
const from = 'did:imajin:jin';
const to = 'did:imajin:org';
const identity = { did: 'did:imajin:corpus', privateKey: authCrypto.generateKeypair().privateKey };
const dirs: string[] = [];
const stores: CorpusStore[] = [];
afterEach(() => {
  stores.forEach(store => store.close());
  dirs.forEach(dir => rmSync(dir, { recursive: true, force: true }));
  stores.length = 0;
  dirs.length = 0;
});
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'owner-transfer-'));
  dirs.push(dataDir);
  const store = new CorpusStore({ dataDir });
  stores.push(store);
  return { store, dataDir };
}
function open(dataDir: string, did: string) {
  return new Database(join(dataDir, createHash('sha256').update(did).digest('hex'), 'index.db'));
}

describe('attested source-owner migration', () => {
  it('preserves search, refs, embeddings and signed ingestion history; twice is a no-op; never removes rows', () => {
    const { store, dataDir } = setup();
    const document = thread({ title: 'Corpus owner ruling', body: 'Corpus owner decision is organization' });
    const [attestation] = store.ingest(from, [document], undefined, 'sha1', identity);
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i === 0 ? 1 : 0);
    for (const chunk of store.pendingChunks(from, 100)) store.storeChunkEmbedding(from, chunk.id, vector);
    const query = { query: 'owner', source, limit: 10 };
    const before = store.search(from, query);
    const pinned = store.searchAtRef(from, source, 'sha1', query);
    expect(store.transferSource(from, to, source, identity)).toEqual({ moved: 1 });
    expect(store.search(to, query)).toEqual(before);
    expect(store.searchAtRef(to, source, 'sha1', query)).toEqual(pinned);
    expect(store.getAttestation(to, attestation.id)).toEqual(store.getAttestation(from, attestation.id));
    expect(store.semanticSearch(to, vector, 10)).toHaveLength(1);
    expect(store.getThreadsByPk(from, [1])).toEqual([]);
    expect(store.search(from, query)).toEqual([]);
    expect(store.status(from).sources).toEqual([]);
    expect(store.status(to).sources[0]).toMatchObject({ source, ownerDid: to, threadCount: 1 });
    expect(() => store.searchAtRef(from, source, 'sha1', query)).toThrow('transferred');
    expect(() => store.ingest(from, [document])).toThrow('transferred');
    expect(() => store.deleteSource(from, source)).toThrow('transferred');
    expect(store.transferSource(from, to, source, identity)).toEqual({ moved: 0 });
    const old = open(dataDir, from);
    const current = open(dataDir, to);
    try {
      for (const db of [old, current]) {
        expect(db.prepare('SELECT COUNT(*) AS n FROM threads').get()).toEqual({ n: 1 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM ingestion_attestations').get()).toEqual({ n: 1 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM corpus_owner_transfers').get()).toEqual({ n: 1 });
        const proof = db.prepare('SELECT * FROM corpus_owner_transfers').get() as { payload_json: string; signature: string; signer_public_key: string };
        expect(authCrypto.verifySync(proof.signature, proof.payload_json, proof.signer_public_key)).toBe(true);
        expect(JSON.parse(proof.payload_json)).toMatchObject({ type: 'corpus.owner.transferred', fromDid: from, toDid: to });
      }
    } finally { old.close(); current.close(); }
  });
  it('refuses collisions without overwriting either partition', () => {
    const { store } = setup();
    store.ingest(from, [thread()]);
    store.ingest(to, [thread({ body: 'Newer target' })]);
    expect(() => store.transferSource(from, to, source, identity)).toThrow('not empty');
    expect(store.status(from).threadCount).toBe(1);
    expect(store.status(to).threadCount).toBe(1);
  });
  it('does not transfer unrelated workspace rows or create empty transfer records', () => {
    const { store } = setup();
    store.ingest(from, [thread({ source: 'local:workspace' })]);
    expect(store.transferSource(from, to, source, identity)).toEqual({ moved: 0 });
    expect(store.status(from).threadCount).toBe(1);
    expect(store.transferSource(from, from, source, identity)).toEqual({ moved: 0 });
  });
});
