import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateAssetContent } from '../update-asset';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// updateAssetContent is the single authored-document write path (#1170). We
// stub every side-effecting dependency so the test isolates the #1205
// document.changed trigger: an authored-doc write must publish exactly one
// document.changed with { path, cid, prevCid } and an owner issuer; a
// non-authored write must never fire it (discipline rule 1).

const mockLimit = vi.fn();
const mockSelectWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockSelectWhere }));
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockSet = vi.fn(() => ({ where: mockUpdateWhere }));

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: mockFrom })),
    update: vi.fn(() => ({ set: mockSet })),
  },
  assets: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

vi.mock('@imajin/cid', () => ({
  computeCid: vi.fn().mockResolvedValue('bafy-new-cid'),
}));

// v1.1 guard returns false so the .fair re-sign path is skipped in tests.
vi.mock('@imajin/fair', () => ({
  isFairManifestV1_1: vi.fn(() => false),
}));

vi.mock('@/src/lib/media/content-signer', () => ({
  contentSigner: { sign: vi.fn() },
}));

vi.mock('@/src/lib/media/blob-store-lore', () => ({
  blobStore: { put: vi.fn().mockResolvedValue(null) },
}));

vi.mock('@/src/lib/media/write-access', () => ({
  canWriteAssetContent: vi.fn(() => ({ allowed: true })),
}));

// Keep the real projection helpers (article-guard consumes
// projectArticleFromFrontmatter) and stub only the DB-writing derive step.
vi.mock('../article-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../article-core')>()),
  deriveArticleProjection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/bus', () => ({
  publish: vi.fn().mockResolvedValue(undefined),
  // update-asset now registers the #1207 project reactor before publishing;
  // stub registerReactor so ensureProjectReactorRegistered() is a no-op here.
  registerReactor: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { publish } from '@imajin/bus';
import { writeFile } from 'node:fs/promises';

// ─── Helpers ───────────────────────────────────────────────────────────────

function setupAsset(overrides: Record<string, unknown> = {}) {
  const asset = {
    id: 'asset_test',
    ownerDid: 'did:imajin:owner',
    status: 'active',
    mimeType: 'text/markdown',
    storagePath: '/mnt/media/did_imajin_owner/assets/asset_test.md',
    immutable: false,
    fairManifest: {},
    fairPath: null,
    cid: 'bafy-old-cid',
    loreRef: 'lore-old',
    versionCount: 1,
    metadata: {},
    ...overrides,
  };

  // Both the initial load and the final re-select resolve to the asset.
  mockLimit.mockResolvedValue([asset]);
  return asset;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('updateAssetContent — document.changed trigger (#1205)', () => {
  it('publishes exactly one document.changed for an authored-markdown write', async () => {
    setupAsset({ mimeType: 'text/markdown' });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: '# Hello',
    });

    expect(result.ok).toBe(true);

    const changedCalls = vi
      .mocked(publish)
      .mock.calls.filter(([type]) => type === 'document.changed');
    expect(changedCalls).toHaveLength(1);

    expect(publish).toHaveBeenCalledWith('document.changed', {
      issuer: 'did:imajin:owner',
      subject: 'asset_test',
      scope: 'media',
      payload: {
        path: '/mnt/media/did_imajin_owner/assets/asset_test.md',
        cid: 'bafy-new-cid',
        prevCid: 'bafy-old-cid',
      },
    });
  });

  it('reports prevCid as null when the asset had no prior CID', async () => {
    setupAsset({ mimeType: 'application/yaml', cid: null });

    await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: 'key: value',
    });

    expect(publish).toHaveBeenCalledWith(
      'document.changed',
      expect.objectContaining({
        payload: expect.objectContaining({ prevCid: null, cid: 'bafy-new-cid' }),
      })
    );
  });

  it('does NOT fire document.changed for a non-authored (binary) write', async () => {
    setupAsset({ mimeType: 'image/png' });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: 'not really an image',
    });

    expect(result.ok).toBe(true);

    const changedCalls = vi
      .mocked(publish)
      .mock.calls.filter(([type]) => type === 'document.changed');
    expect(changedCalls).toHaveLength(0);
  });
});

// ─── #1542 — article frontmatter guard ─────────────────────────────────────

const LIVE_ARTICLE = { article: { slug: 'hello', title: 'Hello', status: 'POSTED', date: '2026-08-01' } };
const HEADERLESS = '# Newsletter\n\nNo YAML header here.\n';
const WITH_HEADER =
  '---\nslug: "hello"\ntitle: "Hello"\nstatus: "POSTED"\ndate: "2026-08-01"\n---\n\n# Hello\n';

describe('updateAssetContent — article frontmatter guard (#1542)', () => {
  it('warns that a headerless write DEMOTES a live article', async () => {
    setupAsset({ metadata: LIVE_ARTICLE });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: HEADERLESS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning?.demotes).toBe(true);
    expect(result.articleWarning?.reason).toBe('missing_frontmatter');
    expect(result.articleWarning?.warning).toContain('DEMOTION');
    // Default is warn-only: the content is still written.
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('warns for an article-context asset that never had a projection', async () => {
    setupAsset({ metadata: { context: { app: 'article' } } });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: HEADERLESS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning?.demotes).toBe(false);
    expect(result.articleWarning?.warning).toContain('will NOT render as an article');
  });

  it('does NOT warn for a plain note (no article intent)', async () => {
    setupAsset({ metadata: {} });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: HEADERLESS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning).toBeNull();
  });

  it('does NOT warn when the new content keeps valid frontmatter', async () => {
    setupAsset({ metadata: LIVE_ARTICLE });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: WITH_HEADER,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning).toBeNull();
  });

  it('hard-rejects under strict, without writing anything', async () => {
    setupAsset({ metadata: LIVE_ARTICLE });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: HEADERLESS,
      strict: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('article_frontmatter_required');
    expect(writeFile).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('strict does not block a plain-note write', async () => {
    setupAsset({ metadata: {} });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: HEADERLESS,
      strict: true,
    });

    expect(result.ok).toBe(true);
  });
});
