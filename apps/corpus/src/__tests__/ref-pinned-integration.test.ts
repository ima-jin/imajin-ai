/**
 * Acceptance test for #1921 (sha-pinned snapshot queries): ingest a
 * `local:workspace` source at git sha A, query `ref=A`, run `/sync` to a
 * second commit sha B, then query `ref=A` again. The two `ref=A` responses
 * must be identical (including chunk content hashes), while `ref=B` must
 * reflect the new content. Run against a fabricated `.git` checkout (see
 * `test-helpers/fake-git.ts` — `resolveGitRef` never inspects commit/tree
 * objects, only `HEAD`/refs, so no real `git` process is needed) with two
 * simulated commits, over the actual HTTP routes, mirroring the issue's own
 * verify script.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
import { CorpusEngine } from '../engine';
import { createCorpusApp } from '../routes';
import { workspaceRootForDid } from '../lib/workspace';
import { initFakeGitCheckout, setFakeGitHead } from './test-helpers/fake-git';
import { mintTestClaimHeader, type TestClaimScope } from './support/mint-test-claim';

const did = 'did:example:refcheck';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const ORIGINAL_KERNEL_PUBLIC_KEY = process.env.CORPUS_KERNEL_PUBLIC_KEY;
const KERNEL_KEYPAIR = authCrypto.generateKeypair();

/** Mints a valid `Authorization` header for `did` above, for supertest requests. */
function authFor(scope: TestClaimScope = 'corpus:write'): string {
  return mintTestClaimHeader(KERNEL_KEYPAIR.privateKey, { did, scope });
}

describe('sha-pinned snapshot queries — reproducible retrieval at a ref (#1921)', () => {
  let dataDir: string;
  let workspacesDir: string;
  let engine: CorpusEngine;
  let app: ReturnType<typeof createCorpusApp>;
  let workspaceRoot: string;

  beforeEach(() => {
    process.env.CORPUS_KERNEL_PUBLIC_KEY = KERNEL_KEYPAIR.publicKey;
    dataDir = mkdtempSync(join(tmpdir(), 'corpus-ref-integration-data-'));
    workspacesDir = mkdtempSync(join(tmpdir(), 'corpus-ref-integration-workspaces-'));
    engine = new CorpusEngine({ dataDir });
    app = createCorpusApp(engine, { workspacesDir });

    workspaceRoot = workspaceRootForDid(did, { workspacesDir });
    mkdirSync(workspaceRoot, { recursive: true });
    initFakeGitCheckout(workspaceRoot);
  });

  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspacesDir, { recursive: true, force: true });
    if (ORIGINAL_KERNEL_PUBLIC_KEY === undefined) delete process.env.CORPUS_KERNEL_PUBLIC_KEY;
    else process.env.CORPUS_KERNEL_PUBLIC_KEY = ORIGINAL_KERNEL_PUBLIC_KEY;
  });

  it('returns identical results and chunk hashes for ref=A across an intervening sync, and different results for ref=B', async () => {
    writeFileSync(join(workspaceRoot, 'a.md'), '# A\n\nhello', 'utf8');
    setFakeGitHead(workspaceRoot, SHA_A);

    const crawl = await request(app)
      .post(`/corpus/${did}/crawl`)
      .set('Authorization', authFor())
      .send({ source: 'local:workspace' });
    expect(crawl.status).toBe(200);
    expect(crawl.body).toEqual({ ingested: 1 });

    const searchAtAFirst = await request(app)
      .post(`/corpus/${did}/search`)
      .set('Authorization', authFor('corpus:read'))
      .send({ query: 'hello', source: 'local:workspace', ref: SHA_A });
    expect(searchAtAFirst.status).toBe(200);
    expect(searchAtAFirst.body.totalHits).toBe(1);

    writeFileSync(join(workspaceRoot, 'a.md'), '# A\n\nhello world', 'utf8');
    setFakeGitHead(workspaceRoot, SHA_B);

    const sync = await request(app)
      .post(`/corpus/${did}/sync`)
      .set('Authorization', authFor())
      .send({ source: 'local:workspace', cursor: null });
    expect(sync.status).toBe(200);

    const searchAtASecond = await request(app)
      .post(`/corpus/${did}/search`)
      .set('Authorization', authFor('corpus:read'))
      .send({ query: 'hello', source: 'local:workspace', ref: SHA_A });
    expect(searchAtASecond.status).toBe(200);

    // Identical result set AND identical chunk hashes, despite the sync in
    // between (excluding `freshness`, which legitimately advances with the sync).
    expect(searchAtASecond.body.results).toEqual(searchAtAFirst.body.results);
    expect(searchAtASecond.body.totalHits).toBe(searchAtAFirst.body.totalHits);
    expect(searchAtASecond.body.results[0].contentHash).toBe(searchAtAFirst.body.results[0].contentHash);
    expect(searchAtASecond.body.provenance).toEqual(searchAtAFirst.body.provenance);

    // "world" only exists in the tree at sha B.
    const worldAtA = await request(app)
      .post(`/corpus/${did}/search`)
      .set('Authorization', authFor('corpus:read'))
      .send({ query: 'world', source: 'local:workspace', ref: SHA_A });
    expect(worldAtA.body.totalHits).toBe(0);

    const worldAtB = await request(app)
      .post(`/corpus/${did}/search`)
      .set('Authorization', authFor('corpus:read'))
      .send({ query: 'world', source: 'local:workspace', ref: SHA_B });
    expect(worldAtB.status).toBe(200);
    expect(worldAtB.body.totalHits).toBe(1);
    expect(worldAtB.body.results[0].contentHash).not.toBe(searchAtAFirst.body.results[0].contentHash);

    // Unknown ref never falls back to HEAD — it 404s with a clear hint.
    const unknownRef = '0'.repeat(40);
    const unknown = await request(app)
      .post(`/corpus/${did}/search`)
      .set('Authorization', authFor('corpus:read'))
      .send({ query: 'hello', source: 'local:workspace', ref: unknownRef });
    expect(unknown.status).toBe(404);
    expect(unknown.body.hint).toBe('trigger ingest at this ref');
  });
});
