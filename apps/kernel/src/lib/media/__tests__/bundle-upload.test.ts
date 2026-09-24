import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// processBundleUpload orchestrates createAsset / updateAssetContent (both
// stubbed — their own behavior is covered by create-asset.test.ts and
// update-asset's own suite) plus the REAL article-guard + markdown-refs
// modules, so the guard/rewrite logic is exercised for real here.

const mockCreateAsset = vi.hoisted(() => vi.fn());
const mockUpdateAssetContent = vi.hoisted(() => vi.fn());
const mockInsertValues = vi.hoisted(() => vi.fn(() => ({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) })));
const mockInsert = vi.hoisted(() => vi.fn(() => ({ values: mockInsertValues })));

vi.mock('@/src/db', () => ({
  db: { insert: mockInsert },
  assets: {},
  assetDocEdges: {},
}));

vi.mock('nanoid', () => ({ nanoid: vi.fn(() => 'fixedid1234567890') }));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

vi.mock('@/src/lib/media/create-asset', () => ({
  createAsset: mockCreateAsset,
  isAllowedMime: () => true,
}));

vi.mock('@/src/lib/media/update-asset', () => ({
  updateAssetContent: mockUpdateAssetContent,
}));

import { processBundleUpload, type BundleFileInput } from '../bundle-upload';

// ─── Helpers ───────────────────────────────────────────────────────────────

const BASE_URL = 'https://node.example';

function assetFor(id: string, mimeType: string, buffer: Buffer) {
  return {
    id,
    hash: `hash_${id}`,
    size: buffer.byteLength,
    mimeType,
    filename: id,
    ownerDid: 'did:imajin:owner',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockImplementation(() => ({ values: mockInsertValues }));
  mockInsertValues.mockImplementation(() => ({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) }));

  mockCreateAsset.mockImplementation(async (input: { mimeType: string; buffer: Buffer }) => ({
    asset: assetFor(input.mimeType === 'text/markdown' ? 'asset_index' : 'asset_pic', input.mimeType, input.buffer),
    deduplicated: false,
  }));
});

const INDEX_FILE: BundleFileInput = {
  path: 'index.md',
  buffer: Buffer.from('# Title\n\n![diagram](./pic.png)\n', 'utf8'),
  mimeType: 'text/markdown',
};

const PIC_FILE: BundleFileInput = {
  path: 'pic.png',
  buffer: Buffer.from('PNGDATA'),
  mimeType: 'image/png',
};

describe('processBundleUpload — happy path', () => {
  it('materializes referenced files, rewrites the index refs, and records doc-asset edges', async () => {
    const result = await processBundleUpload({
      ownerDid: 'did:imajin:owner',
      uploadedBy: 'did:imajin:owner',
      files: [INDEX_FILE, PIC_FILE],
      indexPath: 'index.md',
      baseUrl: BASE_URL,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.assets).toEqual([
      { path: 'pic.png', id: 'asset_pic', url: `${BASE_URL}/media/api/assets/asset_pic`, hash: 'hash_asset_pic' },
    ]);
    expect(result.index).toEqual({ id: 'asset_index', url: `${BASE_URL}/media/api/assets/asset_index` });
    expect(result.rewritten).toEqual([{ from: './pic.png', to: `${BASE_URL}/media/api/assets/asset_pic` }]);
    expect(result.unresolved).toEqual([]);

    // The index was created from the REWRITTEN content, not the raw upload.
    const indexCall = mockCreateAsset.mock.calls.find((c) => c[0].mimeType === 'text/markdown');
    expect((indexCall![0].buffer as Buffer).toString('utf8')).toContain(`${BASE_URL}/media/api/assets/asset_pic`);

    // One doc->asset edge recorded for the referenced image.
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledWith({
      id: 'edge_fixedid1234567890',
      docAssetId: 'asset_index',
      assetId: 'asset_pic',
      relation: 'embeds',
    });
  });

  it('reports an unresolved local ref without failing the bundle', async () => {
    const orphanIndex: BundleFileInput = {
      ...INDEX_FILE,
      buffer: Buffer.from('![missing](./missing.png)\n', 'utf8'),
    };

    const result = await processBundleUpload({
      ownerDid: 'did:imajin:owner',
      uploadedBy: 'did:imajin:owner',
      files: [orphanIndex, PIC_FILE],
      indexPath: 'index.md',
      baseUrl: BASE_URL,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unresolved).toEqual(['./missing.png']);
    expect(result.rewritten).toEqual([]);
    // No edge recorded to the unresolved ref, but the uploaded pic is still
    // recorded even though nothing in the doc referenced it.
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 'asset_pic', docAssetId: 'asset_index' }),
    );
  });

  it('errors when the named index path is not among the uploaded files', async () => {
    const result = await processBundleUpload({
      ownerDid: 'did:imajin:owner',
      uploadedBy: 'did:imajin:owner',
      files: [PIC_FILE],
      indexPath: 'index.md',
      baseUrl: BASE_URL,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });
});

describe('processBundleUpload — article-frontmatter guard (#1542/#1870)', () => {
  const headerlessArticle: BundleFileInput = {
    path: 'index.md',
    buffer: Buffer.from('# Newsletter\n\nNo YAML header.\n', 'utf8'),
    mimeType: 'text/markdown',
  };

  it('warns (warn-only) when the index is article-context markdown with no frontmatter', async () => {
    const result = await processBundleUpload({
      ownerDid: 'did:imajin:owner',
      uploadedBy: 'did:imajin:owner',
      files: [headerlessArticle],
      indexPath: 'index.md',
      context: { app: 'article' },
      baseUrl: BASE_URL,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning?.reason).toBe('missing_frontmatter');
    expect(mockCreateAsset).toHaveBeenCalledTimes(1); // still created — warn-only
  });

  it('rejects under strict WITHOUT uploading anything (no orphan storage)', async () => {
    const result = await processBundleUpload({
      ownerDid: 'did:imajin:owner',
      uploadedBy: 'did:imajin:owner',
      files: [headerlessArticle, PIC_FILE],
      indexPath: 'index.md',
      context: { app: 'article' },
      strict: true,
      baseUrl: BASE_URL,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(mockCreateAsset).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('stays silent for a plain note (no article context)', async () => {
    const result = await processBundleUpload({
      ownerDid: 'did:imajin:owner',
      uploadedBy: 'did:imajin:owner',
      files: [headerlessArticle],
      indexPath: 'index.md',
      baseUrl: BASE_URL,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.articleWarning).toBeNull();
  });
});

describe('processBundleUpload — update semantics (indexAssetId)', () => {
  it('updates the existing index asset in place, preserving its id', async () => {
    mockUpdateAssetContent.mockResolvedValueOnce({
      ok: true,
      asset: assetFor('asset_existing_index', 'text/markdown', Buffer.from('x')),
      articleWarning: null,
    });

    const result = await processBundleUpload({
      ownerDid: 'did:imajin:owner',
      uploadedBy: 'did:imajin:owner',
      files: [INDEX_FILE, PIC_FILE],
      indexPath: 'index.md',
      indexAssetId: 'asset_existing_index',
      baseUrl: BASE_URL,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.id).toBe('asset_existing_index');
    expect(mockUpdateAssetContent).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 'asset_existing_index', requesterDid: 'did:imajin:owner' }),
    );
    // Index is NOT created fresh when updating in place.
    expect(mockCreateAsset).toHaveBeenCalledTimes(1); // only the referenced pic
  });

  it('propagates an update failure as a bundle error', async () => {
    mockUpdateAssetContent.mockResolvedValueOnce({
      ok: false,
      code: 'forbidden',
      message: 'Not the owner',
    });

    const result = await processBundleUpload({
      ownerDid: 'did:imajin:owner',
      uploadedBy: 'did:imajin:owner',
      files: [INDEX_FILE],
      indexPath: 'index.md',
      indexAssetId: 'asset_existing_index',
      baseUrl: BASE_URL,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('Not the owner');
  });
});
