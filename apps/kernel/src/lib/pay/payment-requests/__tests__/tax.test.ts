/**
 * Tax math + rate table + server-side tax resolution (#2421). Everything
 * here is pure: `@imajin/fair` and `@imajin/money` run for real.
 */
import { describe, it, expect } from 'vitest';
import { AUTHORITY_DID_CA_CRA, buildFairManifest } from '@imajin/fair';
import {
  computeTaxAmountMinor,
  defaultTaxRateBps,
  formatRateBps,
  parseRatePercentToBps,
  rateBpsToPercentInput,
} from '../tax-rates';
import {
  checkAssertedTotals,
  computeGrandTotal,
  isChainSeller,
  parseTaxRowInputs,
  remitToFor,
  resolveTaxCharge,
  sumTaxes,
  taxBreakdownOf,
} from '../tax';

const ISSUER = 'did:imajin:issuer';
const CAD = 'CAD';

describe('computeTaxAmountMinor — round(basis × rateBps / 10000), integers only', () => {
  it.each([
    [10_000, 1300, 1300], // 13% of $100.00
    [5000, 500, 250],
    [0, 1300, 0], // zero basis
    [10_000, 0, 0], // zero rate
    [1001, 1300, 130], // 130.13 → 130 (down)
    [995, 1300, 129], // 129.35 → 129
    [1005, 1300, 131], // 130.65 → 131 (up)
    [1050, 500, 53], // 52.5 → 53: exact half rounds UP (not banker's 52)
    [50, 100, 1], // 0.5 → 1
    [49, 100, 0], // 0.49 → 0
    [3, 500, 0], // basis too small to yield a cent
    [99_999_900, 1500, 14_999_985],
  ])('basis %i × %i bps = %i', (basis, rate, expected) => {
    expect(computeTaxAmountMinor(basis, rate)).toBe(expected);
  });

  it('rejects negative, fractional, or unsafe inputs instead of guessing', () => {
    expect(() => computeTaxAmountMinor(-1, 1300)).toThrow(RangeError);
    expect(() => computeTaxAmountMinor(100.5, 1300)).toThrow(RangeError);
    expect(() => computeTaxAmountMinor(100, 997.5)).toThrow(RangeError);
    expect(() => computeTaxAmountMinor(100, -1)).toThrow(RangeError);
    expect(() => computeTaxAmountMinor(Number.MAX_SAFE_INTEGER + 1, 1)).toThrow(RangeError);
  });

  it('is byte-identical to the amount packages/fair (#2419) stores, across a sweep of subtotals and rates', () => {
    const rates = [0, 1, 50, 500, 600, 700, 997, 1300, 1400, 1500, 2000, 10_000];
    for (const basis of [0, 1, 2, 49, 50, 51, 99, 100, 101, 995, 1001, 1050, 4999, 5000, 12_345, 999_999]) {
      for (const rateBps of rates) {
        const [fairRow] = buildFairManifest({
          creatorDid: ISSUER,
          contentDid: 'x',
          contentType: 'payment_request',
          basisAmountCents: basis,
          taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps, registrationNumber: 'r', collectorDid: ISSUER, remitTo: AUTHORITY_DID_CA_CRA }],
        }).taxes!;
        expect(computeTaxAmountMinor(basis, rateBps)).toBe(fairRow.amount);
      }
    }
  });
});

describe('total = subtotal + tax_total — exact, via packages/money', () => {
  it('holds for a sweep of subtotals × rates, multi-row', () => {
    for (const subtotalAmount of [1, 99, 1050, 20_002, 123_456]) {
      const subtotal = { amount: subtotalAmount, currency: CAD };
      const taxes = [500, 700, 997].map((rateBps) => ({ amount: computeTaxAmountMinor(subtotalAmount, rateBps) }));
      const taxTotal = sumTaxes(taxes, CAD);
      const total = computeGrandTotal(subtotal, taxTotal);
      expect(total.amount).toBe(subtotalAmount + taxes.reduce((s, t) => s + t.amount, 0));
      expect(total.amount - subtotal.amount).toBe(taxTotal.amount);
      expect(Number.isInteger(total.amount)).toBe(true);
    }
  });

  it('an empty tax list sums to zero', () => {
    expect(sumTaxes([], CAD)).toEqual({ amount: 0, currency: CAD });
    expect(computeGrandTotal({ amount: 5000, currency: CAD }, sumTaxes([], CAD))).toEqual({ amount: 5000, currency: CAD });
  });
});

describe('defaultTaxRateBps — static integer-bps table', () => {
  it.each([
    ['CA-ON', 'GST/HST', 1300],
    ['CA-NS', 'GST/HST', 1400], // NS HST 14% since 2025-04-01
    ['CA-NB', 'GST/HST', 1500],
    ['CA-NL', 'GST/HST', 1500],
    ['CA-PE', 'GST/HST', 1500],
    ['CA-AB', 'GST/HST', 500],
    ['CA-BC', 'GST/HST', 500],
    ['CA-MB', 'GST/HST', 500],
    ['CA-SK', 'GST/HST', 500],
    ['CA-YT', 'GST/HST', 500],
    ['CA-NT', 'GST/HST', 500],
    ['CA-NU', 'GST/HST', 500],
    ['CA-QC', 'GST/HST', 500],
    ['CA-BC', 'PST', 700],
    ['CA-SK', 'PST', 600],
    ['CA-MB', 'PST', 700],
  ])('%s %s → %i bps', (jurisdiction, kind, bps) => {
    expect(defaultTaxRateBps(jurisdiction, kind)).toBe(bps);
  });

  it('has NO entry for Quebec QST (9.975% = 997.5 bps is not an integer) — the rate stays blank rather than being rounded', () => {
    expect(defaultTaxRateBps('CA-QC', 'QST')).toBeNull();
  });

  it('has no entry for an unknown jurisdiction/kind (blank, required)', () => {
    expect(defaultTaxRateBps('GB', 'VAT')).toBeNull();
    expect(defaultTaxRateBps('CA-ON', 'PST')).toBeNull();
    expect(defaultTaxRateBps('', '')).toBeNull();
  });

  it('every table value is a non-negative integer number of bps', () => {
    for (const [j, k] of [['CA-ON', 'GST/HST'], ['CA-NS', 'GST/HST'], ['CA-BC', 'PST'], ['CA-SK', 'PST']]) {
      const bps = defaultTaxRateBps(j, k)!;
      expect(Number.isInteger(bps) && bps >= 0).toBe(true);
    }
  });
});

describe('parseRatePercentToBps / formatRateBps — no floats, no silent rounding', () => {
  it.each([
    ['13', 1300],
    ['5', 500],
    ['0', 0],
    ['0.5', 50],
    ['9.97', 997],
    ['14.00', 1400],
    ['100', 10_000],
    [' 13 ', 1300],
  ])('parses %j → %i', (input, bps) => {
    expect(parseRatePercentToBps(input)).toEqual({ ok: true, rateBps: bps });
  });

  it('refuses 9.975% (997.5 bps) instead of rounding it', () => {
    const result = parseRatePercentToBps('9.975');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a whole number of basis points/);
  });

  it.each(['', 'abc', '-1', '13%', '1e2', '13.', '.5', '100.01', '101', '1,5'])('rejects %j', (input) => {
    expect(parseRatePercentToBps(input).ok).toBe(false);
  });

  it.each([
    [1300, '13%'],
    [500, '5%'],
    [997, '9.97%'],
    [1050, '10.5%'],
    [0, '0%'],
    [1, '0.01%'],
    [10_000, '100%'],
  ])('formats %i bps → %s, and round-trips through the input parser', (bps, text) => {
    expect(formatRateBps(bps)).toBe(text);
    expect(parseRatePercentToBps(rateBpsToPercentInput(bps))).toEqual({ ok: true, rateBps: bps });
  });
});

describe('remitToFor — authority placeholder DID convention', () => {
  it('GST/HST → the CRA placeholder #2419 already uses, in every province', () => {
    expect(remitToFor('CA-ON', 'GST/HST')).toBe(AUTHORITY_DID_CA_CRA);
    expect(remitToFor('CA-AB', 'GST/HST')).toBe('did:imajin:authority:ca-cra');
  });
  it('QST → Revenu Québec; PST/VAT → did:imajin:authority:<jurisdiction>', () => {
    expect(remitToFor('CA-QC', 'QST')).toBe('did:imajin:authority:ca-qc-rq');
    expect(remitToFor('CA-BC', 'PST')).toBe('did:imajin:authority:ca-bc');
    expect(remitToFor('GB', 'VAT')).toBe('did:imajin:authority:gb');
  });
});

describe('parseTaxRowInputs', () => {
  const ROW = { jurisdiction: 'CA-ON', kind: 'GST/HST', rate_bps: 1300 };

  it('parses valid rows, keeping an optional client amount', () => {
    expect(parseTaxRowInputs([ROW, { jurisdiction: 'CA-QC', kind: 'QST', rate_bps: 998, amount: 5 }])).toEqual({
      ok: true,
      value: [
        { jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300 },
        { jurisdiction: 'CA-QC', kind: 'QST', rateBps: 998, amount: 5 },
      ],
    });
  });

  it.each([
    ['not an array', undefined],
    ['empty', []],
    ['too many rows', Array.from({ length: 11 }, (_, i) => ({ ...ROW, jurisdiction: `J-${i}` }))],
    ['a duplicate registration', [ROW, ROW]],
    ['a non-object row', [42]],
    ['an array row', [[ROW]]],
    ['a missing jurisdiction', [{ kind: 'GST/HST', rate_bps: 1 }]],
    ['a missing kind', [{ jurisdiction: 'CA-ON', rate_bps: 1 }]],
    ['a fractional rate', [{ ...ROW, rate_bps: 997.5 }]],
    ['a string rate', [{ ...ROW, rate_bps: '1300' }]],
    ['a rate over 100%', [{ ...ROW, rate_bps: 10_001 }]],
    ['a negative amount', [{ ...ROW, amount: -1 }]],
    ['a fractional amount', [{ ...ROW, amount: 1.5 }]],
  ])('rejects %s', (_label, raw) => {
    expect(parseTaxRowInputs(raw).ok).toBe(false);
  });
});

describe('resolveTaxCharge', () => {
  const subtotal = { amount: 20_002, currency: CAD };
  const REGS = [
    { jurisdiction: 'CA-BC', kind: 'GST/HST' as const, number: '987654321RT0001' },
    { jurisdiction: 'CA-BC', kind: 'PST' as const, number: '12345678' },
    { jurisdiction: 'CA-ON', kind: 'GST/HST' as const, number: '123456789RT0001' },
  ];

  it('builds full FairTax rows: registration from the profile, collector = issuer, basis = subtotal, amount = round(basis × bps / 10000)', () => {
    const result = resolveTaxCharge({
      issuerDid: ISSUER,
      subtotal,
      registrations: REGS,
      rows: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300 }],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        taxes: [
          {
            jurisdiction: 'CA-ON',
            kind: 'GST/HST',
            rateBps: 1300,
            basisAmount: 20_002,
            amount: 2600, // 2600.26 → 2600
            registrationNumber: '123456789RT0001',
            collectorDid: ISSUER,
            remitTo: AUTHORITY_DID_CA_CRA,
          },
        ],
        taxTotal: { amount: 2600, currency: CAD },
      },
    });
  });

  it('multiple registrations → one row each, all on the same basis, summed exactly', () => {
    const result = resolveTaxCharge({
      issuerDid: ISSUER,
      subtotal,
      registrations: REGS,
      rows: [
        { jurisdiction: 'CA-BC', kind: 'GST/HST', rateBps: 500 },
        { jurisdiction: 'CA-BC', kind: 'PST', rateBps: 700 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.taxes.map((t) => t.amount)).toEqual([1000, 1400]);
    expect(result.value.taxes.every((t) => t.basisAmount === 20_002)).toBe(true);
    expect(result.value.taxTotal.amount).toBe(2400);
  });

  it('zero-tax: a 0 bps row yields amount 0 and a zero tax total', () => {
    const result = resolveTaxCharge({
      issuerDid: ISSUER,
      subtotal,
      registrations: REGS,
      rows: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 0 }],
    });
    expect(result.ok && result.value.taxTotal.amount).toBe(0);
    expect(result.ok && result.value.taxes[0].amount).toBe(0);
  });

  it('fails when the issuer has no matching registration', () => {
    const result = resolveTaxCharge({
      issuerDid: ISSUER,
      subtotal,
      registrations: REGS,
      rows: [{ jurisdiction: 'CA-QC', kind: 'QST', rateBps: 998 }],
    });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/no QST tax registration for CA-QC/) });
  });

  it('fails on a client amount that disagrees with the recomputation (never silently corrected)', () => {
    const result = resolveTaxCharge({
      issuerDid: ISSUER,
      subtotal,
      registrations: REGS,
      rows: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, amount: 2601 }],
    });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/2601.*recomputed.*2600/) });
  });

  it('accepts a client amount that agrees', () => {
    const result = resolveTaxCharge({
      issuerDid: ISSUER,
      subtotal,
      registrations: REGS,
      rows: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, amount: 2600 }],
    });
    expect(result.ok).toBe(true);
  });
});

describe('checkAssertedTotals', () => {
  const computed = { subtotal: { amount: 5000, currency: CAD }, taxTotal: { amount: 650, currency: CAD }, total: { amount: 5650, currency: CAD } };

  it('passes when nothing is asserted or everything matches', () => {
    expect(checkAssertedTotals({}, computed)).toBeNull();
    expect(checkAssertedTotals({ subtotalAmount: 5000, taxTotalAmount: 650, totalAmount: 5650 }, computed)).toBeNull();
  });

  it.each([
    [{ subtotalAmount: 5001 }, /subtotal_amount \(5001\).*\(5000\)/],
    [{ taxTotalAmount: 649 }, /tax_total_amount \(649\).*\(650\)/],
    [{ totalAmount: 5651 }, /total_amount \(5651\).*\(5650\)/],
    [{ totalAmount: '5650' }, /total_amount must be an integer/],
    [{ taxTotalAmount: 650.5 }, /tax_total_amount must be an integer/],
    [{ totalAmount: null }, /total_amount must be an integer/],
  ])('rejects %j', (asserted, message) => {
    expect(checkAssertedTotals(asserted, computed)).toMatch(message);
  });
});

describe('isChainSeller', () => {
  it('matches seller/creator/event roles only, by did', () => {
    const chain = [
      { did: 'a', role: 'protocol', share: 0.01 },
      { did: 'b', role: 'seller', share: 0.9 },
      { did: 'c', role: 'creator', share: 0.05 },
      { did: 'd', role: 'event', share: 0.04 },
    ];
    expect(isChainSeller(chain, 'b')).toBe(true);
    expect(isChainSeller(chain, 'c')).toBe(true);
    expect(isChainSeller(chain, 'd')).toBe(true);
    expect(isChainSeller(chain, 'a')).toBe(false);
    expect(isChainSeller(chain, 'zzz')).toBe(false);
  });
  it('is false for a missing / non-array chain and tolerates junk entries', () => {
    expect(isChainSeller(undefined, 'a')).toBe(false);
    expect(isChainSeller({}, 'a')).toBe(false);
    expect(isChainSeller([null, 3, { did: 'a' }], 'a')).toBe(false);
  });
});

describe('taxBreakdownOf', () => {
  const TAX = {
    jurisdiction: 'CA-ON',
    kind: 'GST/HST',
    rateBps: 1300,
    basisAmount: 5000,
    amount: 650,
    registrationNumber: '123456789RT0001',
    collectorDid: ISSUER,
    remitTo: AUTHORITY_DID_CA_CRA,
  };

  it('is null when no tax is charged — every consumer renders/emits exactly what it did before', () => {
    expect(taxBreakdownOf({ subtotalAmount: 5000, taxTotalAmount: 0, fairManifest: { chain: [] } })).toBeNull();
    expect(taxBreakdownOf({ subtotalAmount: 5000, taxTotalAmount: 0, fairManifest: { taxes: [] } })).toBeNull();
    expect(taxBreakdownOf({ subtotalAmount: 5000, taxTotalAmount: 0, fairManifest: null })).toBeNull();
  });

  it('returns the public subset (no collector/remit DIDs) when tax is charged', () => {
    expect(taxBreakdownOf({ subtotalAmount: 5000, taxTotalAmount: 650, fairManifest: { taxes: [TAX] } })).toEqual({
      subtotalAmount: 5000,
      taxTotalAmount: 650,
      taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, amount: 650, registrationNumber: '123456789RT0001' }],
    });
  });

  it('keeps a zero-rate row (amount 0) as a line', () => {
    const zero = { ...TAX, rateBps: 0, amount: 0 };
    expect(taxBreakdownOf({ subtotalAmount: 5000, taxTotalAmount: 0, fairManifest: { taxes: [zero] } })?.taxes).toHaveLength(1);
  });

  it('is null for a pre-#2421 row whose backfilled tax_total (0) disagrees with its manifest taxes[] — it keeps rendering as before', () => {
    expect(taxBreakdownOf({ subtotalAmount: 5000, taxTotalAmount: 0, fairManifest: { taxes: [TAX] } })).toBeNull();
  });
});
