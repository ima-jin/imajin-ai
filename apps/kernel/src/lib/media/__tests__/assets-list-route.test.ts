import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// GET /media/api/assets (#2648): accepts a scoped `media:read` app-token
// alongside session auth, filters on the upload context stored at
// `assets.metadata.context` (`context_app` / `context_feature`), and keeps the
// pre-existing `did=` public-only cross-identity behavior.

const mockOffset = vi.hoisted(() => vi.fn());
const mockWhere = vi.hoisted(() => vi.fn());
const mockOrderBy = vi.hoisted(() => vi.fn());
const mockLimit = vi.hoisted(() => vi.fn());
const mockFrom = vi.hoisted(() => vi.fn());

vi.mock('@/src/db', () => ({
  db: { select: vi.fn(() => ({ from: mockFrom })) },
  assets: { ownerDid: 'owner_did', status: 'status', metadata: 'metadata', fairManifest: 'fair_manifest', mimeType: 'mime_type', filename: 'filename', createdAt: 'created_at' },
  identities: {},
}));

// `sql` records its bound values so filter conditions can be asserted on.
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
  and: vi.fn((...conds: unknown[]) => ({ op: 'and', conds })),
  like: vi.fn(),
  ilike: vi.fn(),
  desc: vi.fn(),
  asc: vi.fn(),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    text: strings.join('?'),
    values,
  })),
}));

import { createAuthMock, createNodeUrlMock, createLoggerMock, appToken, APP_TOKEN_READ_ONLY, APP_TOKEN_WRITE_ONLY } from './media-auth-test-helpers';

const mockVerifyAppToken = vi.hoisted(() => vi.fn(async () => null));

vi.mock('@imajin/auth', () => createAuthMock(mockVerifyAppToken));
vi.mock('@/src/lib/http/node-url', () => createNodeUrlMock());
vi.mock('@imajin/logger', () => createLoggerMock());

vi.mock('@imajin/config', () => ({
  rateLimit: vi.fn(() => ({ limited: false })),
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: vi.fn(() => ({})),
  corsOptions: vi.fn(() => new Response(null, { status: 204 })),
}));

vi.mock('@/src/lib/media/create-asset', () => ({
  createAsset: vi.fn(),
  inferMime: vi.fn(),
  isAllowedMime: vi.fn(),
}));

import { requireAuth } from '@imajin/auth';
import { GET } from '@/app/media/api/assets/route';

// ─── Helpers ───────────────────────────────────────────────────────────────

interface Condition {
  op: string;
  text?: string;
  col?: unknown;
  val?: unknown;
  values?: unknown[];
}

function listRequest(query = '', bearer?: string): NextRequest {
  return new Request(`https://test.imajin.ai/media/api/assets${query}`, {
    method: 'GET',
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined,
  }) as unknown as NextRequest;
}

/** The conditions the route passed to `and(...)` on the last query. */
function lastConditions(): Condition[] {
  const arg = mockWhere.mock.calls.at(-1)?.[0] as { conds: Condition[] };
  return arg.conds;
}

function contextConditions(): Condition[] {
  return lastConditions().filter((c) => c.op === 'sql' && c.text?.includes("'context'"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyAppToken.mockResolvedValue(null);
  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ orderBy: mockOrderBy });
  mockOrderBy.mockReturnValue({ limit: mockLimit });
  mockLimit.mockReturnValue({ offset: mockOffset });
  mockOffset.mockResolvedValue([{ id: 'asset_1' }]);
  vi.mocked(requireAuth).mockResolvedValue({ identity: { id: 'did:imajin:owner', scope: 'actor' } } as never);
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('GET /media/api/assets — auth modes (#2648)', () => {
  it('lists the session user\'s own assets, unchanged', async () => {
    const res = await GET(listRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ assets: [{ id: 'asset_1' }], count: 1 });
    expect(lastConditions()).toContainEqual(expect.objectContaining({ op: 'eq', val: 'did:imajin:owner' }));
  });

  it('returns 401 when session auth fails', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Not authenticated', status: 401 } as never);
    const res = await GET(listRequest());
    expect(res.status).toBe(401);
  });

  it('accepts a media:read app-token and lists assets owned by its sub', async () => {
    mockVerifyAppToken.mockResolvedValueOnce(appToken(APP_TOKEN_READ_ONLY, 'did:imajin:app-user'));

    const res = await GET(listRequest('', 'scoped-app-token'));
    expect(res.status).toBe(200);
    expect(requireAuth).not.toHaveBeenCalled();
    expect(lastConditions()).toContainEqual(expect.objectContaining({ op: 'eq', val: 'did:imajin:app-user' }));
  });

  it('returns 403 for an app-token without media:read and never falls back to session auth', async () => {
    mockVerifyAppToken.mockResolvedValueOnce(appToken(APP_TOKEN_WRITE_ONLY));

    const res = await GET(listRequest('', 'write-only-app-token'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Missing required scope: media:read');
    expect(requireAuth).not.toHaveBeenCalled();
    expect(mockOffset).not.toHaveBeenCalled();
  });

  it('falls through to session auth when the bearer is not a verifiable app-token', async () => {
    mockVerifyAppToken.mockResolvedValueOnce(null);

    const res = await GET(listRequest('', 'legacy-pat'));
    expect(res.status).toBe(200);
    expect(requireAuth).toHaveBeenCalledTimes(1);
  });
});

describe('GET /media/api/assets — did= param', () => {
  it('lists another DID\'s assets restricted to public ones', async () => {
    const res = await GET(listRequest('?did=did:imajin:other'));
    expect(res.status).toBe(200);
    const conds = lastConditions();
    expect(conds).toContainEqual(expect.objectContaining({ op: 'eq', val: 'did:imajin:other' }));
    expect(conds.some((c) => c.op === 'sql' && c.text?.includes("= 'public'"))).toBe(true);
  });

  it('does not restrict to public when did= equals the caller\'s own DID', async () => {
    await GET(listRequest('?did=did:imajin:owner'));
    expect(lastConditions().some((c) => c.op === 'sql' && c.text?.includes("= 'public'"))).toBe(false);
  });

  it('applies did= to an app-token caller too (public-only for another DID)', async () => {
    mockVerifyAppToken.mockResolvedValueOnce(appToken(APP_TOKEN_READ_ONLY, 'did:imajin:app-user'));

    await GET(listRequest('?did=did:imajin:other', 'scoped-app-token'));
    const conds = lastConditions();
    expect(conds).toContainEqual(expect.objectContaining({ op: 'eq', val: 'did:imajin:other' }));
    expect(conds.some((c) => c.op === 'sql' && c.text?.includes("= 'public'"))).toBe(true);
  });
});

describe('GET /media/api/assets — context filters (#2648)', () => {
  it('adds no context condition when neither filter is given', async () => {
    await GET(listRequest());
    expect(contextConditions()).toHaveLength(0);
  });

  it('filters on context_app, binding the value as a parameter', async () => {
    await GET(listRequest('?context_app=dykil'));
    const conds = contextConditions();
    expect(conds).toHaveLength(1);
    expect(conds[0].text).toContain("->>'app'");
    expect(conds[0].values).toContain('dykil');
  });

  it('filters on context_feature', async () => {
    await GET(listRequest('?context_feature=survey'));
    const conds = contextConditions();
    expect(conds).toHaveLength(1);
    expect(conds[0].text).toContain("->>'feature'");
    expect(conds[0].values).toContain('survey');
  });

  it('ANDs both filters together', async () => {
    await GET(listRequest('?context_app=dykil&context_feature=survey'));
    const conds = contextConditions();
    expect(conds).toHaveLength(2);
    expect(conds.map((c) => c.values?.[1] ?? c.values?.[0])).toEqual(expect.arrayContaining(['dykil', 'survey']));
  });

  it('binds hostile values as parameters, never into the SQL text', async () => {
    const hostile = "x' OR '1'='1";
    await GET(listRequest(`?context_app=${encodeURIComponent(hostile)}`));
    const [cond] = contextConditions();
    expect(cond.text).not.toContain(hostile);
    expect(cond.values).toContain(hostile);
  });
});
