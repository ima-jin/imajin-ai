import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockWriteFile = vi.fn();
const mockSignManifest = vi.fn();
const mockCanonicalize = vi.fn((v: unknown) => JSON.stringify(v));
const mockPublishContentEvent = vi.fn();
const mockHexToBytes = vi.fn((hex: string) => new Uint8Array(hex.length / 2));
const mockDbUpdate = vi.fn();
const mockDbWhere = vi.fn();
const mockSet = vi.fn();

vi.mock('fs/promises', () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

vi.mock('@imajin/fair', () => ({
  signManifest: (...args: unknown[]) => mockSignManifest(...args),
  canonicalize: (v: unknown) => mockCanonicalize(v),
  isFairManifestV1_1: vi.fn(),
}));

vi.mock('@imajin/dfos', () => ({
  publishContentEvent: (...args: unknown[]) => mockPublishContentEvent(...args),
}));

vi.mock('@imajin/auth', () => ({
  hexToBytes: (hex: string) => mockHexToBytes(hex),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  })),
}));

vi.mock('@/src/db', () => ({
  db: {
    update: vi.fn(() => ({ set: mockSet })),
  },
  assets: {},
}));

import {
  getPlatformSigner,
  signManifestWithPlatformKey,
  writeManifestToDisk,
  publishManifestDfosEvent,
  updateManifestFlow,
} from '../manifest-helpers';

// ─── Helpers ───────────────────────────────────────────────────────────────

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLATFORM_DID = 'did:imajin:platform';
  process.env.AUTH_PRIVATE_KEY = 'aabbccdd00112233';
});

afterEach(() => {
  Object.assign(process.env, originalEnv);
});

function makeManifest(): import('@imajin/fair').FairManifestV1_1 {
  return {
    fair: '1.1',
    version: '1.1',
    id: 'asset_test123',
    type: 'text/markdown',
    owner: 'did:imajin:owner',
    created: '2026-05-12T10:00:00.000Z',
    access: { type: 'private' },
    attribution: [{ did: 'did:imajin:owner', role: 'creator', share: 1 }],
  };
}

// ─── getPlatformSigner ─────────────────────────────────────────────────────

describe('getPlatformSigner', () => {
  it('returns signer when env vars are set', () => {
    const signer = getPlatformSigner();
    expect(signer).not.toBeNull();
    expect(signer?.did).toBe('did:imajin:platform');
    expect(mockHexToBytes).toHaveBeenCalledWith('aabbccdd00112233');
  });

  it('returns null when PLATFORM_DID is missing', () => {
    delete process.env.PLATFORM_DID;
    expect(getPlatformSigner()).toBeNull();
  });

  it('returns null when AUTH_PRIVATE_KEY is missing', () => {
    delete process.env.AUTH_PRIVATE_KEY;
    expect(getPlatformSigner()).toBeNull();
  });
});

// ─── signManifestWithPlatformKey ───────────────────────────────────────────

describe('signManifestWithPlatformKey', () => {
  it('signs manifest when signer is available', async () => {
    const manifest = makeManifest();
    const signed = { ...manifest, signature: { signer: 'did:imajin:platform', alg: 'ed25519' as const, value: 'sig', signedAt: 'now' } };
    mockSignManifest.mockResolvedValueOnce(signed);

    const result = await signManifestWithPlatformKey(manifest);
    expect(mockSignManifest).toHaveBeenCalledWith(manifest, expect.objectContaining({ did: 'did:imajin:platform' }));
    expect(result).toBe(signed);
  });

  it('returns unsigned manifest when signer is missing', async () => {
    delete process.env.PLATFORM_DID;
    const manifest = makeManifest();
    const result = await signManifestWithPlatformKey(manifest);
    expect(mockSignManifest).not.toHaveBeenCalled();
    expect(result).toEqual(manifest);
  });

  it('falls back to unsigned manifest on signing error', async () => {
    const manifest = makeManifest();
    mockSignManifest.mockRejectedValueOnce(new Error('bad key'));

    const result = await signManifestWithPlatformKey(manifest);
    expect(result).toEqual(manifest);
  });
});

// ─── writeManifestToDisk ───────────────────────────────────────────────────

describe('writeManifestToDisk', () => {
  it('writes JSON to the given path', async () => {
    const manifest = makeManifest();
    await writeManifestToDisk(manifest, '/opt/imajin/test.fair.json');
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/opt/imajin/test.fair.json',
      JSON.stringify(manifest, null, 2)
    );
  });
});

// ─── publishManifestDfosEvent ──────────────────────────────────────────────

describe('publishManifestDfosEvent', () => {
  beforeEach(() => {
    process.env.DFOS_RELAY_URL = 'https://relay.test.dfos';
    process.env.DFOS_PRIVATE_KEY_HEX = '00112233aabbccdd';
  });

  it('publishes event and returns eventId', async () => {
    mockPublishContentEvent.mockResolvedValueOnce({
      eventId: 'evt_123',
      anchoredAt: '2026-05-12T10:00:00.000Z',
    });
    mockCanonicalize.mockReturnValue('canonical');

    const manifest = makeManifest();
    const eventId = await publishManifestDfosEvent('asset_test', 'did:owner', manifest, 'https://media.imajin.ai');

    expect(eventId).toBe('evt_123');
    expect(mockPublishContentEvent).toHaveBeenCalledWith({
      topic: 'fair.manifest.published',
      payload: expect.objectContaining({
        assetId: 'asset_test',
        ownerDid: 'did:owner',
        manifestDigest: expect.stringMatching(/^sha256:/),
        manifestUrl: 'https://media.imajin.ai/media/api/assets/asset_test/fair',
        fairVersion: '1.1',
        signedAt: expect.any(String),
      }),
    });
  });

  it('returns null on publish error', async () => {
    mockPublishContentEvent.mockRejectedValueOnce(new Error('relay down'));

    const manifest = makeManifest();
    const eventId = await publishManifestDfosEvent('asset_test', 'did:owner', manifest, 'https://media.imajin.ai');
    expect(eventId).toBeNull();
  });
});

// ─── updateManifestFlow ────────────────────────────────────────────────────

describe('updateManifestFlow', () => {
  beforeEach(() => {
    process.env.DFOS_RELAY_URL = 'https://relay.test.dfos';
    process.env.DFOS_PRIVATE_KEY_HEX = '00112233aabbccdd';

    mockSet.mockReturnValue({ where: mockDbWhere });
    mockDbWhere.mockResolvedValue(undefined);
  });

  it('runs full sign → write → publish → update flow', async () => {
    const manifest = makeManifest();
    const signed = { ...manifest, signature: { signer: 'did:imajin:platform', alg: 'ed25519' as const, value: 'sig', signedAt: 'now' } };
    mockSignManifest.mockResolvedValueOnce(signed);
    mockPublishContentEvent.mockResolvedValueOnce({
      eventId: 'evt_flow',
      anchoredAt: '2026-05-12T10:00:00.000Z',
    });

    const result = await updateManifestFlow(
      {
        id: 'asset_test',
        ownerDid: 'did:owner',
        fairPath: '/srv/imajin/media/test.fair.json',
        fairDfosEventId: null,
      },
      manifest,
      'https://media.imajin.ai'
    );

    expect(result.signedManifest).toBe(signed);
    expect(result.dfosEventId).toBe('evt_flow');
    expect(mockWriteFile).toHaveBeenCalledWith('/srv/imajin/media/test.fair.json', JSON.stringify(signed, null, 2));
  });

  it('skips disk write when fairPath is null', async () => {
    const manifest = makeManifest();
    mockSignManifest.mockResolvedValueOnce(manifest);
    mockPublishContentEvent.mockResolvedValueOnce({
      eventId: 'evt_nopath',
      anchoredAt: '2026-05-12T10:00:00.000Z',
    });

    await updateManifestFlow(
      {
        id: 'asset_test',
        ownerDid: 'did:owner',
        fairPath: null,
        fairDfosEventId: null,
      },
      manifest,
      'https://media.imajin.ai'
    );

    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
