import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
import { createCorpusApp } from '../routes';
import { CorpusEngine } from '../engine';
import { mintTestClaimHeader } from './support/mint-test-claim';
import { thread } from '../engine/__tests__/support/thread-fixture';
import { resolveCorpusDid } from '../lib/source-owner';

vi.mock('../lib/source-owner', () => ({ resolveCorpusDid: vi.fn(async () => 'did:imajin:org') }));
const key = authCrypto.generateKeypair();
let engine: CorpusEngine;
let dataDir: string;
beforeEach(() => {
  vi.stubEnv('CORPUS_KERNEL_PUBLIC_KEY', key.publicKey);
  vi.mocked(resolveCorpusDid).mockResolvedValue('did:imajin:org');
  dataDir = mkdtempSync(join(tmpdir(), 'corpus-owner-route-'));
  engine = new CorpusEngine({ dataDir });
});
afterEach(() => {
  engine.close();
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
describe('source-owner route boundary', () => {
  it.each(['local:workspace', 'local:workspace/repo', 'local:/tmp/notes'])('refuses delegated workspace writes for %s and writes no rows', async source => {
    const response = await request(createCorpusApp(engine)).post('/corpus/did:imajin:org/ingest')
      .set('Authorization', mintTestClaimHeader(key.privateKey, {
        did: 'did:imajin:org', onBehalfOf: 'did:imajin:jin', scope: 'corpus:write',
      })).send([thread({ source, sourceType: 'local' })]);
    expect(response.status).toBe(403);
    expect(engine.status('did:imajin:org').threadCount).toBe(0);
    expect(engine.status('did:imajin:jin').threadCount).toBe(0);
  });
  it('does not ingest GitHub documents in a caller partition, even with a valid signed claim', async () => {
    const response = await request(createCorpusApp(engine)).post('/corpus/did:imajin:jin/ingest')
      .set('Authorization', mintTestClaimHeader(key.privateKey, { did: 'did:imajin:jin', scope: 'corpus:write' })).send([thread()]);
    expect(response.status).toBe(403);
    expect(engine.status('did:imajin:jin').threadCount).toBe(0);
  });
  it('ingests and searches only the resolved owner partition', async () => {
    const app = createCorpusApp(engine);
    expect((await request(app).post('/corpus/did:imajin:org/ingest')
      .set('Authorization', mintTestClaimHeader(key.privateKey, { did: 'did:imajin:org', scope: 'corpus:write' })).send([thread({ body: 'organization ruling' })])).status).toBe(200);
    const response = await request(app).post('/corpus/did:imajin:org/search')
      .set('Authorization', mintTestClaimHeader(key.privateKey, { did: 'did:imajin:org' })).send({ query: 'ruling', source: 'github:ima-jin/imajin-ai' });
    expect(response.status).toBe(200);
    expect(response.body.results).toHaveLength(1);
    expect(response.body.freshness[0].ownerDid).toBe('did:imajin:org');
  });
  it('refuses writes with a read claim', async () => {
    const response = await request(createCorpusApp(engine)).post('/corpus/did:imajin:org/ingest')
      .set('Authorization', mintTestClaimHeader(key.privateKey, { did: 'did:imajin:org' })).send([thread()]);
    expect(response.status).toBe(403);
    expect(engine.status('did:imajin:org').threadCount).toBe(0);
  });
  it('fails closed when identity service cannot resolve ownership', async () => {
    vi.mocked(resolveCorpusDid).mockRejectedValueOnce(new Error('unavailable'));
    const response = await request(createCorpusApp(engine)).post('/corpus/did:imajin:org/search')
      .set('Authorization', mintTestClaimHeader(key.privateKey, { did: 'did:imajin:org' })).send({ query: 'ruling', source: 'github:ima-jin/imajin-ai' });
    expect(response.status).toBe(403);
  });
});
