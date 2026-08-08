import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// POST /media/api/assets owns the upload half of the #1542 article-frontmatter
// guard: article-context markdown with no usable `---` header must come back
// with a warning + `articleProjection: null` (or a 400 under `strict`), while
// plain-note uploads stay completely untouched. Everything downstream of the
// guard (createAsset) is stubbed — this is about the response contract.

const mockCreateAsset = vi.hoisted(() => vi.fn());
const mockIdentityLimit = vi.hoisted(() => vi.fn().mockResolvedValue([{ tier: 'soft', uploadLimitMb: 50 }]));

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: mockIdentityLimit })) })),
    })),
  },
  assets: {},
  identities: { id: 'id', tier: 'tier', uploadLimitMb: 'uploadLimitMb' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
  ilike: vi.fn(),
  like: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(async () => ({ identity: { id: 'did:imajin:owner', scope: 'actor' } })),
  resolveActingDid: vi.fn(() => 'did:imajin:owner'),
}));

vi.mock('@imajin/config', () => ({
  rateLimit: vi.fn(() => ({ limited: false })),
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: vi.fn(() => ({})),
  corsOptions: vi.fn(() => new Response(null, { status: 204 })),
}));

vi.mock('@/src/lib/media/create-asset', () => ({
  createAsset: mockCreateAsset,
  inferMime: (browserMime: string, filename: string) =>
    browserMime && browserMime !== 'application/octet-stream'
      ? browserMime
      : filename.endsWith('.md')
        ? 'text/markdown'
        : 'application/octet-stream',
  isAllowedMime: () => true,
}));

import type { NextRequest } from 'next/server';
import { POST } from '@/app/media/api/assets/route';

// ─── Helpers ───────────────────────────────────────────────────────────────

const HEADERLESS = '# Newsletter\n\nNo YAML header here.\n';
const WITH_HEADER =
  '---\nslug: "hello"\ntitle: "Hello"\nstatus: "DRAFT"\ndate: "2026-08-01"\n---\n\n# Hello\n';

interface UploadOptions {
  content?: string;
  filename?: string;
  type?: string;
  context?: Record<string, unknown>;
  strict?: string;
}

function uploadRequest({
  content = HEADERLESS,
  filename = 'newsletter.md',
  type = 'text/markdown',
  context,
  strict,
}: UploadOptions = {}): NextRequest {
  const form = new FormData();
  form.append('file', new File([content], filename, { type }), filename);
  if (context) form.append('context', JSON.stringify(context));
  if (strict !== undefined) form.append('strict', strict);

  return new Request('https://test.imajin.ai/media/api/assets', {
    method: 'POST',
    body: form,
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIdentityLimit.mockResolvedValue([{ tier: 'soft', uploadLimitMb: 50 }]);
  mockCreateAsset.mockResolvedValue({
    asset: {
      id: 'asset_new',
      filename: 'newsletter.md',
      mimeType: 'text/markdown',
      size: 42,
      hash: 'deadbeef',
      cid: 'bafytest',
      storagePath: '/mnt/media/x/assets/asset_new.md',
      fairManifest: {},
      createdAt: new Date('2026-08-01T00:00:00Z'),
    },
    deduplicated: false,
  });
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('POST /media/api/assets — article frontmatter guard (#1542)', () => {
  it('warns and flags articleProjection: null for article-context markdown with no header', async () => {
    const res = await POST(uploadRequest({ context: { app: 'article' } }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('asset_new');
    expect(body.articleProjection).toBeNull();
    expect(body.warning).toBe(
      'article-context markdown has no frontmatter title — metadata.article will be null; asset will NOT render as an article',
    );
    // Warn-only by default: the asset is still created.
    expect(mockCreateAsset).toHaveBeenCalledTimes(1);
  });

  it('carries the warning on the dedup response too', async () => {
    mockCreateAsset.mockResolvedValueOnce({
      asset: {
        id: 'asset_existing',
        filename: 'newsletter.md',
        mimeType: 'text/markdown',
        size: 42,
        hash: 'deadbeef',
        cid: 'bafytest',
      },
      deduplicated: true,
    });

    const res = await POST(uploadRequest({ context: { feature: 'article' } }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deduplicated).toBe(true);
    expect(body.articleProjection).toBeNull();
    expect(body.warning).toContain('will NOT render as an article');
  });

  it('stays silent when the markdown carries valid frontmatter', async () => {
    const res = await POST(uploadRequest({ content: WITH_HEADER, context: { app: 'article' } }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warning).toBeUndefined();
    expect('articleProjection' in body).toBe(false);
  });

  it('leaves plain-note uploads completely unaffected', async () => {
    const res = await POST(uploadRequest());

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warning).toBeUndefined();
    expect('articleProjection' in body).toBe(false);
  });

  it('rejects with 400 under strict, without creating the asset', async () => {
    const res = await POST(uploadRequest({ context: { app: 'article' }, strict: 'true' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('will NOT render as an article');
    expect(body.articleProjection).toBeNull();
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it('strict does not block a plain-note upload', async () => {
    const res = await POST(uploadRequest({ strict: 'true' }));

    expect(res.status).toBe(201);
    expect(mockCreateAsset).toHaveBeenCalledTimes(1);
  });
});
