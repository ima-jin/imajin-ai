import { describe, it, expect, vi } from 'vitest';

// Fake tagged-template client that returns canned rows per target table, so we
// can exercise getLotChain and recentLotsBySupplier without a live DB.
const { setRows, setSupplierRows, fakeSql } = vi.hoisted(() => {
  let lotRows: unknown[] = [];
  let stageRows: unknown[] = [];
  let supplierRows: unknown[] = [];
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ');
    if (text.includes('kernel.supply_stages')) return Promise.resolve(stageRows);
    // recentLotsBySupplier query includes ORDER BY created_at DESC — distinguish
    // it from the getLotChain lot query (which is WHERE correlation_id = ...).
    if (text.includes('ORDER BY created_at DESC')) return Promise.resolve(supplierRows);
    if (text.includes('kernel.supply_lots')) return Promise.resolve(lotRows);
    return Promise.resolve([]);
  };
  const setRows = (lot: unknown[], stages: unknown[]) => {
    lotRows = lot;
    stageRows = stages;
  };
  const setSupplierRows = (rows: unknown[]) => { supplierRows = rows; };
  return { setRows, setSupplierRows, fakeSql };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import { getLotChain, recentLotsBySupplier } from '../src/supply-lots';

describe('getLotChain (#1136)', () => {
  it('returns the lot and its ordered stages', async () => {
    setRows(
      [{ correlationId: 'lot_1', originatingDid: 'did:imajin:scott', commodity: 'eggs', status: 'listed', createdAt: 't0', updatedAt: 't3' }],
      [
        { id: 's1', correlationId: 'lot_1', stage: 'declared', actorDid: 'did:imajin:scott', attestationCid: null, priorCid: null, payload: {}, createdAt: 't0' },
        { id: 's2', correlationId: 'lot_1', stage: 'collected', actorDid: 'did:imajin:dave', attestationCid: null, priorCid: 'cid-declared', payload: {}, createdAt: 't1' },
      ],
    );

    const chain = await getLotChain('lot_1');

    expect(chain.lot?.correlationId).toBe('lot_1');
    expect(chain.lot?.status).toBe('listed');
    expect(chain.stages.map((s) => s.stage)).toEqual(['declared', 'collected']);
    expect(chain.stages[1].priorCid).toBe('cid-declared');
  });

  it('returns lot=null and no stages for an unknown correlationId', async () => {
    setRows([], []);

    const chain = await getLotChain('missing');

    expect(chain.lot).toBeNull();
    expect(chain.stages).toEqual([]);
  });
});

describe('recentLotsBySupplier (#1435)', () => {
  const LOT_A = { correlationId: 'lot_2', originatingDid: 'did:imajin:scott', commodity: 'eggs', status: 'listed', createdAt: 't2', updatedAt: 't3' };
  const LOT_B = { correlationId: 'lot_1', originatingDid: 'did:imajin:scott', commodity: 'eggs', status: 'declared', createdAt: 't0', updatedAt: 't1' };

  it('returns lots newest-first honoring the limit', async () => {
    setSupplierRows([LOT_A, LOT_B]);

    const lots = await recentLotsBySupplier('did:imajin:scott', 2);

    expect(lots).toHaveLength(2);
    expect(lots[0].correlationId).toBe('lot_2');
    expect(lots[1].correlationId).toBe('lot_1');
    expect(lots[0].originatingDid).toBe('did:imajin:scott');
  });

  it('returns an empty array when the supplier has no lots', async () => {
    setSupplierRows([]);

    const lots = await recentLotsBySupplier('did:imajin:unknown');

    expect(lots).toEqual([]);
  });
});
