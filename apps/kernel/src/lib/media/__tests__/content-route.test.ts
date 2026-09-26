import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// PUT /media/api/assets/[id]/content is the update half of the #1542 guard: it
// must relay updateAssetContent's article warning (warning + articleProjection:
// null) on 200, and turn a strict rejection into a 400. updateAssetContent
// itself is stubbed — its behavior is covered in update-asset.test.ts.

const mockAssetLimit = vi.hoisted(() => vi.fn());

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: mockAssetLimit })) })),
    })),
  },
  assets: {},
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

const mockVerifyAppToken = vi.hoisted(() => vi.fn(async () => null));

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(async () => ({ identity: { id: 'did:imajin:owner', scope: 'actor' } })),
  resolveActingDid: vi.fn((identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
  ),
  verifyAppToken: mockVerifyAppToken,
}));

vi.mock('@/src/lib/http/node-url', () => ({
  nodeUrl: vi.fn(() => 'https://jin.test'),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

const mockReadFile = vi.hoisted(() => vi.fn(async () => 'file content'));
vi.mock('node:fs/promises', () => ({ readFile: mockReadFile }));

const mockGetAccessType = vi.hoisted(() => vi.fn(() => 'private'));
vi.mock('@/src/lib/media/read-access', () => ({ getAccessType: mockGetAccessType }));

const mockAuthorizeAssetRead = vi.hoisted(() => vi.fn());
vi.mock('@/src/lib/media/authorize-read', () => ({ authorizeAssetRead: mockAuthorizeAssetRead }));

vi.mock('@/src/lib/media/update-asset', () => ({ updateAssetContent: vi.fn() }));

import { GET, PUT } from '@/app/media/api/assets/[id]/content/route';
import { updateAssetContent } from '@/src/lib/media/update-asset';
import { requireAuth } from '@imajin/auth';

// ─── Helpers ───────────────────────────────────────────────────────

const params = Promise.resolve({ id: 'asset_test' });

function putRequest(body: unknown): NextRequest {
  return new Request('https://test.imajin.ai/media/api/assets/asset_test/content', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function getRequest(bearer?: string): NextRequest {
  return new Request('https://test.imajin.ai/media/api/assets/asset_test/content', {
    method: 'GET',
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined,
  }) as unknown as NextRequest;
}

const asset = { id: 'asset_test', mimeType: 'text/markdown' };

const readableAsset = {
  id: 'asset_test',
  status: 'active',
  mimeType: 'text/markdown',
  ownerDid: 'did:imajin:owner',
  fairManifest: null as Record<string, unknown> | null,
  metadata: null,
  storagePath: '/mnt/media/asset_test.md',
  filename: 'asset_test.md',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyAppToken.mockResolvedValue(null);
  mockReadFile.mockResolvedValue('file content');
  mockGetAccessType.mockReturnValue('private');
  mockAssetLimit.mockResolvedValue([readableAsset]);
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('PUT /media/api/assets/[id]/content — article frontmatter guard (#1542)', () => {
  it('relays the warning and the articleProjection: null flag on success', async () => {
    vi.mocked(updateAssetContent).mockResolvedValueOnce({
      ok: true,
      asset,
      articleWarning: {
        warning: 'DEMOTION: … will STOP rendering as an article',
        reason: 'missing_frontmatter',
        demotes: true,
      },
    } as never);

    const res = await PUT(putRequest({ content: '# no header' }), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.articleProjection).toBeNull();
    expect(body.articleWarningReason).toBe('missing_frontmatter');
    expect(body.warning).toContain('DEMOTION');
  });

  it('returns a bare { ok: true } for a clean write', async () => {
    vi.mocked(updateAssetContent).mockResolvedValueOnce({ ok: true, asset } as never);

    const res = await PUT(putRequest({ content: 'body' }), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('forwards strict and maps the rejection to 400', async () => {
    vi.mocked(updateAssetContent).mockResolvedValueOnce({
      ok: false,
      code: 'article_frontmatter_required',
      message: 'article-context markdown has no frontmatter title',
    } as never);

    const res = await PUT(putRequest({ content: '# no header', strict: true }), { params });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('no frontmatter title');
    expect(body.articleProjection).toBeNull();
    expect(vi.mocked(updateAssetContent).mock.calls[0][0].strict).toBe(true);
  });

  it('defaults strict to false when the field is absent', async () => {
    vi.mocked(updateAssetContent).mockResolvedValueOnce({ ok: true, asset } as never);

    await PUT(putRequest({ content: 'body' }), { params });

    expect(vi.mocked(updateAssetContent).mock.calls[0][0].strict).toBe(false);
  });
});

describe('PUT /media/api/assets/[id]/content — auth modes (#2393)', () => {
  it('resolves requesterDid from the session identity on the cookie path', async () => {
    vi.mocked(updateAssetContent).mockResolvedValueOnce({ ok: true, asset } as never);

    await PUT(putRequest({ content: 'body' }), { params });

    expect(mockVerifyAppToken).not.toHaveBeenCalled();
    expect(vi.mocked(updateAssetContent).mock.calls[0][0].requesterDid).toBe('did:imajin:owner');
  });

  it('accepts a scoped app-token and uses its sub as requesterDid', async () => {
    mockVerifyAppToken.mockResolvedValueOnce({ sub: 'did:imajin:app-user', aud: 'jin.test', scopes: [] });
    vi.mocked(updateAssetContent).mockResolvedValueOnce({ ok: true, asset } as never);

    const req = putRequest({ content: 'body' });
    req.headers.set('Authorization', 'Bearer scoped-app-token');

    await PUT(req, { params });

    expect(vi.mocked(requireAuth)).not.toHaveBeenCalled();
    expect(vi.mocked(updateAssetContent).mock.calls[0][0].requesterDid).toBe('did:imajin:app-user');
  });

  it('returns 401 when neither a scoped app-token nor session auth verifies', async () => {
    // No Authorization header on this request at all, so verifyAppToken is
    // never even called — the default beforeEach stub already covers that.
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await PUT(putRequest({ content: 'body' }), { params });

    expect(res.status).toBe(401);
    expect(updateAssetContent).not.toHaveBeenCalled();
  });
});

// ─── GET /media/api/assets/[id]/content ─────────────────────────────────────
//
// #2393: adds scoped app-token support to the authenticated (non-public)
// branch, and aligns anonymous reads with GET /media/api/assets/[id] (raw
// bytes) — a public asset's content is now readable with no auth at all.

describe('GET /media/api/assets/[id]/content — auth modes (#2393)', () => {
  it('reads via the session cookie for a private asset the requester owns', async () => {
    mockGetAccessType.mockReturnValue('private');
    mockAuthorizeAssetRead.mockResolvedValueOnce({ allowed: true, requiresAuth: true, accessType: 'private' });

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe('file content');
    expect(mockVerifyAppToken).not.toHaveBeenCalled();
    expect(mockAuthorizeAssetRead).toHaveBeenCalledWith(
      expect.objectContaining({ ownerDid: 'did:imajin:owner' }),
      'did:imajin:owner',
    );
  });

  it('accepts a scoped app-token for a private asset the token subject owns', async () => {
    mockGetAccessType.mockReturnValue('private');
    mockVerifyAppToken.mockResolvedValueOnce({ sub: 'did:imajin:app-user', aud: 'jin.test', scopes: [] });
    mockAuthorizeAssetRead.mockResolvedValueOnce({ allowed: true, requiresAuth: true, accessType: 'private' });

    const res = await GET(getRequest('scoped-app-token'), { params });

    expect(res.status).toBe(200);
    expect(vi.mocked(requireAuth)).not.toHaveBeenCalled();
    expect(mockAuthorizeAssetRead).toHaveBeenCalledWith(expect.anything(), 'did:imajin:app-user');
  });

  it('returns 403 when a scoped app-token subject does not own a private asset', async () => {
    mockGetAccessType.mockReturnValue('private');
    mockVerifyAppToken.mockResolvedValueOnce({ sub: 'did:imajin:stranger', aud: 'jin.test', scopes: [] });
    mockAuthorizeAssetRead.mockResolvedValueOnce({
      allowed: false,
      requiresAuth: true,
      accessType: 'private',
      reason: 'Private asset — owner only',
    });

    const res = await GET(getRequest('scoped-app-token'), { params });

    expect(res.status).toBe(403);
  });

  it('returns 401 when neither a scoped app-token nor session auth verifies for a private asset', async () => {
    mockGetAccessType.mockReturnValue('private');
    // No Authorization header on this request at all, so verifyAppToken is
    // never even called — the default beforeEach stub already covers that.
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(401);
    expect(mockAuthorizeAssetRead).not.toHaveBeenCalled();
  });

  it('reads a public asset anonymously, with no auth check at all', async () => {
    mockGetAccessType.mockReturnValue('public');

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe('file content');
    expect(vi.mocked(requireAuth)).not.toHaveBeenCalled();
    expect(mockVerifyAppToken).not.toHaveBeenCalled();
    expect(mockAuthorizeAssetRead).not.toHaveBeenCalled();
  });

  it('still requires auth for a non-public asset (refuses an anonymous read)', async () => {
    mockGetAccessType.mockReturnValue('private');
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await GET(getRequest(), { params });

    expect(res.status).toBe(401);
  });
});
