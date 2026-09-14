/**
 * Tests for GET /pay/api/admin/reconciliation (#2016 decision 4, #2172).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  sqlMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: mocks.requireAdminMock }));
vi.mock('@imajin/db', () => ({ getClient: () => mocks.sqlMock }));

import { GET } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /pay/api/admin/reconciliation', () => {
  it('returns 401 when the caller is not an admin', async () => {
    mocks.requireAdminMock.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(mocks.sqlMock).not.toHaveBeenCalled();
  });

  it('returns circulating MJNx, backed MJN, and per-DID rows for an admin', async () => {
    mocks.requireAdminMock.mockResolvedValue({ actingAs: 'did:imajin:node' });
    mocks.sqlMock
      .mockResolvedValueOnce([{ circulating_mjnx: '42.5' }])
      .mockResolvedValueOnce([{ backed_mjn: '1000' }])
      .mockResolvedValueOnce([
        { did: 'did:imajin:x', currency: 'CAD', mjn_amount: '10', mjnx_amount: '5', lifetime_emitted: '5', lifetime_receipted: '10' },
      ])
      .mockResolvedValueOnce([]);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.circulatingMjnx).toBe('42.5');
    expect(body.backedMjn).toBe('1000');
    expect(body.perDid).toHaveLength(1);
    expect(body.perDid[0]).toMatchObject({ did: 'did:imajin:x' });
    expect(body.discrepancies).toEqual([]);
  });

  it('groups withdrawal reconciliation discrepancies by rail (#2172)', async () => {
    mocks.requireAdminMock.mockResolvedValue({ actingAs: 'did:imajin:node' });
    mocks.sqlMock
      .mockResolvedValueOnce([{ circulating_mjnx: '0' }])
      .mockResolvedValueOnce([{ backed_mjn: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { rail: 'stripe', bucket: 'external_without_ledger', external_ref: 'tr_1', intent_id: null, amount: '5', unit: 'MJN', issued_at: '2026-01-01T00:00:00Z' },
        { rail: 'stripe', bucket: 'pending_timeout', external_ref: null, intent_id: 'wdi_1', amount: '3', unit: 'MJN', issued_at: '2026-01-02T00:00:00Z' },
        { rail: 'emt', bucket: 'pending_timeout', external_ref: null, intent_id: 'wdi_2', amount: '7', unit: 'MJN', issued_at: '2026-01-03T00:00:00Z' },
      ]);

    const res = await GET();
    const body = await res.json();

    expect(body.discrepancies).toHaveLength(2);
    const stripeGroup = body.discrepancies.find((g: { rail: string }) => g.rail === 'stripe');
    const emtGroup = body.discrepancies.find((g: { rail: string }) => g.rail === 'emt');
    expect(stripeGroup.items).toHaveLength(2);
    expect(emtGroup.items).toHaveLength(1);
    expect(stripeGroup.items[0]).toMatchObject({ bucket: 'external_without_ledger', externalRef: 'tr_1' });
  });
});
