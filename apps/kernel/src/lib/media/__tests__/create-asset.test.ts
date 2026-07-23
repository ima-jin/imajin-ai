import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// createAsset is the shared create pipeline (#1170). These tests specifically
// cover the article frontmatter projection step added in #1244: for markdown
// uploads, deriveArticleProjection must be called and its result reflected in
// the returned asset's metadata.

const mockInsertValuesReturning = vi.fn();
const mockInsertValues = vi.fn(() => ({
  returning: mockInsertValuesReturning,
  onConflictDoNothing: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
}));
const mockSelectFromWhereLimit = vi.fn().mockResolvedValue([]);
const mockSelectFromWhere = vi.fn(() => ({ limit: mockSelectFromWhereLimit }));
const mockSelectFrom = vi.fn(() => ({ where: mockSelectFromWhere }));
const mockUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
const mockUpdateSet = vi.fn(() => ({ where: mockUpdateSetWhere }));

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: mockSelectFrom })),
    insert: vi.fn(() => ({ values: mockInsertValues })),
    update: vi.fn(() => ({ set: mockUpdateSet })),
  },
  assets: {},
  folders: {},
  assetFolders: {},
}));

vi.mock('node:crypto', () => ({
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => 'deadbeef'),
  })),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('nanoid', () => ({ nanoid: vi.fn(() => 'testid1234567890') }));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ hexToBytes: vi.fn(() => new Uint8Array()) }));

vi.mock('@/src/lib/media/classify', () => ({
  classifyAsset: vi.fn().mockResolvedValue({ category: 'text', confidence: 0.9 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

vi.mock('@imajin/fair', () => ({
  getDefaultManifest: vi.fn(() => ({ id: '', created: '', access: {} })),
  signManifest: vi.fn(async (m: unknown) => m),
  canonicalize: vi.fn(() => '{}'),
}));

vi.mock('@imajin/dfos', () => ({
  publishContentEvent: vi.fn().mockResolvedValue(null),
}));

vi.mock('@imajin/cid', () => ({
  computeCid: vi.fn().mockResolvedValue('bafytest'),
}));

vi.mock('@/src/lib/media/blob-store-lore', () => ({
  blobStore: { put: vi.fn().mockResolvedValue(null) },
}));

const mockDeriveArticleProjection = vi.hoisted(() => vi.fn());
vi.mock('@/src/lib/media/folders', () => ({
  getOrCreateSystemFolder: vi.fn().mockResolvedValue('folder_test'),
  addAssetToGrantsFolder: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/src/lib/media/article-core', () => ({
  deriveArticleProjection: mockDeriveArticleProjection,
  // Real-implementation stand-in: mergeArticleMetadata is a pure merge helper.
  mergeArticleMetadata: (existing: unknown, article: unknown) => ({
    ...(typeof existing === 'object' && existing !== null ? (existing as Record<string, unknown>) : {}),
    article,
  }),
}));

import { createAsset } from '../create-asset';

// ─── Helpers ───────────────────────────────────────────────────────────────

const MD_BUFFER = Buffer.from(
  '---\nslug: "hello"\ntitle: "Hello"\nstatus: "DRAFT"\ndate: "2026-07-07"\n---\n\n# Hello\n',
  'utf8',
);

const MARKDOWN_INPUT = {
  ownerDid: 'did:imajin:owner',
  buffer: MD_BUFFER,
  filename: 'hello.md',
  mimeType: 'text/markdown',
  context: { app: 'article' },
  classify: false,
};

function setupInsert(metadataOverride: unknown = { context: { app: 'article' } }) {
  const record = {
    id: 'asset_testid1234567890',
    ownerDid: 'did:imajin:owner',
    filename: 'hello.md',
    mimeType: 'text/markdown',
    size: MD_BUFFER.byteLength,
    storagePath: '/mnt/media/did_imajin_owner/assets/asset_testid1234567890.md',
    hash: 'deadbeef',
    cid: 'bafytest',
    fairManifest: {},
    fairPath: '/mnt/media/did_imajin_owner/assets/asset_testid1234567890.fair.json',
    metadata: metadataOverride,
    createdAt: new Date(),
  };
  mockInsertValuesReturning.mockResolvedValueOnce([record]);
  return record;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore chained implementations cleared by clearAllMocks.
  mockSelectFromWhere.mockImplementation(() => ({ limit: mockSelectFromWhereLimit }));
  mockSelectFrom.mockImplementation(() => ({ where: mockSelectFromWhere }));
  mockInsertValues.mockImplementation(() => ({
    returning: mockInsertValuesReturning,
    onConflictDoNothing: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
  }));
  mockUpdateSet.mockImplementation(() => ({ where: mockUpdateSetWhere }));
  mockSelectFromWhereLimit.mockResolvedValue([]); // default: no dedup match
  mockUpdateSetWhere.mockResolvedValue(undefined);
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('createAsset — article frontmatter projection (#1244)', () => {
  it('calls deriveArticleProjection for a markdown upload', async () => {
    setupInsert();
    mockDeriveArticleProjection.mockResolvedValueOnce({ article: null });

    await createAsset(MARKDOWN_INPUT);

    expect(mockDeriveArticleProjection).toHaveBeenCalledTimes(1);
    const [calledAssetId, calledContent] = mockDeriveArticleProjection.mock.calls[0] as [string, string];
    expect(calledAssetId).toBe('asset_testid1234567890');
    expect(calledContent).toContain('slug: "hello"');
  });

  it('reflects metadata.article in the returned asset when frontmatter is valid', async () => {
    setupInsert();
    const article = { slug: 'hello', title: 'Hello', status: 'DRAFT', date: '2026-07-07' };
    mockDeriveArticleProjection.mockResolvedValueOnce({ article });

    const { asset, deduplicated } = await createAsset(MARKDOWN_INPUT);

    expect(deduplicated).toBe(false);
    const meta = asset.metadata as Record<string, unknown>;
    expect(meta.article).toEqual(article);
  });

  it('leaves metadata unchanged when markdown has no valid article frontmatter (plain note)', async () => {
    setupInsert({ context: { app: 'article' } });
    mockDeriveArticleProjection.mockResolvedValueOnce({ article: null });

    const { asset } = await createAsset(MARKDOWN_INPUT);

    const meta = asset.metadata as Record<string, unknown>;
    expect(meta.article).toBeUndefined();
  });

  it('does NOT call deriveArticleProjection for non-markdown uploads', async () => {
    mockInsertValuesReturning.mockResolvedValueOnce([{
      id: 'asset_testid1234567890',
      ownerDid: 'did:imajin:owner',
      filename: 'photo.png',
      mimeType: 'image/png',
      size: 6,
      storagePath: '/mnt/media/did_imajin_owner/assets/asset_testid1234567890.png',
      hash: 'deadbeef',
      cid: 'bafytest',
      fairManifest: {},
      fairPath: null,
      metadata: {},
      createdAt: new Date(),
    }]);

    await createAsset({
      ownerDid: 'did:imajin:owner',
      buffer: Buffer.from('binary'),
      filename: 'photo.png',
      mimeType: 'image/png',
      classify: false,
    });

    expect(mockDeriveArticleProjection).not.toHaveBeenCalled();
  });

  it('is non-fatal: returns the asset even when deriveArticleProjection throws', async () => {
    setupInsert();
    mockDeriveArticleProjection.mockRejectedValueOnce(new Error('DB timeout'));

    const { asset } = await createAsset(MARKDOWN_INPUT);

    expect(asset.id).toBe('asset_testid1234567890');
    const meta = asset.metadata as Record<string, unknown>;
    expect(meta.article).toBeUndefined();
  });

  it('skips projection for a dedup match and returns the existing asset unchanged', async () => {
    const existing = {
      id: 'asset_existing',
      ownerDid: 'did:imajin:owner',
      filename: 'hello.md',
      mimeType: 'text/markdown',
      metadata: { article: { slug: 'old' }, context: { app: 'article' } },
      cid: 'bafytest',
      status: 'active',
    };
    // CID dedup match on first select call.
    mockSelectFromWhereLimit.mockResolvedValueOnce([existing]);

    const { asset, deduplicated } = await createAsset(MARKDOWN_INPUT);

    expect(deduplicated).toBe(true);
    expect(asset.id).toBe('asset_existing');
    expect(mockDeriveArticleProjection).not.toHaveBeenCalled();
  });
});
