import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpContent, McpToolContext } from '../types';

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('../mcp-grant', () => ({ requireMcpGrant: vi.fn().mockResolvedValue(undefined) }));

const mockListOwnedAssets = vi.fn();
const mockGetActiveAsset = vi.fn();
vi.mock('@/src/lib/media/queries', () => ({
  listOwnedAssets: (...args: unknown[]) => mockListOwnedAssets(...args),
  getActiveAsset: (...args: unknown[]) => mockGetActiveAsset(...args),
  listVisibleAssetsOfDid: vi.fn(),
  listAssetsInFolder: vi.fn(),
  isTextReadable: vi.fn(() => false),
  readAssetTextContent: vi.fn(),
  assetAccess: vi.fn(() => 'private'),
}));

vi.mock('@/src/lib/media/authorize-read', () => ({
  authorizeAssetRead: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('@/src/lib/media/read-access', () => ({
  getAccessType: vi.fn(() => 'private'),
}));

vi.mock('@/src/lib/media/view-url', () => ({
  buildAssetViewUrl: vi.fn((base: string, id: string) => `${base}/media/api/assets/${id}`),
}));

import { mediaTools } from '../tools/media';

// ─── Helpers ───────────────────────────────────────────────────────────────

const ctx: McpToolContext = {
  did: 'did:imajin:user',
  appDid: 'did:imajin:app',
  scopes: new Set(['media:read']),
};

function tool(name: string) {
  const t = mediaTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

function parseResult(content: McpContent[]) {
  return JSON.parse(content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListOwnedAssets.mockResolvedValue([]);
});

// ─── media_list — sort order (#2185) ────────────────────────────────────────

describe('media_list', () => {
  it('defaults to newest-first (order: desc) when no order is given', async () => {
    await tool('media_list').handler({}, ctx);

    expect(mockListOwnedAssets).toHaveBeenCalledWith(
      ctx.did,
      expect.objectContaining({ order: 'desc' }),
    );
  });

  it('forwards an explicit order: asc', async () => {
    await tool('media_list').handler({ order: 'asc' }, ctx);

    expect(mockListOwnedAssets).toHaveBeenCalledWith(
      ctx.did,
      expect.objectContaining({ order: 'asc' }),
    );
  });

  it('treats any non-"asc" order value as desc (defensive default)', async () => {
    await tool('media_list').handler({ order: 'bogus' }, ctx);

    expect(mockListOwnedAssets).toHaveBeenCalledWith(
      ctx.did,
      expect.objectContaining({ order: 'desc' }),
    );
  });

  it('returns the count + assets shape', async () => {
    mockListOwnedAssets.mockResolvedValueOnce([
      { id: 'asset_1', filename: 'a.txt', mimeType: 'text/plain', size: 1, ownerDid: ctx.did, createdAt: new Date() },
    ]);
    const res = await tool('media_list').handler({}, ctx);
    const out = parseResult(res as McpContent[]);
    expect(out.count).toBe(1);
    expect(out.assets[0].id).toBe('asset_1');
  });
});

// ─── media_get — not-found path ─────────────────────────────────────────────

describe('media_get', () => {
  it('throws "Asset not found" when the asset does not exist', async () => {
    mockGetActiveAsset.mockResolvedValueOnce(undefined);
    await expect(tool('media_get').handler({ id: 'asset_missing' }, ctx)).rejects.toThrow('Asset not found');
  });

  it('throws "Asset not found" when id is omitted', async () => {
    await expect(tool('media_get').handler({}, ctx)).rejects.toThrow('Asset not found');
    expect(mockGetActiveAsset).not.toHaveBeenCalled();
  });

  it('returns the asset summary when found and authorized', async () => {
    mockGetActiveAsset.mockResolvedValueOnce({
      id: 'asset_1',
      filename: 'a.txt',
      mimeType: 'text/plain',
      size: 1,
      ownerDid: ctx.did,
      createdAt: new Date(),
    });
    const res = await tool('media_get').handler({ id: 'asset_1' }, ctx);
    const out = parseResult(res as McpContent[]);
    expect(out.id).toBe('asset_1');
  });
});
