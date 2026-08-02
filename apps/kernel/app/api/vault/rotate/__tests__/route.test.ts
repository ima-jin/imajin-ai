/**
 * Unit tests for POST /api/vault/rotate (#1546).
 *
 * The route itself is a thin admin-gated wrapper over rotateAndStore — these
 * tests pin the route-level contract: auth, validation, and that the
 * response surfaces whichever custodyScheme rotateAndStore actually wrote,
 * so an operator curling this route can see a v2 field stayed v2 rather than
 * silently downgrading.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAdmin, mockVaultServiceGet, mockRotateAndStore, mockPublish } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(async () => true),
  mockVaultServiceGet: vi.fn(),
  mockRotateAndStore: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: mockRequireAdmin }));

vi.mock('@imajin/bus', () => ({ publish: mockPublish }));

vi.mock('@/src/lib/vault', () => ({
  rotateAndStore: mockRotateAndStore,
  vaultService: { get: mockVaultServiceGet },
}));

vi.mock('@/src/lib/vault/subscribe', () => ({
  ensureVaultHotReloadReactorRegistered: vi.fn(),
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
  return new Request('http://localhost/api/vault/rotate', {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const EXISTING = { field: 'GH_TOKEN', cid: 'cid:old' };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(true);
  mockVaultServiceGet.mockResolvedValue(EXISTING);
  mockPublish.mockResolvedValue(undefined);
});

describe('POST /api/vault/rotate', () => {
  it('returns 401 when not an admin', async () => {
    mockRequireAdmin.mockResolvedValue(false);
    const response = await POST(makeRequest({ field: 'GH_TOKEN', value: 'x' }) as never);
    expect(response.status).toBe(401);
    expect(mockRotateAndStore).not.toHaveBeenCalled();
  });

  it('returns 404 when the field does not exist', async () => {
    mockVaultServiceGet.mockResolvedValue(undefined);
    const response = await POST(makeRequest({ field: 'GH_TOKEN', value: 'x' }) as never);
    expect(response.status).toBe(404);
  });

  it('surfaces custodyScheme "delegation-grant" when the rotated entry stayed v2', async () => {
    mockRotateAndStore.mockResolvedValue({
      field: 'GH_TOKEN',
      cid: 'cid:new',
      timestamp: '2026-01-01T00:00:00.000Z',
      senderDid: 'did:imajin:node',
      custodyScheme: 'delegation-grant',
    });

    const response = await POST(makeRequest({ field: 'GH_TOKEN', value: 'new-value' }) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.custodyScheme).toBe('delegation-grant');
  });

  it('surfaces custodyScheme "node-sealed" when the rotated entry is v1 (no custodyScheme on the entry)', async () => {
    mockRotateAndStore.mockResolvedValue({
      field: 'GH_TOKEN',
      cid: 'cid:new',
      timestamp: '2026-01-01T00:00:00.000Z',
      senderDid: 'did:imajin:node',
      // no custodyScheme property — matches a real v1 VaultEntry
    });

    const response = await POST(makeRequest({ field: 'GH_TOKEN', value: 'new-value' }) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.custodyScheme).toBe('node-sealed');
  });

  it('rejects a missing field or value', async () => {
    expect((await POST(makeRequest({ value: 'x' }) as never)).status).toBe(400);
    expect((await POST(makeRequest({ field: 'GH_TOKEN' }) as never)).status).toBe(400);
    expect(mockRotateAndStore).not.toHaveBeenCalled();
  });

  it('surfaces a rotateAndStore failure as a 400', async () => {
    mockRotateAndStore.mockRejectedValue(new Error('boom'));
    const response = await POST(makeRequest({ field: 'GH_TOKEN', value: 'x' }) as never);
    expect(response.status).toBe(400);
  });
});
