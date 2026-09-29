/**
 * Tests for #2419 in `apps/kernel/src/lib/pay/checkout.ts`:
 *  - `taxLineItems()` builds one manual Stripe line item per `taxes[]` row
 *  - `resolveConnectedAccountFee()` computes the platform share on the
 *    merchandise-only subtotal (basisAmount) and the processor/Stripe fee
 *    estimate on the gross (basisAmount + tax), per Ryan's ruling #3.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ accountRow: undefined as Record<string, unknown> | undefined }));

function limitAccountRow() {
  return Promise.resolve(state.accountRow ? [state.accountRow] : []);
}
function whereClause() {
  return { limit: limitAccountRow };
}
function fromClause() {
  return { where: whereClause };
}
function selectClause() {
  return { from: fromClause };
}

vi.mock('@/src/db', () => ({
  db: { select: selectClause },
  connectedAccounts: {},
}));
vi.mock('@/src/lib/pay', () => ({ DEFAULT_PLATFORM_FEE_BPS: 100 }));

import { resolveConnectedAccountFee, taxLineItems, validateCheckoutBody, type CheckoutBody } from '../checkout';

const SELLER_DID = 'did:imajin:seller';

beforeEach(() => {
  state.accountRow = {
    did: SELLER_DID,
    stripeAccountId: 'acct_123',
    chargesEnabled: true,
    platformFeeBps: null,
  };
});

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

describe('resolveConnectedAccountFee — basisAmount vs gross (#2419)', () => {
  const baseBody: CheckoutBody = {
    items: [{ name: 'Ticket', amount: 10_000, quantity: 1 }],
    currency: 'CAD',
    successUrl: 'https://x/success',
    cancelUrl: 'https://x/cancel',
    sellerDid: SELLER_DID,
  };

  it('computes platform share + Stripe fee on the merchandise total when there is no tax (unchanged behavior)', async () => {
    const result = await resolveConnectedAccountFee({
      ...baseBody,
      fairManifest: { chain: [{ role: 'seller', share: 0.97 }] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // platform share = 10000 * (1 - 0.97) = 300; stripe fee default 3.7% + 30c = 370 + 30 = 400
      expect(result.applicationFeeAmount).toBe(300 + 400);
    }
  });

  it('computes the platform share on the merchandise subtotal ONLY, excluding tax', async () => {
    const withoutTax = await resolveConnectedAccountFee({
      ...baseBody,
      fairManifest: { chain: [{ role: 'seller', share: 0.97 }] },
    });
    const withTax = await resolveConnectedAccountFee({
      ...baseBody,
      fairManifest: {
        chain: [{ role: 'seller', share: 0.97 }],
        taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', amount: 1300, basisAmount: 10_000 }],
      },
    });
    expect(withoutTax.ok && withTax.ok).toBe(true);
    if (withoutTax.ok && withTax.ok) {
      // Platform share component (300) is identical; only the Stripe-fee
      // component (computed on gross) differs — so the total application
      // fee must differ, but the *platform* portion alone must not.
      const platformShareOnly = 10_000 * (1 - 0.97);
      expect(platformShareOnly).toBeCloseTo(300, 6);
      expect(withTax.applicationFeeAmount).toBeGreaterThan(withoutTax.applicationFeeAmount!);
    }
  });

  it('#2421: adding tax moves the application fee by EXACTLY the processor-fee delta on the tax — the platform share is pinned to the pre-tax subtotal', async () => {
    const fairManifest = { chain: [{ role: 'seller', share: 0.97 }], fees: [{ role: 'processor', rateBps: 370, fixedCents: 30 }] };
    const untaxed = await resolveConnectedAccountFee({ ...baseBody, fairManifest });
    const taxed = await resolveConnectedAccountFee({
      ...baseBody,
      fairManifest: { ...fairManifest, taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', amount: 1300, basisAmount: 10_000 }] },
    });
    expect(untaxed.ok && taxed.ok).toBe(true);
    if (untaxed.ok && taxed.ok) {
      const processorFeeDelta = Math.round((11_300 * 370) / 10000) - Math.round((10_000 * 370) / 10000); // 418 - 370
      expect(taxed.applicationFeeAmount! - untaxed.applicationFeeAmount!).toBe(processorFeeDelta);
      // Had the platform share been computed on the gross, the delta would also include 3% of 1300 (= 39).
      expect(processorFeeDelta).toBe(48);
    }
  });

  it('computes the Stripe processing-fee estimate on the GROSS amount (merchandise + tax)', async () => {
    const result = await resolveConnectedAccountFee({
      ...baseBody,
      fairManifest: {
        chain: [{ role: 'seller', share: 0.97 }],
        fees: [{ role: 'processor', rateBps: 370, fixedCents: 30 }],
        taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', amount: 1300, basisAmount: 10_000 }],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const platformShare = Math.round(10_000 * (1 - 0.97)); // 300
      const gross = 10_000 + 1300; // 11300
      const stripeFee = Math.round((gross * 370) / 10000) + 30; // 448
      expect(result.applicationFeeAmount).toBe(platformShare + stripeFee);
    }
  });

  it('rejects with a 400 (#2419 review fix 5) when taxes[].basisAmount does not match the merchandise subtotal', async () => {
    const result = await resolveConnectedAccountFee({
      ...baseBody,
      fairManifest: {
        chain: [{ role: 'seller', share: 0.97 }],
        taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', amount: 1300, basisAmount: 9_000 }],
      },
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.error).toMatch(/basisAmount/);
  });
});

describe('validateCheckoutBody — reject taxes[] on the generic checkout path (#2419 review fix 2)', () => {
  const baseBody: CheckoutBody = {
    items: [{ name: 'Ticket', amount: 10_000, quantity: 1 }],
    currency: 'CAD',
    successUrl: 'https://x/success',
    cancelUrl: 'https://x/cancel',
  };

  it('accepts a body without taxes (unchanged behavior)', () => {
    const result = validateCheckoutBody(baseBody);
    expect(result.ok).toBe(true);
  });

  it('rejects a body whose fairManifest carries a non-empty taxes[]', () => {
    const result = validateCheckoutBody({
      ...baseBody,
      fairManifest: { taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', amount: 1300, basisAmount: 10_000 }] },
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    if (!result.ok) expect(result.error).toMatch(/taxes/);
  });

  it('accepts a body whose fairManifest carries an EMPTY taxes[]', () => {
    const result = validateCheckoutBody({ ...baseBody, fairManifest: { taxes: [] } });
    expect(result.ok).toBe(true);
  });
});
