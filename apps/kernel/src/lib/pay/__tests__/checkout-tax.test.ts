/**
 * Tests for #2419 / #2435 in `apps/kernel/src/lib/pay/checkout.ts`:
 *  - `taxLineItems()` builds one manual Stripe line item per `taxes[]` row
 *  - `validateCheckoutBody()` validates `taxes[]` on the generic checkout path
 *
 * (The Connect `resolveConnectedAccountFee` fee computation these used to
 * cover is gone with Stripe Connect, #2757.)
 */
import { describe, it, expect, vi } from 'vitest';

// `checkout.ts` -> `app-settle.ts` -> `@/src/db`, which builds a real DB client at import time unless stubbed.
vi.mock('@/src/db', () => ({ db: {}, registryApps: {}, transactions: {} }));

import { taxLineItems, validateCheckoutBody, type CheckoutBody } from '../checkout';

const SELLER_DID = 'did:imajin:seller';

describe('taxLineItems', () => {
  it('returns [] for a manifest without taxes', () => {
    expect(taxLineItems(undefined)).toEqual([]);
    expect(taxLineItems({})).toEqual([]);
  });

  it('builds one manual line item per tax row, labeled with kind + jurisdiction', () => {
    const items = taxLineItems({
      taxes: [
        { jurisdiction: 'CA-ON', kind: 'GST/HST', amount: 1300 },
        { jurisdiction: 'CA-QC', kind: 'QST', amount: 998 },
      ],
    });
    expect(items).toEqual([
      { name: 'GST/HST (CA-ON)', description: 'Sales tax collected in trust', amount: 1300, quantity: 1 },
      { name: 'QST (CA-QC)', description: 'Sales tax collected in trust', amount: 998, quantity: 1 },
    ]);
  });
});

describe('taxLineItems — zero-amount rows (#2421)', () => {
  it('does not send a zero-priced line item to Stripe (a 0% row, or a basis too small to round up to a cent)', () => {
    const items = taxLineItems({
      taxes: [
        { jurisdiction: 'CA-BC', kind: 'GST/HST', amount: 0 },
        { jurisdiction: 'CA-BC', kind: 'PST', amount: 1400 },
      ],
    });
    expect(items).toEqual([{ name: 'PST (CA-BC)', description: 'Sales tax collected in trust', amount: 1400, quantity: 1 }]);
    expect(taxLineItems({ taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', amount: 0 }] })).toEqual([]);
  });
});

describe('validateCheckoutBody — taxes[] on the generic checkout path (#2435)', () => {
  const taxRow = {
    jurisdiction: 'CA-ON',
    kind: 'GST/HST',
    rateBps: 1300,
    basisAmount: 10_000,
    amount: 1300,
    registrationNumber: '123456789RT0001',
    collectorDid: SELLER_DID,
    remitTo: 'did:imajin:authority:ca-cra',
  };
  const baseBody: CheckoutBody = {
    items: [{ name: 'Ticket', amount: 10_000, quantity: 1 }],
    currency: 'CAD',
    successUrl: 'https://x/success',
    cancelUrl: 'https://x/cancel',
    sellerDid: SELLER_DID,
  };
  const taxedBody = (overrides: Record<string, unknown> = {}): CheckoutBody => ({
    ...baseBody,
    fairManifest: { fair: '1.2', chain: [{ role: 'seller', share: 0.97 }], taxes: [taxRow], ...overrides },
  });

  it('accepts a body without taxes (unchanged behavior)', () => {
    const result = validateCheckoutBody(baseBody);
    expect(result.ok).toBe(true);
  });

  it('no longer rejects a well-formed taxes[] (the #2426 400 is lifted)', () => {
    expect(validateCheckoutBody(taxedBody())).toEqual({ ok: true });
  });

  it('accepts a body whose fairManifest carries an EMPTY taxes[] and no 1.2 stamp', () => {
    const result = validateCheckoutBody({ ...baseBody, fairManifest: { taxes: [] } });
    expect(result.ok).toBe(true);
  });

  it.each([undefined, '1.0', '1.1', '1.20'])('rejects taxes[] when fair is %s — it must be exactly "1.2"', (fair) => {
    const result = validateCheckoutBody(taxedBody({ fair }));
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.error).toMatch(/fair must be "1.2"/);
  });

  it('rejects a "1.2" stamp with no taxes[] to justify it', () => {
    const result = validateCheckoutBody({ ...baseBody, fairManifest: { fair: '1.2', chain: [] } });
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.error).toMatch(/requires a non-empty taxes/);
  });

  it('rejects a malformed tax row using the shared .fair taxes[] rules', () => {
    const result = validateCheckoutBody(taxedBody({ taxes: [{ ...taxRow, registrationNumber: '' }] }));
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.error).toMatch(/registrationNumber/);
  });

  it('rejects a tax amount that does not match basisAmount × rateBps', () => {
    const result = validateCheckoutBody(taxedBody({ taxes: [{ ...taxRow, amount: 1 }] }));
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.error).toMatch(/does not match basisAmount/);
  });

  it('rejects a basisAmount that is not the merchandise subtotal', () => {
    const result = validateCheckoutBody(taxedBody({ taxes: [{ ...taxRow, basisAmount: 9_000, amount: 1170 }] }));
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.error).toMatch(/merchandise subtotal/);
  });

  it('rejects taxes[] without a sellerDid (no seller account to hold the tax in trust)', () => {
    const result = validateCheckoutBody({ ...taxedBody(), sellerDid: undefined });
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.error).toMatch(/requires sellerDid/);
  });

  it('rejects a collectorDid that is not the seller', () => {
    const result = validateCheckoutBody(taxedBody({ taxes: [{ ...taxRow, collectorDid: 'did:imajin:someone-else' }] }));
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.error).toMatch(/collectorDid/);
  });
});
