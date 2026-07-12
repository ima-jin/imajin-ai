import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectLimitMock, updateWhereMock, readInvoicesMock, publishMock } = vi.hoisted(() => ({
  selectLimitMock: vi.fn(),
  updateWhereMock: vi.fn(),
  readInvoicesMock: vi.fn(),
  publishMock: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimitMock }) }) }),
    update: () => ({ set: () => ({ where: updateWhereMock }) }),
  },
  supplyLots: { correlationId: 'correlation_id', status: 'status', fairManifest: 'fair_manifest', buyerDid: 'buyer_did' },
}));
vi.mock('../connector', () => ({ readInvoices: readInvoicesMock }));
vi.mock('@imajin/bus', () => ({ publish: publishMock }));

import { buildSaleFairManifest, attachFairManifestToLot, settlePaidInvoices } from '../settlement';

const SCOTT = 'did:imajin:scott';

beforeEach(() => {
  selectLimitMock.mockReset();
  updateWhereMock.mockReset();
  updateWhereMock.mockResolvedValue(undefined);
  readInvoicesMock.mockReset();
  publishMock.mockReset();
  publishMock.mockResolvedValue(undefined);
});

describe('buildSaleFairManifest (#1210)', () => {
  it('builds a manifest with the supplier as the seller and shares summing to 1', () => {
    const manifest = buildSaleFairManifest(SCOTT, 'lot_eggs_1');
    expect(manifest.chain.find((entry) => entry.role === 'seller')?.did).toBe(SCOTT);
    expect(manifest.chain.reduce((sum, entry) => sum + entry.share, 0)).toBeCloseTo(1, 6);
  });
});

describe('attachFairManifestToLot (#1210)', () => {
  it('persists the manifest + buyerDid onto the lot', async () => {
    await attachFairManifestToLot('lot_eggs_1', buildSaleFairManifest(SCOTT, 'lot_eggs_1'), 'did:imajin:david');
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
  });
});

describe('settlePaidInvoices (#1210)', () => {
  const fairManifest = { version: '0.4.0', chain: [{ did: SCOTT, role: 'seller', share: 1 }] };

  function invoice(overrides: Record<string, unknown> = {}) {
    return {
      id: 'inv1', docNumber: '1', customerName: 'David', totalAmount: 42, balance: 0,
      currency: 'CAD', txnDate: '2026-07-10', correlationId: 'lot_eggs_1', ...overrides,
    };
  }

  it('publishes order.completed for a paid invoice and flips the lot to settled', async () => {
    readInvoicesMock.mockResolvedValue([invoice()]);
    selectLimitMock.mockResolvedValue([{ status: 'listed', fairManifest, buyerDid: 'did:imajin:david' }]);

    const result = await settlePaidInvoices(SCOTT);

    expect(result.settled).toEqual(['inv1']);
    expect(publishMock).toHaveBeenCalledTimes(1);
    const [type, event] = publishMock.mock.calls[0];
    expect(type).toBe('order.completed');
    expect(event.correlationId).toBe('lot_eggs_1');
    expect(event.payload.amount).toBe(4200);
    expect(event.payload.funded).toBe(true);
    expect(event.payload.funded_provider).toBe('quickbooks');
    expect(event.payload.buyerDid).toBe('did:imajin:david');
    expect(event.payload.fairManifest).toEqual(fairManifest);
    expect(updateWhereMock).toHaveBeenCalled();
  });

  it('skips an unpaid invoice (balance != 0) and never publishes', async () => {
    readInvoicesMock.mockResolvedValue([invoice({ balance: 42 })]);
    const result = await settlePaidInvoices(SCOTT);
    expect(result.settled).toEqual([]);
    expect(result.skipped).toEqual(['inv1']);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('is idempotent — skips a lot already settled', async () => {
    readInvoicesMock.mockResolvedValue([invoice()]);
    selectLimitMock.mockResolvedValue([{ status: 'settled', fairManifest, buyerDid: 'did:imajin:david' }]);
    const result = await settlePaidInvoices(SCOTT);
    expect(result.settled).toEqual([]);
    expect(publishMock).not.toHaveBeenCalled();
  });
});
