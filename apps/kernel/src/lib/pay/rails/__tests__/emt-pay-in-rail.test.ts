/**
 * Unit tests for the Interac e-Transfer pay-in rail (#2665) and its place in
 * the rail registry. The rail is a pure adapter, so nothing here is mocked —
 * except `@/src/db`, which the registry's withdraw (Stripe) entry pulls in
 * transitively (see `registry.test.ts`).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/src/db', () => ({ db: {}, balances: {}, transactions: {}, withdrawalIntents: {} }));

import { EmtPayInRail, EMT_RAIL_NAME } from '../emt-pay-in-rail';
import {
  getPayInRail,
  getPayInRailForCurrency,
  listPayInRails,
  listRegisteredRails,
  getWithdrawRailByName,
} from '../registry';

const REQUEST = { reference: 'INV-0123456789', amountMinor: 5000, currency: 'CAD' };

describe('EmtPayInRail', () => {
  const rail = new EmtPayInRail();

  it("is the manual 'emt' rail — a human confirms receipt, there is no webhook", () => {
    expect(rail.name).toBe('emt');
    expect(EMT_RAIL_NAME).toBe('emt');
    expect(rail.confirmation).toBe('manual');
    expect(rail.currencies).toEqual(['CAD']);
  });

  it('collects CAD only, case-insensitively', () => {
    expect(rail.supportsCurrency('CAD')).toBe(true);
    expect(rail.supportsCurrency('cad')).toBe(true);
    expect(rail.supportsCurrency('USD')).toBe(false);
  });

  describe('instructionsFor', () => {
    it('returns the destination, exact minor-unit amount, currency and the reference to quote', () => {
      expect(rail.instructionsFor(REQUEST, 'payments@acme.example')).toEqual({
        rail: 'emt',
        destination: 'payments@acme.example',
        amountMinor: 5000,
        currency: 'CAD',
        reference: 'INV-0123456789',
      });
    });

    it('trims the destination and upper-cases the currency', () => {
      expect(rail.instructionsFor({ ...REQUEST, currency: 'cad' }, '  payments@acme.example  ')).toMatchObject({
        destination: 'payments@acme.example',
        currency: 'CAD',
      });
    });

    it('refuses a blank destination, a blank reference, a non-CAD currency and a non-integer / non-positive amount', () => {
      expect(() => rail.instructionsFor(REQUEST, '   ')).toThrow(/receiving email/);
      expect(() => rail.instructionsFor({ ...REQUEST, reference: ' ' }, 'a@b.ca')).toThrow(/reference/);
      expect(() => rail.instructionsFor({ ...REQUEST, currency: 'USD' }, 'a@b.ca')).toThrow(/currency/);
      expect(() => rail.instructionsFor({ ...REQUEST, amountMinor: 19.99 }, 'a@b.ca')).toThrow(/integer/);
      expect(() => rail.instructionsFor({ ...REQUEST, amountMinor: 0 }, 'a@b.ca')).toThrow(/positive/);
      expect(() => rail.instructionsFor({ ...REQUEST, amountMinor: -5 }, 'a@b.ca')).toThrow(/positive/);
    });
  });

  describe('settlementFees — no processor fee on an e-Transfer', () => {
    const stripeProcessor = { role: 'processor', rateBps: 370, fixedCents: 30 };

    it("replaces the manifest's (Stripe) processor entry with a zero-fee one", () => {
      expect(rail.settlementFees([stripeProcessor])).toEqual([{ role: 'processor', rateBps: 0, fixedCents: 0 }]);
    });

    it('keeps every non-processor fee untouched and in order', () => {
      const platform = { role: 'platform', rateBps: 100, fixedCents: 0 };
      expect(rail.settlementFees([platform, stripeProcessor])).toEqual([
        platform,
        { role: 'processor', rateBps: 0, fixedCents: 0 },
      ]);
    });

    it('supplies the zero-fee processor entry even when the manifest has no fees at all', () => {
      expect(rail.settlementFees(undefined)).toEqual([{ role: 'processor', rateBps: 0, fixedCents: 0 }]);
      expect(rail.settlementFees([])).toEqual([{ role: 'processor', rateBps: 0, fixedCents: 0 }]);
    });

    it('does not mutate the manifest fees it is given', () => {
      const fees = [stripeProcessor];
      rail.settlementFees(fees);
      expect(fees).toEqual([{ role: 'processor', rateBps: 370, fixedCents: 30 }]);
    });
  });
});

describe('pay-in rail registry (#2665)', () => {
  it('resolves the EMT rail by name, as a stable singleton', () => {
    const rail = getPayInRail('emt');
    expect(rail?.name).toBe('emt');
    expect(getPayInRail('emt')).toBe(rail);
  });

  it('returns null for an unregistered pay-in rail — stripe is a withdraw rail here, not a pay-in one', () => {
    expect(getPayInRail('does-not-exist')).toBeNull();
    expect(getPayInRail('stripe')).toBeNull();
  });

  it('getPayInRailForCurrency only resolves a rail that can collect the currency', () => {
    expect(getPayInRailForCurrency('emt', 'CAD')?.name).toBe('emt');
    expect(getPayInRailForCurrency('emt', 'USD')).toBeNull();
    expect(getPayInRailForCurrency('nope', 'CAD')).toBeNull();
  });

  it('listPayInRails returns every registered pay-in rail', () => {
    expect(listPayInRails().map((r) => r.name)).toEqual(['emt']);
  });

  it('does NOT leak into the withdraw registry — the reconciliation sweep must never call execute()/list() on EMT', () => {
    expect(listRegisteredRails().map((r) => r.name)).not.toContain('emt');
    expect(getWithdrawRailByName('emt')).toBeNull();
  });
});
