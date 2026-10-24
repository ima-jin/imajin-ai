import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  let credential: string;

  beforeEach(() => {
    process.env.CORPUS_KERNEL_PUBLIC_KEY = KERNEL_KEYPAIR.publicKey;
    dataDir = mkdtempSync(join(tmpdir(), 'corpus-github-routes-'));
    engine = new CorpusEngine({ dataDir });
    app = createCorpusApp(engine);
    fetchMock = mockGitHubFetch();
    vi.stubGlobal('fetch', fetchMock);
    credential = randomUUID();
    vi.stubEnv('CORPUS_DID', 'did:example:corpus');
    vi.stubEnv('CORPUS_DID_PRIVATE_KEY', KERNEL_KEYPAIR.privateKey);
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('GH_TOKEN', '');
    engine.recordSourceState(did, 'github:ima-jin/imajin-ai', 'github:primary', undefined, did);
  });

  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (ORIGINAL_KERNEL_PUBLIC_KEY === undefined) delete process.env.CORPUS_KERNEL_PUBLIC_KEY;
    else process.env.CORPUS_KERNEL_PUBLIC_KEY = ORIGINAL_KERNEL_PUBLIC_KEY;
  });

  it('POST /corpus/:did/sources with type "github" reaches the GitHub adapter', async () => {
    const response = await request(app)
      .post(`/corpus/${did}/sources`)
      .set('Authorization', authFor())
      .set('X-Corpus-GitHub-Credential', credential)
      .set('X-Corpus-Credential-Ref', 'github:primary')
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
      .set('X-Corpus-GitHub-Credential', credential)
      .set('X-Corpus-Credential-Ref', 'github:primary')
      .send({ source: 'github:ima-jin/imajin-ai', cursor: null });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ingested: 0, hasMore: false });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('POST /corpus/:did/crawl with a "github:" source reaches the GitHub adapter', async () => {
    const response = await request(app)
      .post(`/corpus/${did}/crawl`)
      .set('Authorization', authFor())
      .set('X-Corpus-GitHub-Credential', credential)
      .set('X-Corpus-Credential-Ref', 'github:primary')
      .send({ source: 'github:ima-jin/imajin-ai' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ingested: 0 });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('POST /corpus/:did/ingest with { source: "github:..." } reaches the GitHub adapter', async () => {
    const response = await request(app)
      .post(`/corpus/${did}/ingest`)
      .set('Authorization', authFor())
      .set('X-Corpus-GitHub-Credential', credential)
      .set('X-Corpus-Credential-Ref', 'github:primary')
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

describe('GitHub source credential failures', () => {
  let dataDir: string;
  let engine: CorpusEngine;
  let app: ReturnType<typeof createCorpusApp>;
  let credential: string;

  beforeEach(() => {
    vi.stubEnv('CORPUS_KERNEL_PUBLIC_KEY', KERNEL_KEYPAIR.publicKey);
    vi.stubEnv('CORPUS_DID', 'did:example:corpus');
    vi.stubEnv('CORPUS_DID_PRIVATE_KEY', KERNEL_KEYPAIR.privateKey);
    dataDir = mkdtempSync(join(tmpdir(), 'corpus-github-credentials-'));
    engine = new CorpusEngine({ dataDir });
    app = createCorpusApp(engine);
    credential = randomUUID();
    vi.stubGlobal('fetch', mockGitHubFetch());
    engine.recordSourceState(did, 'github:ima-jin/imajin-ai', 'github:primary', undefined, did, true);
  });
  afterEach(() => {
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('persists a revoked credential error across restart without changing last successful sync', async () => {
    const before = engine.status(did).sources[0].lastSync;
    const response = await request(app).post(`/corpus/${did}/sync`)
      .set('Authorization', authFor()).send({ source: 'github:ima-jin/imajin-ai' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/revoked/);
    expect(engine.status(did).sources[0]).toMatchObject({ error: response.body.error, lastSync: before, credentialRef: 'github:primary' });
    expect(fetch).not.toHaveBeenCalled();
    engine.close();
    engine = new CorpusEngine({ dataDir });
    expect(engine.status(did).sources[0].error).toBe(response.body.error);
  });

  it.each([undefined, '', 'github:INVALID', 'vault:some-field', { token: true }])('rejects invalid or missing refs: %j', async credentialRef => {
    const response = await request(app).post(`/corpus/${did}/ingest`).set('Authorization', authFor())
      .send({ source: 'github:ima-jin/new-repo', credentialRef });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Select a GitHub connector/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('denies a read claim even when transport credentials are supplied', async () => {
    const response = await request(app).post(`/corpus/${did}/sync`)
      .set('Authorization', authFor('corpus:read'))
      .set('X-Corpus-GitHub-Credential', credential)
      .send({ source: 'github:ima-jin/imajin-ai' });
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects pasted credentials, invalid cursors and source-type mismatches without echoing input', async () => {
    for (const extra of [{ token: credential }, { cursor: {} }, { sourceType: 'local' }]) {
      const response = await request(app).post(`/corpus/${did}/ingest`).set('Authorization', authFor())
        .send({ source: 'github:ima-jin/imajin-ai', ...extra });
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body).includes(credential)).toBe(false);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not accept a different transport ref or a sync ref override', async () => {
    const response = await request(app).post(`/corpus/${did}/sync`).set('Authorization', authFor())
      .set('X-Corpus-GitHub-Credential', credential).set('X-Corpus-Credential-Ref', 'github:other')
      .send({ source: 'github:ima-jin/imajin-ai', credentialRef: 'github:other' });
    expect(response.status).toBe(400);
    expect(engine.status(did).sources[0].credentialRef).toBe('github:primary');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never echoes or persists provider exception details', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error(credential));
    const response = await request(app).post(`/corpus/${did}/sync`).set('Authorization', authFor())
      .set('X-Corpus-GitHub-Credential', credential).set('X-Corpus-Credential-Ref', 'github:primary')
      .send({ source: 'github:ima-jin/imajin-ai' });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body).includes(credential)).toBe(false);
    expect(JSON.stringify(engine.status(did)).includes(credential)).toBe(false);
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
