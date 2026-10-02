/**
 * Core invariant tests for settlement math (#325).
 *
 * `resolveSettlementChain` turns a manifest chain into dollar amounts that
 * `POST /pay/api/settle` insists sum to `total_amount`. Two invariants matter
 * more than any individual number:
 *
 *   1. Σ(resolved amounts) + estimated processor fee == the buyer's total.
 *      The platform / node / protocol shares are never allowed to leak or
 *      mint a penny after the processor fee comes out of the seller.
 *   2. Σ(resolved amounts) == expectedTotal to the cent, for ANY amount and
 *      share split — i.e. per-entry `toFixed(2)` rounding drift is always
 *      corrected (the penny-drift bug).
 *
 * Money is compared in integer cents so a failure can never be masked by
 * floating-point tolerance.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveSettlementChain,
  type FairSettlementEntry,
  type ResolveChainOptions,
} from '../src/settlement';

const BUYER = 'did:imajin:buyer';
const NODE = 'did:imajin:node';

type Fees = NonNullable<ResolveChainOptions['fees']>;

const toCents = (dollars: number): number => Math.round(dollars * 100);

function sumCents(entries: ReadonlyArray<{ amount: number }>): number {
  return entries.reduce((sum, e) => sum + toCents(e.amount), 0);
}

function resolve(
  amountCents: number,
  chain: FairSettlementEntry[],
  fees?: Fees,
  extra: Partial<ResolveChainOptions> = {},
) {
  return resolveSettlementChain({ amountCents, chain, fees, buyerDid: BUYER, nodeDid: NODE, ...extra });
}

// Share splits that do not divide evenly into cents.
const CHAINS: Record<string, FairSettlementEntry[]> = {
  'standard platform fee split': [
    { did: 'BUYER_PLACEHOLDER', role: 'buyer', share: 0 },
    { did: 'NODE_PLACEHOLDER', role: 'node', share: 0.005 },
    { did: 'did:imajin:protocol', role: 'protocol', share: 0.01 },
    { did: 'did:imajin:scope', role: 'scope', share: 0.0025 },
    { did: 'did:imajin:seller', role: 'seller', share: 0.9825 },
  ],
  'three-way thirds': [
    { did: 'did:imajin:a', role: 'creator', share: 0.3333 },
    { did: 'did:imajin:b', role: 'creator', share: 0.3333 },
    { did: 'did:imajin:c', role: 'seller', share: 0.3334 },
  ],
  'seller plus awkward platform shares': [
    { did: 'did:imajin:platform', role: 'platform', share: 0.0137 },
    { did: 'NODE_PLACEHOLDER', role: 'node', share: 0.0063 },
    { did: 'did:imajin:seller', role: 'seller', share: 0.98 },
  ],
  'no seller-role entry': [
    { did: 'did:imajin:x', role: 'platform', share: 0.3333 },
    { did: 'did:imajin:y', role: 'node', share: 0.3333 },
    { did: 'did:imajin:z', role: 'protocol', share: 0.3334 },
  ],
};

const FEE_CONFIGS: Record<string, Fees | undefined> = {
  'no processor entry (3.7% + 30c fallback)': undefined,
  'stripe domestic (2.9% + 30c)': [{ role: 'processor', rateBps: 290, fixedCents: 30 }],
  'zero-cost processor': [{ role: 'processor', rateBps: 0, fixedCents: 0 }],
};

const AMOUNTS_CENTS = [1000, 1001, 1999, 2501, 3333, 9999, 10_001, 12_345, 33_333, 99_999, 100_007];

// ─── Attribution shares sum correctly after the platform fee ────────────────

describe('settlement invariant: shares + processor fee == total', () => {
  for (const [chainName, chain] of Object.entries(CHAINS)) {
    for (const [feeName, fees] of Object.entries(FEE_CONFIGS)) {
      it(`${chainName} / ${feeName}: holds for every amount`, () => {
        for (const amountCents of AMOUNTS_CENTS) {
          const { resolvedChain, estimatedFeeDollars, expectedTotal } = resolve(amountCents, chain, fees);

          const distributed = sumCents(resolvedChain);

          // What reaches the chain plus what the processor keeps is exactly what the buyer paid.
          expect(distributed + toCents(estimatedFeeDollars), `amount=${amountCents}`).toBe(amountCents);
          expect(distributed, `amount=${amountCents}`).toBe(toCents(expectedTotal));
        }
      });
    }
  }

  it('never moves money into a non-seller entry: only the seller-role entries absorb the fee and drift', () => {
    const { resolvedChain } = resolve(10_001, CHAINS['standard platform fee split']!, FEE_CONFIGS['stripe domestic (2.9% + 30c)']);

    const byRole = Object.fromEntries(resolvedChain.map((e) => [e.role, e.amount]));

    // $100.01 × share, rounded to the cent — untouched by the fee or drift correction.
    expect(byRole.node).toBe(0.5);
    expect(byRole.protocol).toBe(1);
    expect(byRole.scope).toBe(0.25);
    expect(byRole.buyer).toBe(0);
  });

  it('the fee is deducted from the seller, not added on top of the buyer total', () => {
    const { resolvedChain, estimatedFeeDollars, expectedTotal } = resolve(
      10_000,
      CHAINS['standard platform fee split']!,
      FEE_CONFIGS['stripe domestic (2.9% + 30c)'],
    );

    expect(estimatedFeeDollars).toBe(3.2);
    expect(expectedTotal).toBe(96.8);
    expect(resolvedChain.find((e) => e.role === 'seller')!.amount).toBe(95.05); // 98.25 − 3.20
    expect(sumCents(resolvedChain)).toBe(9680);
  });
});

// ─── Penny rounding drift correction (the bug we fixed) ─────────────────────

describe('settlement invariant: penny rounding drift', () => {
  const NO_FEE: Fees = [{ role: 'processor', rateBps: 0, fixedCents: 0 }];

  it('per-entry rounding genuinely drifts here, and the correction lands on the first seller-role entry', () => {
    // $100.01 split 33.33% / 33.33% / 33.34%: each rounds to 33.33 / 33.33 / 33.34 = $100.00, one penny short.
    // `creator` is a seller role, so the first creator absorbs the missing penny.
    const { resolvedChain, expectedTotal } = resolve(10_001, CHAINS['three-way thirds']!, NO_FEE);

    expect(expectedTotal).toBe(100.01);
    expect(resolvedChain.map((e) => e.amount)).toEqual([33.34, 33.33, 33.34]);
    expect(sumCents(resolvedChain)).toBe(10_001);
  });

  it('corrects a surplus (negative drift) as well as a shortfall', () => {
    // 50% / 50% of $0.05: 2.5c each rounds up to 3c = 6c in total, one cent over the 5c total.
    const { resolvedChain } = resolve(
      5,
      [
        { did: 'did:imajin:a', role: 'creator', share: 0.5 },
        { did: 'did:imajin:b', role: 'seller', share: 0.5 },
      ],
      NO_FEE,
    );

    expect(resolvedChain.map((e) => e.amount)).toEqual([0.02, 0.03]);
    expect(sumCents(resolvedChain)).toBe(5);
  });

  it('falls back to the largest entry when no entry has a seller role', () => {
    const { resolvedChain, expectedTotal } = resolve(10_001, CHAINS['no seller-role entry']!, NO_FEE);

    expect(resolvedChain.map((e) => e.amount)).toEqual([33.33, 33.33, 33.35]);
    expect(sumCents(resolvedChain)).toBe(toCents(expectedTotal));
  });

  it('applies the correction to the first seller-role entry in chain order only, skipping non-seller entries ahead of it', () => {
    const { resolvedChain } = resolve(
      10_001,
      [
        { did: 'did:imajin:platform', role: 'platform', share: 0.3333 },
        { did: 'did:imajin:b', role: 'seller', share: 0.3333 },
        { did: 'did:imajin:c', role: 'event', share: 0.3334 },
      ],
      NO_FEE,
    );

    expect(resolvedChain.map((e) => e.amount)).toEqual([33.33, 33.34, 33.34]);
    expect(sumCents(resolvedChain)).toBe(10_001);
  });

  it('leaves amounts untouched when there is no drift', () => {
    const { resolvedChain } = resolve(
      10_000,
      [
        { did: 'did:imajin:platform', role: 'platform', share: 0.02 },
        { did: 'did:imajin:seller', role: 'seller', share: 0.98 },
      ],
      NO_FEE,
    );

    expect(resolvedChain.map((e) => e.amount)).toEqual([2, 98]);
  });

  it('every amount from $0.10 to $20.00 still sums exactly (exhaustive sweep, thirds split)', () => {
    for (let amountCents = 10; amountCents <= 2000; amountCents++) {
      const { resolvedChain, expectedTotal } = resolve(amountCents, CHAINS['three-way thirds']!, NO_FEE);

      expect(sumCents(resolvedChain), `amount=${amountCents}`).toBe(toCents(expectedTotal));
    }
  });

  it('is deterministic: the same input always yields the same chain', () => {
    const first = resolve(33_333, CHAINS['seller plus awkward platform shares']!);
    const second = resolve(33_333, CHAINS['seller plus awkward platform shares']!);

    expect(second).toEqual(first);
  });

  it('does not mutate the caller-supplied chain', () => {
    const chain = CHAINS['three-way thirds']!.map((e) => ({ ...e }));
    const snapshot = structuredClone(chain);

    resolve(10_001, chain, NO_FEE);

    expect(chain).toEqual(snapshot);
  });
});

// ─── Multi-seller chains: fee split pro rata (#2472) ────────────────────────

describe('settlement invariant: processor fee is split pro rata across seller-role entries (#2472)', () => {
  const STRIPE: Fees = [{ role: 'processor', rateBps: 290, fixedCents: 30 }];
  const NO_FEE: Fees = [{ role: 'processor', rateBps: 0, fixedCents: 0 }];

  const TWO_SELLERS: FairSettlementEntry[] = [
    { did: 'did:imajin:creator', role: 'creator', share: 0.6 },
    { did: 'did:imajin:event', role: 'event', share: 0.3 },
    { did: 'did:imajin:platform', role: 'platform', share: 0.1 },
  ];

  it('charges the fee once in total, split by gross share (not in full to each seller)', () => {
    // $100.00, fee 2.9% + 30c = $3.20 split 2:1 across 60.00 / 30.00 → 2.13 / 1.07
    const { resolvedChain, estimatedFeeDollars } = resolve(10_000, TWO_SELLERS, STRIPE);

    expect(estimatedFeeDollars).toBe(3.2);
    expect(resolvedChain.map((e) => e.amount)).toEqual([57.87, 28.93, 10]);
    expect(sumCents(resolvedChain)).toBe(10_000 - 320);
  });

  it('equal seller shares each bear an equal part of the fee', () => {
    const { resolvedChain } = resolve(
      10_000,
      [
        { did: 'did:imajin:a', role: 'creator', share: 0.45 },
        { did: 'did:imajin:b', role: 'event', share: 0.45 },
        { did: 'did:imajin:platform', role: 'platform', share: 0.1 },
      ],
      STRIPE,
    );

    expect(resolvedChain.map((e) => e.amount)).toEqual([43.4, 43.4, 10]);
  });

  it('gives an odd fee cent to the seller with the larger remainder, not always the first', () => {
    // Flat 1c fee over 40% / 60% sellers: exact parts are 0.4c / 0.6c, so the second seller takes the cent.
    const { resolvedChain } = resolve(
      1000,
      [
        { did: 'did:imajin:a', role: 'creator', share: 0.4 },
        { did: 'did:imajin:b', role: 'event', share: 0.6 },
      ],
      [{ role: 'processor', rateBps: 0, fixedCents: 1 }],
    );

    expect(resolvedChain.map((e) => e.amount)).toEqual([4, 5.99]);
    expect(sumCents(resolvedChain)).toBe(999);
  });

  it('a single-cent rounding shortfall lands on the first seller-role entry', () => {
    // $1.00: gross rounds to 24c / 24c / 24c / 27c = 99c, one cent short.
    const { resolvedChain } = resolve(
      100,
      [
        { did: 'did:imajin:a', role: 'creator', share: 0.2449 },
        { did: 'did:imajin:b', role: 'creator', share: 0.2449 },
        { did: 'did:imajin:c', role: 'creator', share: 0.2449 },
        { did: 'did:imajin:d', role: 'creator', share: 0.2653 },
      ],
      NO_FEE,
    );

    expect(resolvedChain.map((e) => e.amount)).toEqual([0.25, 0.24, 0.24, 0.27]);
  });

  it('spreads a multi-cent shortfall one cent per seller instead of loading the first', () => {
    // $1.00 over five 19.49% sellers: gross rounds to 19c each = 95c, five cents short.
    const { resolvedChain } = resolve(
      100,
      ['a', 'b', 'c', 'd', 'e'].map((id) => ({ did: `did:imajin:${id}`, role: 'creator', share: 0.1949 })),
      NO_FEE,
    );

    expect(resolvedChain.map((e) => e.amount)).toEqual([0.2, 0.2, 0.2, 0.2, 0.2]);
  });

  it('spreads a multi-cent surplus one cent per seller and never drives an entry negative', () => {
    // $0.05 over six ~16.67% sellers: gross rounds to 1c each = 6c, one cent over → one seller gives up its cent.
    const { resolvedChain, expectedTotal } = resolve(
      5,
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ did: `did:imajin:${id}`, role: 'creator', share: 1 / 6 })),
      NO_FEE,
    );

    expect(sumCents(resolvedChain)).toBe(toCents(expectedTotal));
    for (const e of resolvedChain) expect(e.amount).toBeGreaterThanOrEqual(0);
  });

  it('keeps non-seller entries untouched and never produces a negative amount', () => {
    for (const amountCents of [1000, 1001, 1999, 3333, 9999, 12_345, 99_999]) {
      const { resolvedChain, expectedTotal } = resolve(amountCents, TWO_SELLERS, STRIPE);
      const platform = resolvedChain.find((e) => e.role === 'platform')!;

      expect(toCents(platform.amount), `amount=${amountCents}`).toBe(Math.round(amountCents * 0.1));
      expect(sumCents(resolvedChain), `amount=${amountCents}`).toBe(toCents(expectedTotal));
      for (const e of resolvedChain) expect(e.amount, `amount=${amountCents}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('exhaustive sweep: multi-seller chain always reconciles and every seller bears at most its share of the fee ±1c', () => {
    for (let amountCents = 100; amountCents <= 5000; amountCents++) {
      const { resolvedChain, estimatedFeeDollars, expectedTotal } = resolve(amountCents, TWO_SELLERS, STRIPE);

      expect(sumCents(resolvedChain), `amount=${amountCents}`).toBe(toCents(expectedTotal));
      expect(sumCents(resolvedChain) + toCents(estimatedFeeDollars), `amount=${amountCents}`).toBe(amountCents);

      const feeCents = toCents(estimatedFeeDollars);
      const [creator, event] = resolvedChain;
      const creatorFee = Math.round(amountCents * 0.6) - toCents(creator!.amount);
      const eventFee = Math.round(amountCents * 0.3) - toCents(event!.amount);
      // Each seller's deduction tracks its pro-rata part of the fee within the 2c of gross-rounding drift.
      expect(Math.abs(creatorFee - (feeCents * 2) / 3), `amount=${amountCents}`).toBeLessThanOrEqual(2);
      expect(Math.abs(eventFee - feeCents / 3), `amount=${amountCents}`).toBeLessThanOrEqual(2);
    }
  });
});

// ─── Tax is excluded from chain math but included in the fee basis ─────────

describe('settlement invariant: taxes never enter the chain', () => {
  const taxes: NonNullable<ResolveChainOptions['taxes']> = [
    {
      jurisdiction: 'CA-ON',
      kind: 'GST/HST',
      rateBps: 1300,
      basisAmount: 10_000,
      amount: 1300,
      collectorDid: 'did:imajin:seller',
      remitTo: 'did:imajin:authority:ca-cra',
    },
  ];

  it('chain + fee still equals the pre-tax basis; the tax credit is separate and whole', () => {
    const { resolvedChain, estimatedFeeDollars, taxCredits, totalTaxDollars } = resolve(
      10_000,
      CHAINS['standard platform fee split']!,
      [{ role: 'processor', rateBps: 290, fixedCents: 30 }],
      { taxes },
    );

    // Fee is charged on the gross $113.00 (2.9% + 30c = $3.577 → $3.58), the seller absorbs it.
    expect(estimatedFeeDollars).toBe(3.58);
    expect(sumCents(resolvedChain) + toCents(estimatedFeeDollars)).toBe(10_000);
    expect(totalTaxDollars).toBe(13);
    expect(taxCredits).toHaveLength(1);
    expect(taxCredits[0]).toMatchObject({ did: 'did:imajin:seller', amount: 13 });
  });
});
