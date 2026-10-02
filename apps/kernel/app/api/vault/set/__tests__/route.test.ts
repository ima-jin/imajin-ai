/**
 * POST /api/vault/set — the #2449 guards Rotate/Delete have, applied to Set (#2452).
 *
 *  - set on an EXISTING field with other active grantees re-seals it under a
 *    new key and strands them → 409 unless confirmField === field
 *  - set on internal-secret:* (the kernel's own secrets) → 409, always
 *
 * The real grantees helper runs; only the DB query it issues is mocked, via
 * mockOtherGranteeRows (same pattern as the rotate route tests).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRequireAdmin,
  mockVaultServiceGet,
  mockSealAndStore,
  mockSealAndStoreV2,
  mockPublish,
  mockOtherGranteeRows,
} = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(async () => true),
  mockVaultServiceGet: vi.fn(),
  mockSealAndStore: vi.fn(),
  mockSealAndStoreV2: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockOtherGranteeRows: vi.fn((): unknown[] => []),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: mockRequireAdmin }));
vi.mock('@imajin/bus', () => ({ publish: mockPublish }));
vi.mock('@/src/lib/vault', () => ({
  sealAndStore: mockSealAndStore,
  sealAndStoreV2: mockSealAndStoreV2,
  vaultService: { get: mockVaultServiceGet },
}));
vi.mock('@/src/lib/vault/subscribe', () => ({ ensureVaultHotReloadReactorRegistered: vi.fn() }));
vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({ senderDid: 'did:imajin:node' }),
}));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => Promise.resolve(mockOtherGranteeRows()) }) }) },
  vaultDelegationGrants: {
    id: 'id',
    grantedTo: 'granted_to',
    purpose: 'purpose',
    oneTime: 'one_time',
    expiresAt: 'expires_at',
    field: 'field',
    status: 'status',
    consumedAt: 'consumed_at',
  },
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));

import { POST } from '../route.js';

function makeRequest(body?: unknown): Request {
  return new Request('http://localhost/api/vault/set', {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const GRANTEE = { grantId: 'vdg_1', grantedTo: 'did:imajin:corpus', purpose: 'corpus-sync', oneTime: false, expiresAt: null };
const ENTRY = { field: 'GH_TOKEN', cid: 'cid:new', timestamp: '2026-01-01T00:00:00.000Z', senderDid: 'did:imajin:node' };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(true);
  mockVaultServiceGet.mockResolvedValue(null);
  mockSealAndStore.mockResolvedValue(ENTRY);
  mockSealAndStoreV2.mockResolvedValue({ entry: ENTRY, grantId: 'vdg_new' });
  mockPublish.mockResolvedValue(undefined);
  mockOtherGranteeRows.mockReturnValue([]);
});

describe('POST /api/vault/set', () => {
  it('returns 401 when not an admin', async () => {
    mockRequireAdmin.mockResolvedValue(false);
    const response = await POST(makeRequest({ field: 'GH_TOKEN', value: 'v' }) as never);
    expect(response.status).toBe(401);
  });

  it('seals a brand-new field without consulting grantees', async () => {
    const response = await POST(makeRequest({ field: 'GH_TOKEN', value: 'v' }) as never);
    expect(response.status).toBe(200);
    expect(mockSealAndStore).toHaveBeenCalledWith('GH_TOKEN', 'v');
    expect(mockOtherGranteeRows).not.toHaveBeenCalled();
  });

  it('re-seals an existing field that has no other grantees', async () => {
    mockVaultServiceGet.mockResolvedValue({ field: 'GH_TOKEN', cid: 'cid:old' });
    const response = await POST(makeRequest({ field: 'GH_TOKEN', value: 'v' }) as never);
    expect(response.status).toBe(200);
    expect(mockSealAndStore).toHaveBeenCalledWith('GH_TOKEN', 'v');
  });
});

describe('set on an existing field with active grantees (#2452)', () => {
  beforeEach(() => {
    mockVaultServiceGet.mockResolvedValue({ field: 'GH_TOKEN', cid: 'cid:old' });
    mockOtherGranteeRows.mockReturnValue([GRANTEE]);
  });

  it('409s without confirmField, naming the grantees, and seals nothing', async () => {
    const response = await POST(makeRequest({ field: 'GH_TOKEN', value: 'v' }) as never);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { count: number; grantees: unknown[]; error: string };
    expect(body.count).toBe(1);
    expect(body.grantees).toEqual([GRANTEE]);
    expect(body.error).toMatch(/Rotate/);
    expect(mockSealAndStore).not.toHaveBeenCalled();
    expect(mockSealAndStoreV2).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('409s when confirmField does not equal the field exactly', async () => {
    const response = await POST(makeRequest({ field: 'GH_TOKEN', value: 'v', confirmField: 'gh_token' }) as never);
    expect(response.status).toBe(409);
    expect(mockSealAndStore).not.toHaveBeenCalled();
  });

  it('409s on the delegation-grant custody path too', async () => {
    const response = await POST(
      makeRequest({ field: 'GH_TOKEN', value: 'v', custodyScheme: 'delegation-grant' }) as never,
    );
    expect(response.status).toBe(409);
    expect(mockSealAndStoreV2).not.toHaveBeenCalled();
  });

  it('proceeds when confirmField equals the field', async () => {
    const response = await POST(makeRequest({ field: 'GH_TOKEN', value: 'v', confirmField: 'GH_TOKEN' }) as never);
    expect(response.status).toBe(200);
    expect(mockSealAndStore).toHaveBeenCalledWith('GH_TOKEN', 'v');
  });

  it('guards on the trimmed field name', async () => {
    const response = await POST(makeRequest({ field: '  GH_TOKEN ', value: 'v' }) as never);
    expect(response.status).toBe(409);
    expect(mockVaultServiceGet).toHaveBeenCalledWith('GH_TOKEN');
  });
});

describe('set on internal-secret:* (#2452)', () => {
  it.each([
    ['a field that does not exist', null],
    ['an existing field', { field: 'internal-secret:x', cid: 'cid:old' }],
  ])('409s for %s, even with confirmField, and never reaches the vault', async (_label, existing) => {
    mockVaultServiceGet.mockResolvedValue(existing);
    const response = await POST(
      makeRequest({ field: 'internal-secret:x', value: 'v', confirmField: 'internal-secret:x' }) as never,
    );
    expect(response.status).toBe(409);
    expect(mockVaultServiceGet).not.toHaveBeenCalled();
    expect(mockSealAndStore).not.toHaveBeenCalled();
    expect(mockSealAndStoreV2).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('409s on the delegation-grant custody path', async () => {
    const response = await POST(
      makeRequest({ field: 'internal-secret:kernel.attestation-internal-api-key', value: 'v', custodyScheme: 'delegation-grant' }) as never,
    );
    expect(response.status).toBe(409);
    expect(mockSealAndStoreV2).not.toHaveBeenCalled();
  });

  it('409s with surrounding whitespace in the field', async () => {
    const response = await POST(makeRequest({ field: ' internal-secret:x ', value: 'v' }) as never);
    expect(response.status).toBe(409);
    expect(mockSealAndStore).not.toHaveBeenCalled();
  });
});
