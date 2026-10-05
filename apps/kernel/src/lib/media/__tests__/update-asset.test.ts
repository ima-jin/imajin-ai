import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  isFairManifestV11: vi.fn(() => false),
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
import { isFairManifestV11 } from '@imajin/fair';
import { contentSigner } from '@/src/lib/media/content-signer';

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

// ─── #1870 — document-context markdown (silent lane) ───────────────────────

describe('updateAssetContent — document-context frontmatter guard (#1870)', () => {
  it('warns for a document-context asset that never had a projection', async () => {
    setupAsset({ metadata: { context: { app: 'document' } } });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: HEADERLESS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning?.demotes).toBe(false);
    expect(result.articleWarning?.reason).toBe('missing_frontmatter');
    // Default is warn-only: the content is still written.
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('does NOT warn when the new document-context content keeps valid frontmatter', async () => {
    setupAsset({ metadata: { context: { app: 'document' } } });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: WITH_HEADER,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning).toBeNull();
  });

  it('hard-rejects a headerless document-context write under strict', async () => {
    setupAsset({ metadata: { context: { app: 'document' } } });

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

  it('does NOT warn for note-context markdown (stays exempt)', async () => {
    setupAsset({ metadata: { context: { app: 'note' } } });

    const result = await updateAssetContent({
      assetId: 'asset_test',
      requesterDid: 'did:imajin:owner',
      content: HEADERLESS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning).toBeNull();
  });
});

// ─── .fair manifest re-sign (non-fatal at every step) ──────────────────────

describe('updateAssetContent — .fair manifest re-sign', () => {
  const MANIFEST = { version: '1.1', owner: 'did:imajin:owner' };
  const SIGNED = { ...MANIFEST, signature: 'sig-new' };

  beforeEach(() => {
    vi.mocked(isFairManifestV11).mockReturnValue(true);
  });

  afterEach(() => {
    vi.mocked(isFairManifestV11).mockReturnValue(false);
  });

  function writtenFairManifest() {
    const setCalls = mockSet.mock.calls as unknown as Array<[Record<string, unknown>]>;
    return setCalls.at(-1)?.[0]?.fairManifest;
  }

  it('re-signs the manifest, mirrors it to the .fair path on disk, and stores the signed manifest', async () => {
    setupAsset({ fairManifest: MANIFEST, fairPath: '/mnt/media/asset_test.fair' });
    vi.mocked(contentSigner.sign).mockResolvedValue(SIGNED as never);

    const result = await updateAssetContent({ assetId: 'asset_test', requesterDid: 'did:imajin:owner', content: '# Hello' });

    expect(result.ok).toBe(true);
    expect(contentSigner.sign).toHaveBeenCalledWith(MANIFEST);
    expect(writeFile).toHaveBeenCalledWith('/mnt/media/asset_test.fair', JSON.stringify(SIGNED, null, 2));
    expect(writtenFairManifest()).toEqual(SIGNED);
  });

  it('re-signs without writing a .fair file when the asset has no fairPath', async () => {
    setupAsset({ fairManifest: MANIFEST, fairPath: null });
    vi.mocked(contentSigner.sign).mockResolvedValue(SIGNED as never);

    await updateAssetContent({ assetId: 'asset_test', requesterDid: 'did:imajin:owner', content: '# Hello' });

    expect(vi.mocked(writeFile).mock.calls.some(([path]) => String(path).endsWith('.fair'))).toBe(false);
    expect(writtenFairManifest()).toEqual(SIGNED);
  });

  it('still stores the re-signed manifest when the .fair disk mirror fails (non-fatal)', async () => {
    setupAsset({ fairManifest: MANIFEST, fairPath: '/mnt/media/asset_test.fair' });
    vi.mocked(contentSigner.sign).mockResolvedValue(SIGNED as never);
    vi.mocked(writeFile).mockImplementation(async (path) => {
      if (String(path).endsWith('.fair')) throw new Error('disk full');
    });

    const result = await updateAssetContent({ assetId: 'asset_test', requesterDid: 'did:imajin:owner', content: '# Hello' });

    expect(result.ok).toBe(true);
    expect(writtenFairManifest()).toEqual(SIGNED);
    vi.mocked(writeFile).mockReset();
    vi.mocked(writeFile).mockResolvedValue(undefined);
  });

  it('keeps the previous manifest when signing throws (non-fatal)', async () => {
    setupAsset({ fairManifest: MANIFEST, fairPath: '/mnt/media/asset_test.fair' });
    vi.mocked(contentSigner.sign).mockRejectedValue(new Error('signer offline'));

    const result = await updateAssetContent({ assetId: 'asset_test', requesterDid: 'did:imajin:owner', content: '# Hello' });

    expect(result.ok).toBe(true);
    expect(writtenFairManifest()).toEqual(MANIFEST);
  });
});
