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

vi.mock('../article-core', () => ({
  deriveArticleProjection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/bus', () => ({
  publish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { publish } from '@imajin/bus';

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
