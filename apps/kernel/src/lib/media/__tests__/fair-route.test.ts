import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { buildFairManifest } from '@imajin/fair';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// PUT /media/api/assets/[id]/fair (#1937 / A08): the node must sign only
// manifests whose protocol/platform/node fee split matches what the node
// itself derives for the asset. `@imajin/fair` is NOT mocked here — the real
// `buildFairManifest`, `validateManifest`, and `isFairManifestV1_1` are
// exercised so the guard's actual behavior is covered, not a stand-in.

const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockSet = vi.fn();
const mockDbWhere = vi.fn();

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: mockFrom })),
    update: vi.fn(() => ({ set: mockSet })),
  },
  assets: {},
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(),
  resolveActingDid: vi.fn((identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id
  ),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('@/src/lib/kernel/sign-fair-manifest', () => ({
  signFairAsNode: vi.fn(async (manifest: Record<string, unknown>) => ({
    ok: true,
    signed: { ...manifest, signature: { signer: 'did:imajin:node', alg: 'ed25519', value: 'stub', signedAt: '2026-01-01T00:00:00.000Z' } },
  })),
}));

import { PUT } from '@/app/media/api/assets/[id]/fair/route';
import { requireAuth } from '@imajin/auth';
import { signFairAsNode } from '@/src/lib/kernel/sign-fair-manifest';
import { mockIdentity } from './test-helpers';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:owner';
const INTRUDER_DID = 'did:imajin:intruder';
const ASSET_ID = 'asset_test';
const MIME_TYPE = 'image/png';

function canonicalFeeFields() {
  const built = buildFairManifest({
    creatorDid: OWNER_DID,
    contentDid: ASSET_ID,
    contentType: MIME_TYPE,
  });
  return { chain: built.chain, fees: built.fees, distributions: built.distributions };
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { chain, fees } = canonicalFeeFields();
  return {
    fair: '1.1',
    version: '1.1',
    id: ASSET_ID,
    type: MIME_TYPE,
    owner: OWNER_DID,
    created: '2026-01-01T00:00:00.000Z',
    access: { type: 'private' },
    attribution: [{ did: OWNER_DID, role: 'creator', share: 1 }],
    chain,
    fees,
    ...overrides,
  };
}

function setupAsset(overrides: Record<string, unknown> = {}) {
  const asset = {
    id: ASSET_ID,
    ownerDid: OWNER_DID,
    status: 'active',
    mimeType: MIME_TYPE,
    immutable: false,
    fairManifest: { fair: '1.1', version: '1.1' },
    fairPath: null,
    ...overrides,
  };

  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ limit: mockLimit });
  mockLimit.mockResolvedValue([asset]);

  mockSet.mockReturnValue({ where: mockDbWhere });
  mockDbWhere.mockResolvedValue(undefined);

  return asset;
}

const params = Promise.resolve({ id: ASSET_ID });

function putRequest(body: unknown): NextRequest {
  return new Request(`https://test.imajin.ai/media/api/assets/${ASSET_ID}/fair`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function authAsOwner() {
  vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity({ id: OWNER_DID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('PUT /media/api/assets/[id]/fair — fee-split guard (#1937 / A08)', () => {
  it('returns 403 when the requester does not own the asset', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity({ id: INTRUDER_DID }) });
    setupAsset();

    const res = await PUT(putRequest(validManifest()), { params });

    expect(res.status).toBe(403);
    expect(signFairAsNode).not.toHaveBeenCalled();
  });

  it('returns 400 for a manifest with bad shape (missing required fields)', async () => {
    authAsOwner();
    setupAsset();

    const { chain, fees } = canonicalFeeFields();
    const res = await PUT(
      putRequest({ fair: '1.1', version: '1.1', chain, fees }),
      { params },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid .fair manifest');
    expect(signFairAsNode).not.toHaveBeenCalled();
  });

  it('signs the manifest when the owner only edits attribution', async () => {
    authAsOwner();
    setupAsset();

    const manifest = validManifest({
      attribution: [
        { did: OWNER_DID, role: 'creator', share: 0.6 },
        { did: 'did:imajin:collaborator', role: 'collaborator', share: 0.4 },
      ],
    });

    const res = await PUT(putRequest(manifest), { params });

    expect(res.status).toBe(200);
    expect(signFairAsNode).toHaveBeenCalledTimes(1);
    const signedArg = vi.mocked(signFairAsNode).mock.calls[0][0];
    expect(signedArg.attribution).toEqual(manifest.attribution);
    expect(signedArg.chain).toEqual(manifest.chain);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.manifest.signature).toBeDefined();
  });

  it('rejects a zeroed-out protocol fee entry', async () => {
    authAsOwner();
    setupAsset();

    const manifest = validManifest();
    const chain = manifest.chain as Array<{ role: string; share: number }>;
    chain[0]!.share = 0; // protocol entry is index 0

    const res = await PUT(putRequest(manifest), { params });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe('chain[0].share');
    expect(signFairAsNode).not.toHaveBeenCalled();
  });

  it('rejects a rerouted platform DID', async () => {
    authAsOwner();
    setupAsset();

    const manifest = validManifest();
    const chain = manifest.chain as Array<{ role: string; did?: string }>;
    const platformEntry = chain.find((e) => e.role === 'platform')!;
    platformEntry.did = 'did:imajin:attacker';

    const res = await PUT(putRequest(manifest), { params });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toContain('.did');
    expect(body.error).toContain('platform');
    expect(signFairAsNode).not.toHaveBeenCalled();
  });

  it('rejects tampered distributions', async () => {
    authAsOwner();
    setupAsset();

    const manifest = validManifest({
      distributions: [{ did: 'did:imajin:attacker', role: 'creator', share: 1 }],
    });

    const res = await PUT(putRequest(manifest), { params });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe('distributions[0].did');
    expect(signFairAsNode).not.toHaveBeenCalled();
  });
});
