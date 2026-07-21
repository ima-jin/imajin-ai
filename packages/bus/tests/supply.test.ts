import { describe, it, expect, vi } from 'vitest';

// Force chain-config lookups to miss the DB so getChainConfig() falls back to
// the hardcoded DEFAULTS map. This lets us assert the seeded supply.* chains
// deterministically without a live kernel.bus_chain_configs table.
vi.mock('@imajin/db', () => ({
  getClient: () => () => Promise.resolve([]),
}));

import { getChainConfig } from '../src/config';
import type { BusEventMap } from '../src/types';

const SUPPLY_SCOPE = 'supply';

describe('supply.* chains (#1134/#1375/#1384)', () => {
  it.each([
    ['supply.declared', ['supply-recorder', 'attestation', 'emit', 'notify']],
    ['supply.collected', ['supply-recorder', 'attestation', 'emit']],
    ['supply.processed', ['supply-recorder', 'attestation', 'emit']],
    ['supply.listed', ['supply-recorder', 'emit']],
    ['supply.received', ['supply-recorder', 'attestation', 'emit']],
  ] as const)('seeds the %s chain', async (eventType, expected) => {
    const cfg = await getChainConfig(eventType, SUPPLY_SCOPE);
    const types = cfg.reactors.map((r) => r.type);
    expect(types).toEqual([...expected]);
  });

  it('order.completed (scope=supply) runs supply-recorder before settle (#1375)', async () => {
    const cfg = await getChainConfig('order.completed', SUPPLY_SCOPE);
    const types = cfg.reactors.map((r) => r.type);
    expect(types).toEqual(['supply-recorder', 'settle']);
    // supply-recorder must be awaited so the settled stage row is durable before
    // the settle reactor executes the .fair split.
    const recorder = cfg.reactors.find((r) => r.type === 'supply-recorder');
    expect(recorder?.await).toBe(true);
  });

  it('supply.received supply-recorder is awaited (stage row durable before downstream)', async () => {
    const cfg = await getChainConfig('supply.received', SUPPLY_SCOPE);
    const recorder = cfg.reactors.find((r) => r.type === 'supply-recorder');
    expect(recorder?.await).toBe(true);
  });

  it.each([
    'supply.declared',
    'supply.collected',
    'supply.processed',
    'supply.listed',
    'supply.received',
  ] as const)('has no settle reactor in the %s chain (free stage)', async (eventType) => {
    const cfg = await getChainConfig(eventType, SUPPLY_SCOPE);
    const types = cfg.reactors.map((r) => r.type);
    expect(types.includes('settle')).toBe(false);
  });

  it('type-checks well-formed supply payloads against BusEventMap', () => {
    const declared = {
      lotId: 'lot_eggs_001',
      supplierDid: 'did:imajin:scott',
      commodity: 'eggs',
      quantity: 12,
      unit: 'dozen',
      context_id: 'ctx_supply_001',
      context_type: 'supply',
    } satisfies BusEventMap['supply.declared'];

    const collected = {
      ...declared,
      priorCid: 'bafy-declared-record',
    } satisfies BusEventMap['supply.collected'];

    // #1384 — supply.received uses recipientDid (not supplierDid); commodity-agnostic.
    const received = {
      lotId: 'lot_eggs_001',
      recipientDid: 'did:imajin:david',
      commodity: 'eggs',
      quantity: 12,
      unit: 'dozen',
      priorCid: 'bafy-listed-record',
      context_id: 'lot_eggs_001',
      context_type: 'supply',
    } satisfies BusEventMap['supply.received'];

    expect(declared.lotId).toBe('lot_eggs_001');
    expect(collected.priorCid).toBeDefined();
    expect(received.recipientDid).toBe('did:imajin:david');
  });
});
