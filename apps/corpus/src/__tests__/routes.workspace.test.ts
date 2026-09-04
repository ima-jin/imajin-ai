import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { crypto as authCrypto } from '@imajin/auth';
import { createCorpusApp } from '../routes';
import { CorpusEngine } from '../engine';
import { workspaceRootForDid } from '../lib/workspace';
import { mintTestClaimHeader, type TestClaimScope } from './support/mint-test-claim';

const did = 'did:example:alice';

const ORIGINAL_KERNEL_PUBLIC_KEY = process.env.CORPUS_KERNEL_PUBLIC_KEY;
const KERNEL_KEYPAIR = authCrypto.generateKeypair();

/** Mints a valid `Authorization` header for `subjectDid`/`scope`, for supertest requests. */
function authFor(subjectDid: string, scope: TestClaimScope = 'corpus:write'): string {
  return mintTestClaimHeader(KERNEL_KEYPAIR.privateKey, { did: subjectDid, scope });
}

function writeWorkspaceFile(workspacesDir: string, relPath: string, content: string): string {
  const root = workspaceRootForDid(did, { workspacesDir });
  const absolutePath = join(root, relPath);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
  return absolutePath;
}

describe('local:workspace routes', () => {
  let dataDir: string;
  let workspacesDir: string;
  let engine: CorpusEngine;
  let app: ReturnType<typeof createCorpusApp>;

  beforeEach(() => {
    process.env.CORPUS_KERNEL_PUBLIC_KEY = KERNEL_KEYPAIR.publicKey;
    dataDir = mkdtempSync(join(tmpdir(), 'corpus-routes-data-'));
    workspacesDir = mkdtempSync(join(tmpdir(), 'corpus-routes-workspaces-'));
    engine = new CorpusEngine({ dataDir });
    app = createCorpusApp(engine, { workspacesDir });
  });

  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspacesDir, { recursive: true, force: true });
    if (ORIGINAL_KERNEL_PUBLIC_KEY === undefined) delete process.env.CORPUS_KERNEL_PUBLIC_KEY;
    else process.env.CORPUS_KERNEL_PUBLIC_KEY = ORIGINAL_KERNEL_PUBLIC_KEY;
  });

  it('POST /corpus/:did/crawl indexes workspace files and search returns them', async () => {
    writeWorkspaceFile(workspacesDir, 'guide.md', '# Setup guide\n\nRun the installer to get started.');

    const crawlResponse = await request(app)
      .post(`/corpus/${did}/crawl`)
      .set('Authorization', authFor(did))
      .send({ source: 'local:workspace' });
    expect(crawlResponse.status).toBe(200);
    expect(crawlResponse.body).toEqual({ ingested: 1 });

    const searchResponse = await request(app)
      .post(`/corpus/${did}/search`)
      .set('Authorization', authFor(did, 'corpus:read'))
      .send({ query: 'installer' });
    expect(searchResponse.status).toBe(200);
    expect(searchResponse.body.totalHits).toBe(1);
    expect(searchResponse.body.results[0]).toMatchObject({ id: 'guide.md', title: 'Setup guide' });
  });

  it('persists "local:workspace" as the source, never the resolved absolute path', async () => {
    writeWorkspaceFile(workspacesDir, 'docs/notes.md', '# Notes\n\nSome workspace notes.');

    await request(app).post(`/corpus/${did}/crawl`).set('Authorization', authFor(did)).send({ source: 'local:workspace' });

    const statusResponse = await request(app).get(`/corpus/${did}/status`).set('Authorization', authFor(did, 'corpus:read'));
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.sources).toHaveLength(1);
    expect(statusResponse.body.sources[0].source).toBe('local:workspace');

    const searchResponse = await request(app)
      .post(`/corpus/${did}/search`)
      .set('Authorization', authFor(did, 'corpus:read'))
      .send({ query: 'notes' });
    expect(searchResponse.body.results[0].source).toBe('local:workspace');
    expect(searchResponse.body.results[0].source).not.toContain(workspacesDir);
  });

  it('supports "local:workspace/<subdir>" sources', async () => {
    writeWorkspaceFile(workspacesDir, 'docs/guide.md', '# Docs guide\n\nSubdirectory content.');

    const crawlResponse = await request(app)
      .post(`/corpus/${did}/crawl`)
      .set('Authorization', authFor(did))
      .send({ source: 'local:workspace/docs' });
    expect(crawlResponse.status).toBe(200);
    expect(crawlResponse.body).toEqual({ ingested: 1 });

    const searchResponse = await request(app)
      .post(`/corpus/${did}/search`)
      .set('Authorization', authFor(did, 'corpus:read'))
      .send({ query: 'subdirectory' });
    expect(searchResponse.body.results[0].source).toBe('local:workspace/docs');
  });

  it('rejects crawl sources outside the "local:workspace" format', async () => {
    const response = await request(app)
      .post(`/corpus/${did}/crawl`)
      .set('Authorization', authFor(did))
      .send({ source: 'local:/etc' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/local:workspace/);
  });

  it('rejects crawl requests missing a source', async () => {
    const response = await request(app).post(`/corpus/${did}/crawl`).set('Authorization', authFor(did)).send({});
    expect(response.status).toBe(400);
  });

  it('POST /corpus/:did/ingest with { source: "local:workspace" } crawls and ingests the workspace', async () => {
    writeWorkspaceFile(workspacesDir, 'a.md', '# A doc\n\nContent A.');

    const response = await request(app)
      .post(`/corpus/${did}/ingest`)
      .set('Authorization', authFor(did))
      .send({ source: 'local:workspace' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ingested: 1 });
  });

  it('POST /corpus/:did/ingest still accepts a raw ThreadDocument[] body', async () => {
    const response = await request(app)
      .post(`/corpus/${did}/ingest`)
      .set('Authorization', authFor(did))
      .send([
        {
          source: 'github:ima-jin/imajin-ai',
          sourceType: 'github',
          id: '1',
          type: 'issue',
          title: 'Test',
          state: 'open',
          labels: [],
          author: 'alice',
          created: '2024-01-01T00:00:00Z',
          updated: '2024-01-01T00:00:00Z',
          linkedRefs: [],
          body: 'Test body',
          comments: [],
        },
      ]);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ingested: 1 });
  });

  it('POST /corpus/:did/sync with a "local:workspace" source performs an incremental sync', async () => {
    writeWorkspaceFile(workspacesDir, 'first.md', '# First\n\nFirst doc.');

    const firstSync = await request(app)
      .post(`/corpus/${did}/sync`)
      .set('Authorization', authFor(did))
      .send({ source: 'local:workspace', cursor: null });
    expect(firstSync.status).toBe(200);
    expect(firstSync.body.ingested).toBe(1);
    expect(typeof firstSync.body.cursor).toBe('string');

    const secondSync = await request(app)
      .post(`/corpus/${did}/sync`)
      .set('Authorization', authFor(did))
      .send({ source: 'local:workspace', cursor: firstSync.body.cursor });
    expect(secondSync.status).toBe(200);
    expect(secondSync.body.ingested).toBe(0);
  });

  it('POST /corpus/:did/sync without a workspace source returns 501', async () => {
    const response = await request(app).post(`/corpus/${did}/sync`).set('Authorization', authFor(did)).send({});
    expect(response.status).toBe(501);
  });

  it('scopes workspaces per DID so one DID cannot see another DID\'s files', async () => {
    writeWorkspaceFile(workspacesDir, 'secret.md', '# Secret\n\nAlice-only content.');
    await request(app).post(`/corpus/${did}/crawl`).set('Authorization', authFor(did)).send({ source: 'local:workspace' });

    const otherDid = 'did:example:bob';
    const otherCrawl = await request(app)
      .post(`/corpus/${otherDid}/crawl`)
      .set('Authorization', authFor(otherDid))
      .send({ source: 'local:workspace' });
    expect(otherCrawl.status).toBe(200);
    expect(otherCrawl.body).toEqual({ ingested: 0 });
  });
});
