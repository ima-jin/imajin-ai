import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import type { FairManifestV11 } from '@imajin/fair';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// POST /media/api/assets/[id]/transfer (#1128): owner-gated ownership
// transfer that re-signs the .fair manifest (owner + chain `seller` role)
// while preserving `attribution`, and anchors a best-effort DFOS event.

const mockLimit = vi.fn();
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn((...args: unknown[]) => {
  void args;
  return { from: mockFrom };
});

const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockSet = vi.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));

vi.mock('@/src/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
  assets: {},
  identities: { id: 'id' },
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(),
  resolveActingDid: vi.fn((identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id
  ),
}));

vi.mock('@imajin/fair', () => ({
  canonicalize: vi.fn((v: unknown) => JSON.stringify(v)),
  isFairManifestV11: vi.fn((m: unknown) => !!m && (m as { version?: string }).version === '1.1'),
}));

const mockSignFairAsNode = vi.fn();
vi.mock('@/src/lib/kernel/sign-fair-manifest', () => ({
  signFairAsNode: (...args: unknown[]) => mockSignFairAsNode(...args),
}));

const mockWriteManifestToDisk = vi.fn().mockResolvedValue(undefined);
vi.mock('@/src/lib/media/manifest-helpers', () => ({
  writeManifestToDisk: (...args: unknown[]) => mockWriteManifestToDisk(...args),
}));

const mockPublishContentEvent = vi.fn();
vi.mock('@imajin/dfos', () => ({
  publishContentEvent: (...args: unknown[]) => mockPublishContentEvent(...args),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

import { POST } from '@/app/media/api/assets/[id]/transfer/route';
import { requireAuth } from '@imajin/auth';
import { mockIdentity } from './test-helpers';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:owner';
const NEW_OWNER_DID = 'did:imajin:newowner';
const CREATOR_DID = 'did:imajin:uploader';
const ASSET_ID = 'asset_test';

function baseManifest(): FairManifestV11 {
  return {
    fair: '1.1',
    version: '1.1',
    id: ASSET_ID,
    type: 'image/png',
    owner: OWNER_DID,
    created: '2026-01-01T00:00:00.000Z',
    access: { type: 'private' },
    attribution: [{ did: CREATOR_DID, role: 'creator', share: 1 }],
    chain: [
      { did: 'did:imajin:protocol', role: 'protocol', share: 0.02 },
      { did: 'NODE_PLACEHOLDER', role: 'node', share: 0.03 },
      { did: OWNER_DID, role: 'seller', share: 0.9 },
    ],
  };
}

function baseAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSET_ID,
    ownerDid: OWNER_DID,
    status: 'active',
    immutable: false,
    fairManifest: baseManifest(),
    fairPath: '/mnt/media/owner/assets/asset_test.fair.json',
    ...overrides,
  };
}

function setupDb(asset: unknown, identityRows: Array<{ id: string }> | undefined) {
  mockLimit.mockResolvedValueOnce(asset ? [asset] : []);
  if (identityRows !== undefined) {
    mockLimit.mockResolvedValueOnce(identityRows);
  }
}

function transferRequest(body: unknown): NextRequest {
  return new Request(`https://test.imajin.ai/media/api/assets/${ASSET_ID}/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: ASSET_ID });

function authAs(did: string) {
  vi.mocked(requireAuth).mockResolvedValueOnce({ identity: mockIdentity({ id: did }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateWhere.mockResolvedValue(undefined);
  mockSignFairAsNode.mockImplementation(async (manifest: FairManifestV11) => ({
    ok: true,
    signed: {
      ...manifest,
      signature: { signer: 'did:imajin:node', alg: 'ed25519', value: 'stub', signedAt: '2026-01-02T00:00:00.000Z' },
    },
  }));
  mockPublishContentEvent.mockResolvedValue({ eventId: 'evt_transfer', anchoredAt: '2026-01-02T00:00:00.000Z' });
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('POST /media/api/assets/[id]/transfer', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Authentication required', status: 401 });

    const res = await POST(transferRequest({ toDid: NEW_OWNER_DID }), { params });

    expect(res.status).toBe(401);
  });

  it('returns 400 when toDid is missing', async () => {
    authAs(OWNER_DID);

    const res = await POST(transferRequest({}), { params });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('toDid');
  });

  it('lets the owner transfer to a valid, distinct identity', async () => {
    authAs(OWNER_DID);
    setupDb(baseAsset(), [{ id: NEW_OWNER_DID }]);

    const res = await POST(transferRequest({ toDid: NEW_OWNER_DID }), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.previousOwner).toBe(OWNER_DID);
    expect(body.newOwner).toBe(NEW_OWNER_DID);

    // Manifest re-signed with owner + chain `seller` reassigned, attribution untouched.
    const signedArg = mockSignFairAsNode.mock.calls[0][0] as FairManifestV11;
    expect(signedArg.owner).toBe(NEW_OWNER_DID);
    expect(signedArg.chain?.find((e) => e.role === 'seller')?.did).toBe(NEW_OWNER_DID);
    expect(signedArg.chain?.find((e) => e.role === 'protocol')?.did).toBe('did:imajin:protocol');
    expect(signedArg.attribution).toEqual([{ did: CREATOR_DID, role: 'creator', share: 1 }]);

    // DB row persisted with new owner + signed manifest.
    expect(mockSet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ ownerDid: NEW_OWNER_DID, fairManifest: expect.objectContaining({ owner: NEW_OWNER_DID }) })
    );

    // DFOS event anchored with issuer/subject semantics.
    expect(mockPublishContentEvent).toHaveBeenCalledWith({
      topic: 'asset.ownership.transferred',
      payload: expect.objectContaining({
        assetId: ASSET_ID,
        previousOwner: OWNER_DID,
        newOwner: NEW_OWNER_DID,
        issuer: OWNER_DID,
        subject: NEW_OWNER_DID,
      }),
    });
  });

  it('returns 403 when the requester is not the owner', async () => {
    authAs('did:imajin:intruder');
    setupDb(baseAsset(), undefined);

    const res = await POST(transferRequest({ toDid: NEW_OWNER_DID }), { params });

    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 when the asset does not exist', async () => {
    authAs(OWNER_DID);
    setupDb(null, undefined);

    const res = await POST(transferRequest({ toDid: NEW_OWNER_DID }), { params });

    expect(res.status).toBe(404);
  });

  it('returns 403 for an immutable asset', async () => {
    authAs(OWNER_DID);
    setupDb(baseAsset({ immutable: true }), undefined);

    const res = await POST(transferRequest({ toDid: NEW_OWNER_DID }), { params });

    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 when toDid does not resolve to a known identity', async () => {
    authAs(OWNER_DID);
    setupDb(baseAsset(), []);

    const res = await POST(transferRequest({ toDid: 'did:imajin:ghost' }), { params });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('not found');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns 409 when toDid is already the current owner', async () => {
    authAs(OWNER_DID);
    setupDb(baseAsset(), [{ id: OWNER_DID }]);

    const res = await POST(transferRequest({ toDid: OWNER_DID }), { params });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('Already owner');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns 400 when the asset has no v1.1 .fair manifest', async () => {
    authAs(OWNER_DID);
    setupDb(baseAsset({ fairManifest: { fair: '1.0', version: undefined } }), [{ id: NEW_OWNER_DID }]);

    const res = await POST(transferRequest({ toDid: NEW_OWNER_DID }), { params });

    expect(res.status).toBe(400);
    expect(mockSignFairAsNode).not.toHaveBeenCalled();
  });

  it('does not move storagePath/fairPath — only writes the updated sidecar in place', async () => {
    authAs(OWNER_DID);
    const asset = baseAsset();
    setupDb(asset, [{ id: NEW_OWNER_DID }]);

    await POST(transferRequest({ toDid: NEW_OWNER_DID }), { params });

    expect(mockWriteManifestToDisk).toHaveBeenCalledWith(
      expect.objectContaining({ owner: NEW_OWNER_DID }),
      asset.fairPath
    );
  });
});
