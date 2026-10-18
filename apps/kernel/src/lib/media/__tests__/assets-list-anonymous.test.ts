import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';
import type { MediaAuthResult } from '../require-media-auth';
import { getAccessType } from '../read-access';
import { createLoggerMock } from './media-auth-test-helpers';

const harness = vi.hoisted(() => ({
  client: null as PGlite | null,
  query: vi.fn(),
  auth: vi.fn<() => Promise<MediaAuthResult>>(),
  rateLimit: vi.fn<() => { limited: boolean; retryAfter?: number }>(),
}));

// Only the DB entrypoint is replaced: the route executes real Drizzle SQL
// against the production table definition, without loading the runtime DB.
vi.mock('@/src/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('@/src/db/schemas/media');
  harness.client = new PGlite();
  return {
    ...schema,
    identities: {},
    db: drizzle(harness.client, {
      schema,
      logger: { logQuery: (query: string, params: unknown[]) => harness.query(query, params) },
    }),
  };
});

vi.mock('@/src/lib/media/require-media-auth', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireMediaAuth: harness.auth,
    mediaAuthErrorResponse: (
      result: { error: string; status: number },
      headers?: Record<string, string>,
    ) => NextResponse.json({ error: result.error }, { status: result.status, headers }),
  };
});

vi.mock('@imajin/config', () => ({
  rateLimit: harness.rateLimit,
  getClientIP: vi.fn(() => '203.0.113.42'),
}));
vi.mock('@imajin/logger', () => createLoggerMock());
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: vi.fn(() => ({ 'Access-Control-Allow-Origin': '*' })),
  corsOptions: vi.fn(() => new Response(null, { status: 204 })),
}));
vi.mock('@/src/lib/media/create-asset', () => ({
  createAsset: vi.fn(),
  inferMime: vi.fn(),
  isAllowedMime: vi.fn(),
}));

import { db } from '@/src/db';
import { assets, type NewAsset } from '@/src/db/schemas/media';
import { GET } from '@/app/media/api/assets/route';

const OWNER = 'did:imajin:anonymous-fixture';
const PAGING_OWNER = 'did:imajin:anonymous-pagination';
const OTHER_OWNER = 'did:imajin:someone-else';
const DATE = new Date('2026-01-01T00:00:00.000Z');

const accessCases = [
  { id: 'public-string', access: 'public', visible: true },
  { id: 'public-object', access: { type: 'public' }, visible: true },
  { id: 'private-string', access: 'private', visible: false },
  { id: 'private-object', access: { type: 'private' }, visible: false },
  { id: 'unlisted-string', access: 'unlisted', visible: false },
  { id: 'unlisted-object', access: { type: 'unlisted' }, visible: false },
  { id: 'connections', access: { type: 'connections' }, visible: false },
  { id: 'trust-graph', access: { type: 'trust-graph', allowedDids: [OWNER] }, visible: false },
  { id: 'conversation', access: { type: 'conversation', conversationId: 'secret-thread' }, visible: false },
  { id: 'missing-access', access: undefined, visible: false },
  { id: 'null-access', access: null, visible: false },
  { id: 'malformed-number', access: 42, visible: false },
  { id: 'malformed-array', access: ['public'], visible: false },
  { id: 'malformed-object', access: {}, visible: false },
  { id: 'malformed-type', access: { type: ['public'] }, visible: false },
  { id: 'wrong-case', access: 'PUBLIC', visible: false },
] as const;

function asset(id: string, overrides: Partial<NewAsset> = {}): NewAsset {
  return {
    id,
    ownerDid: OWNER,
    uploadedBy: 'did:imajin:secret-uploader',
    filename: `${id}.png`,
    mimeType: 'image/png',
    size: 1234,
    storagePath: `/mnt/private/${id}.png`,
    hash: `sha256:${id}`,
    fairPath: `/mnt/private/${id}.fair.json`,
    fairManifest: { access: 'public', privateNote: 'manifest-secret' },
    metadata: {
      context: { app: 'gallery', feature: 'portfolio', entityId: 'secret-entity' },
      ownerNote: 'owner-only-note',
    },
    cid: `bafy-secret-${id}`,
    loreRef: `lore-secret-${id}`,
    fairDfosEventId: `event-secret-${id}`,
    folderId: 'secret-folder',
    tags: ['secret-tag'],
    classification: 'secret-classification',
    status: 'active',
    createdAt: DATE,
    updatedAt: DATE,
    ...overrides,
  };
}

function request(params: Record<string, string> = {}): NextRequest {
  const url = new URL('https://test.imajin.ai/media/api/assets');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url) as unknown as NextRequest;
}

interface ListBody {
  assets: Array<Record<string, unknown> & { id: string }>;
  count: number;
  limit: number;
  offset: number;
}

async function list(params: Record<string, string> = {}): Promise<ListBody> {
  const response = await GET(request({ did: OWNER, ...params }));
  expect(response.status).toBe(200);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  return response.json();
}

beforeAll(async () => {
  // Include every column in the imported assets schema, so authenticated
  // select-all queries also exercise the real SQL result shape.
  await harness.client!.exec(`
    CREATE SCHEMA media;
    CREATE TABLE media.assets (
      id text PRIMARY KEY,
      owner_did text NOT NULL,
      uploaded_by text,
      filename text NOT NULL,
      mime_type text NOT NULL,
      size integer NOT NULL,
      storage_path text NOT NULL,
      hash text NOT NULL,
      fair_manifest jsonb DEFAULT '{}',
      fair_path text,
      version_count integer NOT NULL DEFAULT 1,
      cid text,
      lore_ref text,
      fair_dfos_event_id text,
      folder_id text,
      tags jsonb DEFAULT '[]',
      classification text,
      classification_confidence integer,
      metadata jsonb DEFAULT '{}',
      immutable boolean DEFAULT false,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
  `);

  await db.insert(assets).values([
    ...accessCases.map(({ id, access }) => asset(id, {
      fairManifest: access === undefined ? {} : { access },
      // Hidden rows sort first, catching post-pagination access filtering.
      createdAt: new Date(DATE.getTime() + (id.startsWith('public-') ? 0 : 10_000)),
    })),
    asset('null-manifest', { fairManifest: null }),
    asset('malformed-manifest', { fairManifest: 'public' }),
    ...['draft', 'processing', 'deleted'].map((status) => asset(`public-${status}`, {
      status,
      createdAt: new Date(DATE.getTime() + 20_000),
    })),
    asset('other-owner', { ownerDid: OTHER_OWNER, createdAt: new Date(DATE.getTime() + 30_000) }),
    asset('dykil-survey', {
      ownerDid: OTHER_OWNER,
      metadata: { context: { app: 'dykil', feature: 'survey' }, ownerNote: 'private-survey-note' },
    }),
    asset('other-app', { metadata: { context: { app: 'elsewhere', feature: 'portfolio' } } }),
    asset('other-feature', { metadata: { context: { app: 'gallery', feature: 'avatar' } } }),
    asset('no-context', { metadata: { ownerNote: 'not-an-upload-context' } }),
    asset('filter-match-old', {
      filename: 'Summer portrait old.png',
      createdAt: new Date(DATE.getTime() + 1000),
    }),
    asset('filter-match-new', {
      filename: 'SUMMER portrait new.png',
      fairManifest: { access: { type: 'public' } },
      createdAt: new Date(DATE.getTime() + 2000),
    }),
    asset('filter-wrong-mime', {
      filename: 'Summer portrait.mp3',
      mimeType: 'audio/mpeg',
      createdAt: new Date(DATE.getTime() + 3000),
    }),
    ...Array.from({ length: 205 }, (_, index) => asset(`page-${index}`, {
      ownerDid: PAGING_OWNER,
      fairManifest: { access: index % 2 ? 'public' : { type: 'public' } },
      createdAt: new Date(DATE.getTime() + index * 1000),
    })),
  ]);
}, 30_000);

afterAll(async () => {
  await harness.client?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  harness.auth.mockResolvedValue({ error: 'Not authenticated', status: 401 });
  harness.rateLimit.mockReturnValue({ limited: false });
});

describe('anonymous GET /media/api/assets — real SQL visibility', () => {
  it.each(accessCases)('$id agrees with canonical access resolution', async ({ id, access, visible }) => {
    expect(getAccessType(access as Parameters<typeof getAccessType>[0]) === 'public').toBe(visible);
    const body = await list({ search: id, limit: '200' });
    expect(body.assets.some((row) => row.id === id)).toBe(visible);
  });

  it('excludes every non-public, inactive, malformed-manifest and other-owner row', async () => {
    const body = await list({ limit: '200' });
    expect(body.assets.map((row) => row.id).sort()).toEqual([
      'public-string', 'public-object', 'other-app', 'other-feature', 'no-context',
      'filter-match-old', 'filter-match-new', 'filter-wrong-mime',
    ].sort());
    expect(body.count).toBe(8);
  });

  it('trims a nonempty DID before looking up its assets', async () => {
    const body = await list({ did: ` \t${OWNER}\n ` });
    expect(body.count).toBe(8);
    expect(body.assets.every((row) => row.ownerDid === OWNER)).toBe(true);
  });
  it('paginates only visible active rows belonging to the requested DID', async () => {
    const body = await list({ limit: '1' });
    expect(body.assets.map((row) => row.id)).toEqual(['filter-wrong-mime']);
    expect(body.count).toBe(1);
  });

  it.each([undefined, '', ' \t\n '])('returns 401 without querying for missing/blank DID %j', async (did) => {
    const response = await GET(request(did === undefined ? {} : { did }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Not authenticated' });
    expect(harness.query).not.toHaveBeenCalled();
    expect(harness.rateLimit).not.toHaveBeenCalled();
  });

  it('returns only the public descriptor allowlist, never owner metadata or storage details', async () => {
    const body = await list({ search: 'portrait new' });
    expect(body.assets).toHaveLength(1);
    expect(Object.keys(body.assets[0]).sort()).toEqual([
      'id', 'ownerDid', 'filename', 'mimeType', 'size', 'hash', 'createdAt', 'updatedAt',
    ].sort());
    expect(body.assets[0]).toEqual({
      id: 'filter-match-new',
      ownerDid: OWNER,
      filename: 'SUMMER portrait new.png',
      mimeType: 'image/png',
      size: 1234,
      hash: 'sha256:filter-match-new',
      createdAt: new Date(DATE.getTime() + 2000).toISOString(),
      updatedAt: DATE.toISOString(),
    });
  });

  it.each([
    [{ context_app: 'gallery' }, ['public-string', 'public-object', 'other-feature', 'filter-match-old', 'filter-match-new', 'filter-wrong-mime']],
    [{ context_feature: 'portfolio' }, ['public-string', 'public-object', 'other-app', 'filter-match-old', 'filter-match-new', 'filter-wrong-mime']],
    [{ search: 'sUmMeR' }, ['filter-match-old', 'filter-match-new', 'filter-wrong-mime']],
    [{ type: 'audio' }, ['filter-wrong-mime']],
    [{ context_app: "gallery' OR '1'='1" }, []],
  ] as const)('executes filter %j in SQL', async (params, expected) => {
    const body = await list({ ...params, limit: '200' });
    expect(body.assets.map((row) => row.id).sort()).toEqual([...expected].sort());
  });

  it('applies public/status/DID/context/search/type filters before limit and offset', async () => {
    const body = await list({
      context_app: 'gallery',
      context_feature: 'portfolio',
      search: 'SUMMER',
      type: 'image',
      order: 'desc',
      limit: '1',
      offset: '1',
    });
    expect(body).toMatchObject({ count: 1, limit: 1, offset: 1 });
    expect(body.assets.map((row) => row.id)).toEqual(['filter-match-old']);
  });

  it('supports the anonymous Dykil survey listing contract without leaking upload context', async () => {
    const body = await list({ did: OTHER_OWNER, context_app: 'dykil', context_feature: 'survey' });
    expect(body.assets.map((row) => row.id)).toEqual(['dykil-survey']);
    expect(body.assets[0]).not.toHaveProperty('metadata');
    expect(body.assets[0]).not.toHaveProperty('fairManifest');
  });

  it('supports ascending order on the already filtered rows', async () => {
    const body = await list({ search: 'Summer', type: 'image', order: 'asc', limit: '1' });
    expect(body.assets.map((row) => row.id)).toEqual(['filter-match-old']);
  });
});

describe('anonymous GET /media/api/assets — pagination boundaries', () => {
  it.each([
    [{}, 50, 0, 50],
    [{ limit: '0' }, 1, 0, 1],
    [{ limit: '-10' }, 1, 0, 1],
    [{ limit: '201' }, 200, 0, 200],
    [{ limit: '2147483647' }, 200, 0, 200],
    [{ limit: '9007199254740991' }, 200, 0, 200],
    [{ limit: '9007199254740992' }, 50, 0, 50],
    [{ offset: '-10' }, 50, 0, 50],
    [{ offset: '2147483648' }, 50, 2147483647, 0],
    [{ offset: '9007199254740991' }, 50, 2147483647, 0],
    [{ offset: '9007199254740992' }, 50, 0, 50],
    [{ limit: '2', offset: '200' }, 2, 200, 2],
  ] as const)('executes bounded pagination %j', async (params, limit, offset, count) => {
    const body = await list({ did: PAGING_OWNER, ...params });
    expect(body).toMatchObject({ limit, offset, count });
    expect(body.assets).toHaveLength(count);
    if (count > 0) expect(body.assets[0].id).toBe(`page-${204 - offset}`);
  });

  it.each(['garbage', 'NaN', 'Infinity', '1.5', '2trailing', '1e309', ''])(
    'defaults invalid/noninteger numeric input %j',
    async (value) => {
      const body = await list({ did: PAGING_OWNER, limit: value, offset: value });
      expect(body).toMatchObject({ limit: 50, offset: 0, count: 50 });
      expect(body.assets[0].id).toBe('page-204');
    },
  );
});

describe('anonymous GET /media/api/assets — auth and rate limiting', () => {
  it('sanitizes anonymous DB errors instead of exposing internal query details', async () => {
    const select = vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('internal SQL failure at /mnt/private/file');
    });
    try {
      const response = await GET(request({ did: OWNER }));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Database failure' });
    } finally {
      select.mockRestore();
    }
  });
  it('uses a dedicated anonymous client-IP rate-limit bucket', async () => {
    await list();
    expect(harness.rateLimit).toHaveBeenCalledTimes(1);
    expect(harness.rateLimit).toHaveBeenCalledWith(
      'media:assets:anonymous:203.0.113.42', 60, 60_000,
    );
  });

  it('returns 429 and Retry-After before any DB query when limited', async () => {
    harness.rateLimit.mockReturnValue({ limited: true, retryAfter: 37 });
    const response = await GET(request({ did: OWNER }));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('37');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await response.json()).toMatchObject({ error: 'Too many requests', retryAfter: 37 });
    expect(harness.query).not.toHaveBeenCalled();
  });

  it('never downgrades an authenticated 403 to anonymous public access', async () => {
    harness.auth.mockResolvedValue({ error: 'Missing required scope: media:read', status: 403 });
    const response = await GET(request({ did: OWNER }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Missing required scope: media:read' });
    expect(harness.query).not.toHaveBeenCalled();
    expect(harness.rateLimit).not.toHaveBeenCalled();
  });

  it('preserves authenticated owner visibility and full metadata without anonymous limiting', async () => {
    harness.auth.mockResolvedValue({ auth: { did: OWNER, identity: null } });
    const body = await list({ search: 'private-string' });
    expect(body.assets).toHaveLength(1);
    expect(body.assets[0]).toMatchObject({
      id: 'private-string',
      storagePath: '/mnt/private/private-string.png',
      uploadedBy: 'did:imajin:secret-uploader',
      fairManifest: { access: 'private' },
      metadata: { ownerNote: 'owner-only-note' },
    });
    expect(harness.rateLimit).not.toHaveBeenCalled();
  });
});
