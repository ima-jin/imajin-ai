import { describe, it, expect, vi } from 'vitest';

// Fake tagged-template client that returns canned rows per target table, so we
// can exercise getLotChain without a live DB.
const { setRows, fakeSql } = vi.hoisted(() => {
  let lotRows: unknown[] = [];
  let stageRows: unknown[] = [];
  const fakeSql = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join(' ');
    if (text.includes('kernel.supply_stages')) return Promise.resolve(stageRows);
    if (text.includes('kernel.supply_lots')) return Promise.resolve(lotRows);
    return Promise.resolve([]);
  };
  const setRows = (lot: unknown[], stages: unknown[]) => {
    lotRows = lot;
    stageRows = stages;
  };
  return { setRows, fakeSql };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import { getLotChain } from '../src/supply-lots';

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
