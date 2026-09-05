import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
import { createCorpusApp, createCorpusRouter, listRoutes, toOpenApiPath } from '../routes';
import { CorpusEngine } from '../engine';
import { mintTestClaimHeader } from './support/mint-test-claim';

const did = 'did:example:alice';
const EMPTY_CONNECTION = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };

const ORIGINAL_KERNEL_PUBLIC_KEY = process.env.CORPUS_KERNEL_PUBLIC_KEY;
const KERNEL_KEYPAIR = authCrypto.generateKeypair();

/** Mints a valid `Authorization` header for `did`/`scope`, for supertest requests. */
function authFor(scope: 'corpus:read' | 'corpus:write' = 'corpus:write'): string {
  return mintTestClaimHeader(KERNEL_KEYPAIR.privateKey, { did, scope });
}

/**
 * A minimal fetch mock standing in for the GitHub GraphQL API, so these tests
 * prove the route reaches a real `GitHubAdapter` (#1729) without any network
 * access. Dispatches on the operation name embedded in the request body's
 * `query` string, same as the adapter's own mock GraphQL client (github.test.ts).
 */
function mockGitHubFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init: { body?: string }) => {
    const { query } = JSON.parse(init.body ?? '{}') as { query: string };
    const isIssuesQuery = query.includes('CorpusGitHubIssues');
    const payload = isIssuesQuery
      ? { data: { repository: { issues: EMPTY_CONNECTION } } }
      : { data: { repository: { pullRequests: EMPTY_CONNECTION } } };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('github source routes', () => {
  let dataDir: string;
  let engine: CorpusEngine;
  let app: ReturnType<typeof createCorpusApp>;
  let fetchMock: ReturnType<typeof mockGitHubFetch>;

  beforeEach(() => {
    process.env.CORPUS_KERNEL_PUBLIC_KEY = KERNEL_KEYPAIR.publicKey;
    dataDir = mkdtempSync(join(tmpdir(), 'corpus-github-routes-'));
    engine = new CorpusEngine({ dataDir });
    app = createCorpusApp(engine);
    fetchMock = mockGitHubFetch();
    vi.stubGlobal('fetch', fetchMock);
    process.env.GITHUB_TOKEN = 'test-token';
  });

  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    delete process.env.GITHUB_TOKEN;
    if (ORIGINAL_KERNEL_PUBLIC_KEY === undefined) delete process.env.CORPUS_KERNEL_PUBLIC_KEY;
    else process.env.CORPUS_KERNEL_PUBLIC_KEY = ORIGINAL_KERNEL_PUBLIC_KEY;
  });

  it('POST /corpus/:did/sources with type "github" reaches the GitHub adapter', async () => {
    const response = await request(app)
      .post(`/corpus/${did}/sources`)
      .set('Authorization', authFor())
      .send({ source: 'github:ima-jin/imajin-ai', type: 'github' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ingested: 0 });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('rejects a "type" that does not match the source prefix', async () => {
    const response = await request(app)
      .post(`/corpus/${did}/sources`)
      .set('Authorization', authFor())
      .send({ source: 'github:ima-jin/imajin-ai', type: 'local' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/does not match/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects registration missing a source', async () => {
    const response = await request(app).post(`/corpus/${did}/sources`).set('Authorization', authFor()).send({ type: 'github' });
    expect(response.status).toBe(400);
  });

  it('POST /corpus/:did/sync with a "github:" source reaches the GitHub adapter', async () => {
    const response = await request(app)
      .post(`/corpus/${did}/sync`)
      .set('Authorization', authFor())
      .send({ source: 'github:ima-jin/imajin-ai', cursor: null });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ingested: 0, hasMore: false });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('POST /corpus/:did/crawl with a "github:" source reaches the GitHub adapter', async () => {
    const response = await request(app)
      .post(`/corpus/${did}/crawl`)
      .set('Authorization', authFor())
      .send({ source: 'github:ima-jin/imajin-ai' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ingested: 0 });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('POST /corpus/:did/ingest with { source: "github:..." } reaches the GitHub adapter', async () => {
    const response = await request(app)
      .post(`/corpus/${did}/ingest`)
      .set('Authorization', authFor())
      .send({ source: 'github:ima-jin/imajin-ai' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ingested: 0 });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('still 501s /sync for an unrecognized source, never touching fetch', async () => {
    const response = await request(app).post(`/corpus/${did}/sync`).set('Authorization', authFor()).send({ source: 'slack:team' });

    expect(response.status).toBe(501);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /spec', () => {
  let dataDir: string;
  let engine: CorpusEngine;
  let app: ReturnType<typeof createCorpusApp>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'corpus-spec-'));
    engine = new CorpusEngine({ dataDir });
    app = createCorpusApp(engine);
  });

  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves the OpenAPI spec as YAML', async () => {
    const response = await request(app).get('/spec');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/yaml/);

    const spec = parseYaml(response.text) as { openapi?: string; paths?: Record<string, unknown> };
    expect(spec.openapi).toBeDefined();
    expect(spec.paths).toBeDefined();
  });

  it('lists every route the corpus router actually mounts — spec and router cannot drift', async () => {
    const response = await request(app).get('/spec');
    const spec = parseYaml(response.text) as { paths: Record<string, Record<string, unknown>> };

    const specEntries = new Set(
      Object.entries(spec.paths).flatMap(([path, methods]) =>
        Object.keys(methods).map(method => `${method.toUpperCase()} ${path}`),
      ),
    );

    const router = createCorpusRouter(engine);
    const liveEntries = new Set(listRoutes(router).map(({ method, path }) => `${method} ${path}`));

    expect(liveEntries.size).toBeGreaterThan(0);
    expect(specEntries).toEqual(liveEntries);
  });
});

describe('toOpenApiPath', () => {
  it('converts express param syntax to OpenAPI brace syntax', () => {
    expect(toOpenApiPath('/corpus/:did/sync')).toBe('/corpus/{did}/sync');
    expect(toOpenApiPath('/health')).toBe('/health');
  });
});
