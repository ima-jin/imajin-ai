import { describe, it, expect, vi } from 'vitest';

// Force chain-config lookups to miss the DB so getChainConfig() falls back to
// the hardcoded DEFAULTS map. This lets us assert the reconciled chains
// deterministically without a live kernel.bus_chain_configs table.
vi.mock('@imajin/db', () => ({
  getClient: () => () => Promise.resolve([]),
}));

import { getChainConfig } from '../src/config';

describe('chain config DEFAULTS reconcile (#1873, #1874)', () => {
  it('order.completed includes supply-recorder before settle (#1873)', async () => {
    const cfg = await getChainConfig('order.completed', 'supply');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['supply-recorder', 'settle']);
    expect(cfg.reactors[0]?.await).toBe(true);
    expect(cfg.reactors[1]?.await).toBe(true);
  });

  it('attestation.created includes attestation-notify after emit (#1856, #1874)', async () => {
    const cfg = await getChainConfig('attestation.created', 'default');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['emit', 'attestation-notify']);
    expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
  });

  it('availability.match.surfaced includes notify-match-delivery after emit (#1874)', async () => {
    const cfg = await getChainConfig('availability.match.surfaced', 'default');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['emit', 'notify-match-delivery']);
    expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
  });

  it('usage.incurred routes to attestation + emit with NO settle reactor (#1147/#1148)', async () => {
    const cfg = await getChainConfig('usage.incurred', 'default');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['attestation', 'emit']);
    expect(types).not.toContain('settle');
    expect(cfg.reactors.every((r) => r.enabled)).toBe(true);
  });

  it('usage.rollup routes to attestation (awaited) + emit with NO settle reactor (#1148)', async () => {
    const cfg = await getChainConfig('usage.rollup', 'default');
    const types = cfg.reactors.map((r) => r.type);

    expect(types).toEqual(['attestation', 'emit']);
    expect(types).not.toContain('settle');
    expect(cfg.reactors[0]?.await).toBe(true);
  });
});

describe('broker reactor registry (#1874)', () => {
  it('mutual-reach-consent reactor is exported from the bus package', async () => {
    const { mutualReachConsentReactor } = await import('../src/index');

    expect(typeof mutualReachConsentReactor).toBe('function');
  });

  it('intersection-scope reactor is exported from the bus package', async () => {
    const { intersectionScopeReactor } = await import('../src/index');

    expect(typeof intersectionScopeReactor).toBe('function');
  });
});
