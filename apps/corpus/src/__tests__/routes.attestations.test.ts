import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
import { CorpusEngine } from '../engine';
import { createCorpusApp } from '../routes';
import { mintTestClaimHeader } from './support/mint-test-claim';
vi.mock('../lib/source-owner', () => ({ resolveCorpusDid: vi.fn(async () => 'did:example:alice') }));

const ORIGINAL_KERNEL_PUBLIC_KEY = process.env.CORPUS_KERNEL_PUBLIC_KEY;
const ORIGINAL_CORPUS_DID = process.env.CORPUS_DID;
const ORIGINAL_CORPUS_DID_PRIVATE_KEY = process.env.CORPUS_DID_PRIVATE_KEY;

const KERNEL_KEYPAIR = authCrypto.generateKeypair();
const CORPUS_KEYPAIR = authCrypto.generateKeypair();

function authFor(did: string, scope: 'corpus:read' | 'corpus:write' = 'corpus:write'): string {
  return mintTestClaimHeader(KERNEL_KEYPAIR.privateKey, { did, scope });
}

const document = {
  source: 'github:ima-jin/imajin-ai',
  sourceType: 'github',
  id: '1',
  type: 'issue',
  title: 'Corpus service',
  state: 'open',
  labels: [],
  author: 'octocat',
  created: '2026-08-09T15:00:00.000Z',
  updated: '2026-08-09T16:00:00.000Z',
  linkedRefs: [],
  body: 'BM25 search service',
  comments: [],
};

describe('GET /corpus/:did/attestations/:id (#1750)', () => {
  let dataDir: string;
  let engine: CorpusEngine;
  let app: ReturnType<typeof createCorpusApp>;

  beforeEach(() => {
    process.env.CORPUS_KERNEL_PUBLIC_KEY = KERNEL_KEYPAIR.publicKey;
    process.env.CORPUS_DID = 'did:imajin:corpus-service-test';
    process.env.CORPUS_DID_PRIVATE_KEY = CORPUS_KEYPAIR.privateKey;
    dataDir = mkdtempSync(join(tmpdir(), 'corpus-attestation-routes-'));
    engine = new CorpusEngine({ dataDir, now: () => new Date('2026-08-09T17:00:00.000Z') });
    app = createCorpusApp(engine);
  });

  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
    if (ORIGINAL_KERNEL_PUBLIC_KEY === undefined) delete process.env.CORPUS_KERNEL_PUBLIC_KEY;
    else process.env.CORPUS_KERNEL_PUBLIC_KEY = ORIGINAL_KERNEL_PUBLIC_KEY;
    if (ORIGINAL_CORPUS_DID === undefined) delete process.env.CORPUS_DID;
    else process.env.CORPUS_DID = ORIGINAL_CORPUS_DID;
    if (ORIGINAL_CORPUS_DID_PRIVATE_KEY === undefined) delete process.env.CORPUS_DID_PRIVATE_KEY;
    else process.env.CORPUS_DID_PRIVATE_KEY = ORIGINAL_CORPUS_DID_PRIVATE_KEY;
  });

  it('returns the signed attestation, its signature, and the corpus public key', async () => {
    await request(app).post('/corpus/did:example:alice/ingest').set('Authorization', authFor('did:example:alice')).send([document]);

    const searchResponse = await request(app)
      .post('/corpus/did:example:alice/search')
      .set('Authorization', authFor('did:example:alice', 'corpus:read'))
      .send({ query: 'BM25' });
    const attestationId = searchResponse.body.results[0].attestationId as string;
    expect(attestationId).toBeDefined();

    const response = await request(app)
      .get(`/corpus/did:example:alice/attestations/${attestationId}`)
      .set('Authorization', authFor('did:example:alice', 'corpus:read'));

    expect(response.status).toBe(200);
    expect(response.body.attestation).toMatchObject({ id: attestationId, source: 'github:ima-jin/imajin-ai' });
    expect(typeof response.body.attestation.signature).toBe('string');
    expect(response.body.corpusPublicKey).toBe(CORPUS_KEYPAIR.publicKey);
  });

  it('404s when the id does not exist', async () => {
    const response = await request(app)
      .get('/corpus/did:example:alice/attestations/ing_does_not_exist')
      .set('Authorization', authFor('did:example:alice', 'corpus:read'));

    expect(response.status).toBe(404);
  });

  it('enforces DID isolation: an attestation id from one DID 404s under another DID', async () => {
    await request(app).post('/corpus/did:example:alice/ingest').set('Authorization', authFor('did:example:alice')).send([document]);
    const searchResponse = await request(app)
      .post('/corpus/did:example:alice/search')
      .set('Authorization', authFor('did:example:alice', 'corpus:read'))
      .send({ query: 'BM25' });
    const attestationId = searchResponse.body.results[0].attestationId as string;

    const crossDidResponse = await request(app)
      .get(`/corpus/did:example:bob/attestations/${attestationId}`)
      .set('Authorization', authFor('did:example:bob', 'corpus:read'));

    expect(crossDidResponse.status).toBe(404);
  });

  it('rejects the route without a valid CorpusAccessClaim', async () => {
    const response = await request(app).get('/corpus/did:example:alice/attestations/ing_whatever');
    expect(response.status).toBe(401);
  });
});
