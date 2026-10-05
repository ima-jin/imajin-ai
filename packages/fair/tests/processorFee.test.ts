import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROCESSOR_RAIL,
  computeFeeCents,
  grossUpForProcessorFee,
  processorFee,
  processorFeeCents,
  processorFeeEntry,
  processorFeeSchedule,
} from '../src/processorFee';
import * as fair from '../src/index';
import { buildFairManifest } from '../src/buildManifest';
import { resolveSettlementChain } from '../src/settlement';
import { getDefaultManifest } from '../src/templates';

const RATE_BPS = 370;
const MIN_RATE_BPS = 290;
const FIXED_CENTS = 30;

describe('processorFeeSchedule', () => {
  it('returns the default rail schedule', () => {
    expect(processorFeeSchedule(DEFAULT_PROCESSOR_RAIL)).toEqual({
      name: 'Stripe',
      rateBps: RATE_BPS,
      minRateBps: MIN_RATE_BPS,
      fixedCents: FIXED_CENTS,
    });
  });

  it('returns undefined for an unknown rail', () => {
    expect(processorFeeSchedule('nope')).toBeUndefined();
  });

  it('does not resolve Object.prototype keys as rails', () => {
    expect(processorFeeSchedule('constructor')).toBeUndefined();
    expect(processorFeeSchedule('__proto__')).toBeUndefined();
    expect(processorFeeSchedule('toString')).toBeUndefined();
  });
});

describe('processorFee', () => {
  it('is rate * amount + fixed, unrounded', () => {
    // 3.7% of 10_001 = 370.037, + 30
    expect(processorFee(DEFAULT_PROCESSOR_RAIL, 10_001)).toBe((10_001 * RATE_BPS) / 10_000 + FIXED_CENTS);
    expect(processorFee(DEFAULT_PROCESSOR_RAIL, 10_001)).toBeCloseTo(400.037, 6);
  });

  it('is exactly the fixed fee at zero', () => {
    expect(processorFee(DEFAULT_PROCESSOR_RAIL, 0)).toBe(FIXED_CENTS);
  });

  it('matches computeFeeCents with the schedule values', () => {
    for (const amount of [1, 99, 100, 1234, 99_999, 500_000]) {
      expect(processorFee(DEFAULT_PROCESSOR_RAIL, amount)).toBe(computeFeeCents(amount, RATE_BPS, FIXED_CENTS));
    }
  });

  it('throws for an unknown rail, naming it', () => {
    expect(() => processorFee('nope', 100)).toThrow('no fee schedule registered for rail "nope"');
  });
});

describe('processorFeeCents', () => {
  it('rounds the percentage part, then adds the fixed part (checkout/webhook expression)', () => {
    for (const amount of [0, 1, 99, 100, 1234, 10_001, 99_999, 500_000]) {
      expect(processorFeeCents(DEFAULT_PROCESSOR_RAIL, amount)).toBe(
        Math.round((amount * RATE_BPS) / 10_000) + FIXED_CENTS,
      );
    }
  });

  it('always yields whole cents', () => {
    expect(Number.isInteger(processorFeeCents(DEFAULT_PROCESSOR_RAIL, 10_001))).toBe(true);
  });

  it('throws for an unknown rail', () => {
    expect(() => processorFeeCents('nope', 100)).toThrow(/nope/);
  });
});

describe('grossUpForProcessorFee', () => {
  it('matches the payer-absorbs-fees top-up formula', () => {
    for (const net of [2000, 5000, 10_000, 100_000]) {
      expect(grossUpForProcessorFee(DEFAULT_PROCESSOR_RAIL, net)).toBe(
        Math.ceil((net + FIXED_CENTS) / (1 - RATE_BPS / 10_000)),
      );
    }
  });

  it('leaves at least the net amount after the fee', () => {
    const gross = grossUpForProcessorFee(DEFAULT_PROCESSOR_RAIL, 5000);
    expect(gross - (gross * RATE_BPS) / 10_000 - FIXED_CENTS).toBeGreaterThanOrEqual(5000);
  });

  it('throws for an unknown rail', () => {
    expect(() => grossUpForProcessorFee('nope', 100)).toThrow(/nope/);
  });
});

describe('processorFeeEntry', () => {
  it('builds the manifest fees[] entry in the historical key order', () => {
    const entry = processorFeeEntry(DEFAULT_PROCESSOR_RAIL);
    expect(entry).toEqual({
      role: 'processor',
      name: 'Stripe',
      rateBps: RATE_BPS,
      minRateBps: MIN_RATE_BPS,
      fixedCents: FIXED_CENTS,
    });
    expect(Object.keys(entry)).toEqual(['role', 'name', 'rateBps', 'minRateBps', 'fixedCents']);
  });

  it('defaults to the default rail', () => {
    expect(processorFeeEntry()).toEqual(processorFeeEntry(DEFAULT_PROCESSOR_RAIL));
  });

  it('returns a fresh object each call (callers may mutate manifests)', () => {
    expect(processorFeeEntry()).not.toBe(processorFeeEntry());
  });

  it('throws for an unknown rail', () => {
    expect(() => processorFeeEntry('nope')).toThrow(/nope/);
  });
});

describe('rail parameter plumbing', () => {
  const base = { creatorDid: 'did:imajin:c', contentDid: 'did:imajin:x', contentType: 'image/png' };

  it('buildFairManifest defaults to the default rail and accepts an explicit one', () => {
    expect(buildFairManifest(base).fees).toEqual([processorFeeEntry(DEFAULT_PROCESSOR_RAIL)]);
    expect(buildFairManifest({ ...base, rail: DEFAULT_PROCESSOR_RAIL }).fees).toEqual(buildFairManifest(base).fees);
  });

  it('buildFairManifest rejects an unknown rail', () => {
    expect(() => buildFairManifest({ ...base, rail: 'nope' })).toThrow(/nope/);
  });

  it('getDefaultManifest defaults to the default rail and accepts an explicit one', () => {
    expect(getDefaultManifest('image/png', 'did:imajin:o').fees).toEqual([processorFeeEntry(DEFAULT_PROCESSOR_RAIL)]);
    expect(getDefaultManifest('image/png', 'did:imajin:o', DEFAULT_PROCESSOR_RAIL).fees).toEqual([
      processorFeeEntry(DEFAULT_PROCESSOR_RAIL),
    ]);
  });

  it('getDefaultManifest rejects an unknown rail', () => {
    expect(() => getDefaultManifest('image/png', 'did:imajin:o', 'nope')).toThrow(/nope/);
  });

  it('resolveSettlementChain fallback is the rail-keyed estimate, explicit or default', () => {
    const opts = {
      amountCents: 10_000,
      chain: [{ did: 'did:imajin:s', role: 'seller', share: 1 }],
      buyerDid: 'did:imajin:b',
      nodeDid: null,
    };
    const implicit = resolveSettlementChain(opts);
    const explicit = resolveSettlementChain({ ...opts, rail: DEFAULT_PROCESSOR_RAIL });
    const viaManifest = resolveSettlementChain({
      ...opts,
      fees: [{ role: 'processor', rateBps: RATE_BPS, fixedCents: FIXED_CENTS }],
    });
    expect(explicit).toEqual(implicit);
    expect(implicit).toEqual(viaManifest);
    expect(implicit.estimatedFeeDollars).toBe(4);
  });

  it('resolveSettlementChain throws on an unknown fallback rail only when it is needed', () => {
    const opts = {
      amountCents: 10_000,
      chain: [{ did: 'did:imajin:s', role: 'seller', share: 1 }],
      buyerDid: 'did:imajin:b',
      nodeDid: null,
      rail: 'nope',
    };
    expect(() => resolveSettlementChain(opts)).toThrow(/nope/);
    // A manifest-supplied processor entry wins — the rail key is never consulted.
    expect(() =>
      resolveSettlementChain({ ...opts, fees: [{ role: 'processor', rateBps: 100, fixedCents: 0 }] }),
    ).not.toThrow();
  });
});

describe('public exports', () => {
  it('exposes the rail-keyed lookup', () => {
    expect(fair.processorFee).toBe(processorFee);
    expect(fair.processorFeeCents).toBe(processorFeeCents);
    expect(fair.processorFeeEntry).toBe(processorFeeEntry);
    expect(fair.processorFeeSchedule).toBe(processorFeeSchedule);
    expect(fair.grossUpForProcessorFee).toBe(grossUpForProcessorFee);
    expect(fair.DEFAULT_PROCESSOR_RAIL).toBe(DEFAULT_PROCESSOR_RAIL);
  });

  it('no longer exports rail-named fee constants', () => {
    expect(Object.keys(fair).filter((k) => k.toUpperCase().includes('STRIPE'))).toEqual([]);
  });
});
