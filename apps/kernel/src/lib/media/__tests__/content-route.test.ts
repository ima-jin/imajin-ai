import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// PUT /media/api/assets/[id]/content is the update half of the #1542 guard: it
// must relay updateAssetContent's article warning (warning + articleProjection:
// null) on 200, and turn a strict rejection into a 400. updateAssetContent
// itself is stubbed — its behavior is covered in update-asset.test.ts.

vi.mock('@/src/db', () => ({
  db: { select: vi.fn() },
  assets: {},
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(async () => ({ identity: { id: 'did:imajin:owner', scope: 'actor' } })),
  resolveActingDid: vi.fn(() => 'did:imajin:owner'),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

vi.mock('@/src/lib/media/read-access', () => ({ getAccessType: vi.fn(() => 'private') }));
vi.mock('@/src/lib/media/authorize-read', () => ({ authorizeAssetRead: vi.fn() }));

vi.mock('@/src/lib/media/update-asset', () => ({ updateAssetContent: vi.fn() }));

import { PUT } from '@/app/media/api/assets/[id]/content/route';
import { updateAssetContent } from '@/src/lib/media/update-asset';

// ─── Helpers ───────────────────────────────────────────────────────────────

const params = Promise.resolve({ id: 'asset_test' });

function putRequest(body: unknown): NextRequest {
  return new Request('https://test.imajin.ai/media/api/assets/asset_test/content', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const asset = { id: 'asset_test', mimeType: 'text/markdown' };

beforeEach(() => {
  vi.clearAllMocks();
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
