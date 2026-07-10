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

describe('supply.* chains (#1134)', () => {
  it.each([
    ['supply.declared', ['attestation', 'emit', 'notify']],
    ['supply.collected', ['attestation', 'emit']],
    ['supply.processed', ['attestation', 'emit']],
    ['supply.listed', ['emit']],
  ] as const)('seeds the %s chain', async (eventType, expected) => {
    const cfg = await getChainConfig(eventType, SUPPLY_SCOPE);
    const types = cfg.reactors.map((r) => r.type);
    expect(types).toEqual([...expected]);
  });

  it.each([
    'supply.declared',
    'supply.collected',
    'supply.processed',
    'supply.listed',
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

    expect(declared.lotId).toBe('lot_eggs_001');
    expect(collected.priorCid).toBeDefined();
  });
});
