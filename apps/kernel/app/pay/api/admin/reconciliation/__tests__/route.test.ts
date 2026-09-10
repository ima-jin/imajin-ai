/**
 * Tests for GET /pay/api/admin/reconciliation (#2016 decision 4).
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
      ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.circulatingMjnx).toBe('42.5');
    expect(body.backedMjn).toBe('1000');
    expect(body.perDid).toHaveLength(1);
    expect(body.perDid[0]).toMatchObject({ did: 'did:imajin:x' });
  });
});
