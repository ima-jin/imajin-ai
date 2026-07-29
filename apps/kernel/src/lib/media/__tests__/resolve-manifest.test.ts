import { describe, it, expect, vi } from 'vitest';
import type { FairManifest } from '@imajin/fair';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('node:crypto', () => ({
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => 'abc123'),
  })),
}));

vi.mock('@imajin/fair', () => ({
  canonicalize: vi.fn((m: unknown) => JSON.stringify(m)),
}));

import { beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolveManifest, buildFairHeaders } from '../resolve-manifest';

beforeEach(() => { vi.clearAllMocks(); });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_MANIFEST: FairManifest = {
  fair: '1.1',
  type: 'image/png',
  owner: 'did:imajin:owner',
  created: '2026-01-01T00:00:00Z',
  access: 'public',
  attribution: [],
} as unknown as FairManifest;

function makeAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asset_1',
    fairManifest: null,
    fairPath: null,
    fairDfosEventId: null,
    ...overrides,
  } as Parameters<typeof resolveManifest>[0];
}

// ---------------------------------------------------------------------------
// resolveManifest
// ---------------------------------------------------------------------------

describe('resolveManifest', () => {
  it('returns the DB manifest when fairManifest is a non-empty object', async () => {
    const asset = makeAsset({ fairManifest: BASE_MANIFEST });
    const result = await resolveManifest(asset);
    expect(result).toBe(BASE_MANIFEST);
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
  });

  it('falls back to disk when fairManifest is null', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(BASE_MANIFEST) as never);
    const asset = makeAsset({ fairManifest: null, fairPath: '/path/to/asset.fair.json' });
    const result = await resolveManifest(asset);
    expect(result).toEqual(BASE_MANIFEST);
  });

  it('falls back to disk when fairManifest is an empty object', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(BASE_MANIFEST) as never);
    const asset = makeAsset({ fairManifest: {}, fairPath: '/path/to/asset.fair.json' });
    const result = await resolveManifest(asset);
    expect(result).toEqual(BASE_MANIFEST);
  });

  it('returns null when disk read fails', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT') as never);
    const asset = makeAsset({ fairPath: '/missing.fair.json' });
    const result = await resolveManifest(asset);
    expect(result).toBeNull();
  });

  it('returns null when no manifest is available anywhere', async () => {
    const asset = makeAsset();
    const result = await resolveManifest(asset);
    expect(result).toBeNull();
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
  });

  it('skips disk read when fairPath is null', async () => {
    const asset = makeAsset({ fairManifest: null, fairPath: null });
    const result = await resolveManifest(asset);
    expect(result).toBeNull();
    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildFairHeaders
// ---------------------------------------------------------------------------

describe('buildFairHeaders', () => {
  it('always includes a Link rel=fair header', () => {
    const headers = buildFairHeaders('asset_1', null, null);
    expect(headers['Link']).toContain('/media/api/assets/asset_1/fair');
    expect(headers['Link']).toContain('rel="fair"');
  });

  it('includes X-Fair-Digest when manifest is provided', () => {
    const headers = buildFairHeaders('asset_1', BASE_MANIFEST, null);
    expect(headers['X-Fair-Digest']).toMatch(/^sha256:/);
  });

  it('omits X-Fair-Digest when manifest is null', () => {
    const headers = buildFairHeaders('asset_1', null, null);
    expect(headers['X-Fair-Digest']).toBeUndefined();
  });

  it('includes X-Fair-Dfos when dfosEventId is provided', () => {
    const headers = buildFairHeaders('asset_1', null, 'evt_abc');
    expect(headers['X-Fair-Dfos']).toBe('dfos:event:evt_abc');
  });

  it('omits X-Fair-Dfos when dfosEventId is null', () => {
    const headers = buildFairHeaders('asset_1', null, null);
    expect(headers['X-Fair-Dfos']).toBeUndefined();
  });
});
