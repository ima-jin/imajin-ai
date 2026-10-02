/**
 * Unit tests for `validateChain` in settle-core.ts, including the #2419
 * widened invariant for trust-liability tax credits. `validateChain`
 * itself is a pure function, but `settle-core.ts` connects to a real
 * Postgres client at module load time (`@/src/db`), so every dependency
 * it pulls in transitively is mocked below — same pattern as
 * `app/pay/api/settle/__tests__/route.test.ts`, which exercises the full
 * `settlePayment()` transaction path this file does not.
 */
import { describe, it, expect, vi } from 'vitest';

function limitEmpty() {
  return Promise.resolve([]);
}
function whereClause() {
  return { limit: limitEmpty };
}
function fromClause() {
  return { where: whereClause };
}
function selectClause() {
  return { from: fromClause };
}

vi.mock('@/src/db', () => ({
  db: { select: selectClause, transaction: vi.fn() },
  balances: {},
  transactions: {},
  identities: {},
  identityChains: {},
}));
vi.mock('@imajin/fair', () => ({ verifyManifest: vi.fn().mockResolvedValue({ valid: true }) }));
vi.mock('@imajin/auth/resolve-db', () => ({ createDbResolver: () => async () => 'fake-public-key' }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
vi.mock('@/src/lib/fair/intro-attribution', () => ({
  verifyIntroAttributionManifestForSettlement: vi.fn().mockResolvedValue({ ok: true }),
}));

import { validateChain } from '../settle-core';

const CHAIN = [{ did: 'did:imajin:seller', amount: 100, role: 'seller' }];

describe('validateChain — pre-#2419 behavior (no taxCredits)', () => {
  it('accepts a chain that sums to total_amount', () => {
    const result = validateChain(CHAIN, 100);
    expect(result).toMatchObject({ chainTotal: 100, taxTotal: 0 });
  });

  it('rejects a chain that does not sum to total_amount', () => {
    const result = validateChain(CHAIN, 50);
    expect('error' in result).toBe(true);
  });

  it('rejects a non-array chain', () => {
    const result = validateChain(null, 100);
    expect('error' in result).toBe(true);
  });

  it('rejects a chain item missing did/amount/role', () => {
    const result = validateChain([{ amount: 100, role: 'seller' }], 100);
    expect('error' in result).toBe(true);
  });
});

describe('validateChain — #2419 taxCredits invariant', () => {
  const TAX_CREDIT = {
    did: 'did:imajin:seller',
    amount: 13,
    jurisdiction: 'CA-ON',
    kind: 'GST/HST',
    rateBps: 1300,
    remitTo: 'did:imajin:authority:ca-cra',
    registrationNumber: '123456789RT0001',
  };

  it('accepts chain + taxCredits summing to total_amount', () => {
    const result = validateChain(CHAIN, 113, [TAX_CREDIT]);
    expect(result).toMatchObject({ chainTotal: 100, taxTotal: 13 });
  });

  it('rejects when chain + taxCredits does not match total_amount', () => {
    const result = validateChain(CHAIN, 100, [TAX_CREDIT]);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/tax total/);
    }
  });

  it('rejects a taxCredits entry missing a required field', () => {
    const missingJurisdiction = { did: TAX_CREDIT.did, amount: TAX_CREDIT.amount, kind: TAX_CREDIT.kind, rateBps: TAX_CREDIT.rateBps, remitTo: TAX_CREDIT.remitTo, registrationNumber: TAX_CREDIT.registrationNumber };
    const result = validateChain(CHAIN, 113, [missingJurisdiction]);
    expect('error' in result).toBe(true);
  });

  describe('registrationNumber is required end-to-end (#2439)', () => {
    it('rejects a taxCredits entry with no registrationNumber', () => {
      const result = validateChain(CHAIN, 113, [{ ...TAX_CREDIT, registrationNumber: undefined }]);
      expect(result).toMatchObject({ status: 400 });
      if ('error' in result) expect(result.error).toMatch(/registrationNumber/);
    });

    it('rejects an empty-string registrationNumber', () => {
      const result = validateChain(CHAIN, 113, [{ ...TAX_CREDIT, registrationNumber: '' }]);
      expect(result).toMatchObject({ status: 400 });
      if ('error' in result) expect(result.error).toMatch(/registrationNumber/);
    });

    it('rejects a non-string registrationNumber', () => {
      const result = validateChain(CHAIN, 113, [{ ...TAX_CREDIT, registrationNumber: 123456789 }]);
      expect(result).toMatchObject({ status: 400 });
    });

    it('rejects when only one of several credits lacks a registrationNumber', () => {
      const second = { ...TAX_CREDIT, jurisdiction: 'CA-QC', kind: 'QST', amount: 10, registrationNumber: '' };
      const result = validateChain(CHAIN, 123, [TAX_CREDIT, second]);
      expect(result).toMatchObject({ status: 400 });
    });
  });

  it('rejects a non-array taxCredits', () => {
    const result = validateChain(CHAIN, 100, { not: 'an array' });
    expect('error' in result).toBe(true);
  });

  it('treats undefined taxCredits identically to omitted (backward compatible)', () => {
    const withUndefined = validateChain(CHAIN, 100, undefined);
    const withoutArg = validateChain(CHAIN, 100);
    expect(withUndefined).toEqual(withoutArg);
  });

  it('supports multiple tax credits summing correctly', () => {
    const secondCredit = { ...TAX_CREDIT, jurisdiction: 'CA-QC', kind: 'QST', amount: 10 };
    const result = validateChain(CHAIN, 123, [TAX_CREDIT, secondCredit]);
    expect(result).toMatchObject({ chainTotal: 100, taxTotal: 23 });
  });

  it('accepts a zero-amount tax credit (e.g. rateBps: 0, which validate.ts already allows)', () => {
    const zeroCredit = { ...TAX_CREDIT, amount: 0 };
    const result = validateChain(CHAIN, 100, [zeroCredit]);
    expect(result).toMatchObject({ chainTotal: 100, taxTotal: 0 });
  });

  it('rejects a string amount (#2419 review fix 4) instead of silently doing string concatenation', () => {
    const stringAmountCredit = { ...TAX_CREDIT, amount: '13' as unknown as number };
    const result = validateChain(CHAIN, 113, [stringAmountCredit]);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/finite number/);
  });

  it('rejects a NaN amount (#2419 review fix 4) instead of silently passing the tolerance check', () => {
    const nanCredit = { ...TAX_CREDIT, amount: Number.NaN };
    const result = validateChain(CHAIN, 113, [nanCredit]);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/finite number/);
  });

  it('rejects a negative amount (#2419 review fix 4)', () => {
    const negativeCredit = { ...TAX_CREDIT, amount: -13 };
    const result = validateChain(CHAIN, 87, [negativeCredit]);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/finite number/);
  });

  it('rejects an Infinity amount (#2419 review fix 4)', () => {
    const infiniteCredit = { ...TAX_CREDIT, amount: Number.POSITIVE_INFINITY };
    const result = validateChain(CHAIN, 113, [infiniteCredit]);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/finite number/);
  });
});
