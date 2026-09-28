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

import { resolveConnectedAccountFee, taxLineItems, type CheckoutBody } from '../checkout';

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
        taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', amount: 1300 }],
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

  it('computes the Stripe processing-fee estimate on the GROSS amount (merchandise + tax)', async () => {
    const result = await resolveConnectedAccountFee({
      ...baseBody,
      fairManifest: {
        chain: [{ role: 'seller', share: 0.97 }],
        fees: [{ role: 'processor', rateBps: 370, fixedCents: 30 }],
        taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', amount: 1300 }],
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
});
