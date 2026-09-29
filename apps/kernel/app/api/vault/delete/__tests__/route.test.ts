/**
 * Unit tests for POST /api/vault/delete (#2445 defect 5).
 *
 * A thin admin-gated wrapper over `deleteFromVault` — pins auth, validation,
 * the 404-on-nonexistent-field case, and that a bus-publish failure never
 * fails the delete itself (best-effort, matching set/rotate).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAdmin, mockDeleteFromVault, mockPublish, mockGetNodeSigningIdentity } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(async () => true),
  mockDeleteFromVault: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockGetNodeSigningIdentity: vi.fn(() => ({ senderDid: 'did:imajin:node' })),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: mockRequireAdmin }));
vi.mock('@imajin/bus', () => ({ publish: mockPublish }));
vi.mock('@/src/lib/vault', () => ({ deleteFromVault: mockDeleteFromVault }));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: mockGetNodeSigningIdentity }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_e: unknown, msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), { status }),
}));

import { POST } from '../route.js';

function makeRequest(body?: unknown): Request {
  return new Request('http://localhost/api/vault/delete', {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const TOMBSTONE = {
  field: 'internal-secret:kernel.foreign-principal-pepper',
  cid: 'cid:tombstone',
  timestamp: '2026-09-29T00:00:00.000Z',
  senderDid: 'did:imajin:node',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(true);
  mockDeleteFromVault.mockResolvedValue(TOMBSTONE);
  mockPublish.mockResolvedValue(undefined);
});

describe('POST /api/vault/delete', () => {
  it('returns 401 when not an admin', async () => {
    mockRequireAdmin.mockResolvedValue(false);
    const response = await POST(makeRequest({ field: 'GH_TOKEN' }) as never);
    expect(response.status).toBe(401);
    expect(mockDeleteFromVault).not.toHaveBeenCalled();
  });

  it('rejects a missing field', async () => {
    const response = await POST(makeRequest({}) as never);
    expect(response.status).toBe(400);
    expect(mockDeleteFromVault).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON', async () => {
    const response = await POST(new Request('http://localhost/api/vault/delete', { method: 'POST', body: '{' }) as never);
    expect(response.status).toBe(400);
  });

  it('returns 404 when the field does not exist', async () => {
    mockDeleteFromVault.mockResolvedValue(undefined);
    const response = await POST(makeRequest({ field: 'GITHUB-ORG-PROVISIONING' }) as never);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toContain('GITHUB-ORG-PROVISIONING');
  });

  it('tombstones the trimmed field and publishes vault.secret.deleted', async () => {
    const response = await POST(makeRequest({ field: '  GITHUB-ORG-PROVISIONING  ' }) as never);
    expect(response.status).toBe(200);
    expect(mockDeleteFromVault).toHaveBeenCalledWith('GITHUB-ORG-PROVISIONING');
    const body = await response.json();
    expect(body).toEqual({ ok: true, field: 'GITHUB-ORG-PROVISIONING', cid: TOMBSTONE.cid, timestamp: TOMBSTONE.timestamp });
    expect(mockPublish).toHaveBeenCalledWith(
      'vault.secret.deleted',
      expect.objectContaining({ payload: expect.objectContaining({ field: 'GITHUB-ORG-PROVISIONING', cid: TOMBSTONE.cid }) }),
    );
  });

  it('still succeeds when the bus publish fails (best-effort)', async () => {
    mockPublish.mockRejectedValue(new Error('bus down'));
    const response = await POST(makeRequest({ field: 'GH_TOKEN' }) as never);
    expect(response.status).toBe(200);
  });

  it('surfaces a deleteFromVault failure via toVaultErrorResponse', async () => {
    mockDeleteFromVault.mockRejectedValue(new Error('boom'));
    const response = await POST(makeRequest({ field: 'GH_TOKEN' }) as never);
    expect(response.status).toBe(400);
  });
});
