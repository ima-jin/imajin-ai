import type { NextRequest } from 'next/server';
import { requireAppAuth, requireAuth } from '@imajin/auth';
import type { Identity } from '@imajin/auth';
import { db, connectedAccounts } from '@/src/db';
import { eq } from 'drizzle-orm';
import { DEFAULT_PLATFORM_FEE_BPS } from '@/src/lib/pay';
import { processorFeeCents, validateTaxes } from '@imajin/fair';

/** Rail this hosted checkout runs on — keys the `processorFee*` fee-schedule lookup (#2177). */
const CHECKOUT_RAIL = 'stripe';

export interface CheckoutItem {
  name: string;
  description?: string;
  amount: number;
  quantity: number;
  image?: string;
}

export interface CheckoutBody {
  items: CheckoutItem[];
  currency: string;
  mode?: 'payment' | 'subscription';
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fairManifest?: Record<string, any>;
  connectedAccountId?: string;
  sellerDid?: string;
}

export type CheckoutValidation = { ok: true } | { ok: false; error: string; status: number };

const MIN_ITEM_AMOUNT_CENTS = 50; // Stripe minimum
const MAX_ITEM_AMOUNT_CENTS = 99_999_900; // just under $1,000,000
const MAX_ITEM_QUANTITY = 100;

/** Validate an individual checkout line item's amount and quantity bounds. */
function validateCheckoutItem(item: CheckoutItem, index: number): CheckoutValidation {
  if (!Number.isInteger(item.amount) || item.amount <= 0) {
    return { ok: false, error: `items[${index}].amount must be a positive integer`, status: 400 };
  }
  if (item.amount < MIN_ITEM_AMOUNT_CENTS) {
    return { ok: false, error: `items[${index}].amount must be >= 50 (Stripe minimum is 50 cents)`, status: 400 };
  }
  if (item.amount > MAX_ITEM_AMOUNT_CENTS) {
    return { ok: false, error: `items[${index}].amount must be < $1,000,000`, status: 400 };
  }
  if (!Number.isInteger(item.quantity) || item.quantity < 1) {
    return { ok: false, error: `items[${index}].quantity must be a positive integer >= 1`, status: 400 };
  }
  if (item.quantity > MAX_ITEM_QUANTITY) {
    return { ok: false, error: `items[${index}].quantity must be <= 100`, status: 400 };
  }
  return { ok: true };
}

/** Exact `.fair` version a manifest carrying `taxes[]` must declare (#2419/#2439). */
const FAIR_VERSION_WITH_TAXES = '1.2';

function hasTaxRows(fairManifest: CheckoutBody['fairManifest']): boolean {
  const taxes = fairManifest?.taxes;
  return Array.isArray(taxes) && taxes.length > 0;
}

/**
 * #2435: `fair` is `'1.2'` exactly when `taxes[]` is present and non-empty —
 * the same rule `validateManifest` enforces for v1.1+ manifests (this
 * path's share-based `chain` manifest can't go through `validateManifest`
 * itself). A `taxes[]` on any other version, or a `'1.2'` stamp with nothing
 * to justify it, is a 400.
 */
function validateFairVersionForTaxes(fairManifest: CheckoutBody['fairManifest']): CheckoutValidation {
  const hasTaxes = hasTaxRows(fairManifest);
  const fair = fairManifest?.fair;
  if (hasTaxes && fair !== FAIR_VERSION_WITH_TAXES) {
    return { ok: false, error: `fairManifest.fair must be "${FAIR_VERSION_WITH_TAXES}" when taxes[] is present`, status: 400 };
  }
  if (!hasTaxes && fair === FAIR_VERSION_WITH_TAXES) {
    return { ok: false, error: `fairManifest.fair "${FAIR_VERSION_WITH_TAXES}" requires a non-empty taxes[]`, status: 400 };
  }
  return { ok: true };
}

/**
 * #2435: every `taxes[].collectorDid` must be the connected-account seller.
 * Stripe settles this checkout as a destination charge, so the tax money
 * lands in the seller's connected account — recording a trust-liability
 * credit against any other DID would book money that DID never received
 * (the same rule `settle-core.ts`'s `validateFundedTaxCollectors` applies to
 * funded settlements).
 */
function validateTaxCollectors(body: CheckoutBody): CheckoutValidation {
  const taxes = body.fairManifest?.taxes as CheckoutFairTax[];
  const sellerDid = body.sellerDid || body.metadata?.sellerDid;
  if (!sellerDid) {
    return { ok: false, error: 'fairManifest.taxes[] requires sellerDid — tax is collected in trust into the seller\'s connected account', status: 400 };
  }
  const unbacked = taxes.find((tax) => tax.collectorDid !== sellerDid);
  if (unbacked) {
    return { ok: false, error: `fairManifest.taxes[].collectorDid '${unbacked.collectorDid}' must be the seller (${sellerDid}) — Stripe never sends the tax money to any other account`, status: 400 };
  }
  return { ok: true };
}

/**
 * Validate a manifest's `taxes[]` for the generic checkout path (#2435):
 * `fair: '1.2'` exactly, per-row shape/amount rules (shared with
 * `validateManifest`), collector = seller, and every `basisAmount` equal to
 * the merchandise subtotal. A manifest without `taxes[]` always passes.
 */
function validateCheckoutTaxes(body: CheckoutBody): CheckoutValidation {
  const versionCheck = validateFairVersionForTaxes(body.fairManifest);
  if (!versionCheck.ok) return versionCheck;
  if (!hasTaxRows(body.fairManifest)) return { ok: true };

  const rowErrors = validateTaxes(body.fairManifest?.taxes);
  if (rowErrors.length > 0) {
    return { ok: false, error: `fairManifest.${rowErrors.join('; fairManifest.')}`, status: 400 };
  }
  const collectorCheck = validateTaxCollectors(body);
  if (!collectorCheck.ok) return collectorCheck;

  const merchandiseAmount = body.items.reduce((sum, item) => sum + (item.amount * item.quantity), 0);
  const basisCheck = validateTaxesBasis(body.fairManifest, merchandiseAmount);
  return basisCheck.ok ? { ok: true } : { ok: false, error: basisCheck.error, status: 400 };
}

/**
 * Validate the checkout request body: items array shape, per-item bounds,
 * required URLs, and (#2435) any `fairManifest.taxes[]`. `taxes[]` is
 * accepted here because the webhook's settlement
 * (`webhook-handlers.ts`'s `processChainDistribution`) now splits only the
 * pre-tax basis (Stripe total minus Σ`taxes[].amount`) into
 * platform/node/protocol shares and books each tax row as a trust-liability
 * credit, so tax is never fee base. `payment_request` checkout
 * (`payment-requests/checkout.ts`) does NOT go through this validator — it
 * settles via `settlePayment()`.
 */
export function validateCheckoutBody(body: CheckoutBody): CheckoutValidation {
  if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
    return { ok: false, error: 'items array is required', status: 400 };
  }
  if (!body.successUrl || !body.cancelUrl) {
    return { ok: false, error: 'successUrl and cancelUrl are required', status: 400 };
  }
  for (let i = 0; i < body.items.length; i++) {
    const itemResult = validateCheckoutItem(body.items[i], i);
    if (!itemResult.ok) return itemResult;
  }
  return validateCheckoutTaxes(body);
}

/**
 * Resolve the checkout caller's identity, if any: app auth (via `x-app-did`)
 * takes precedence, falling back to a user session. Checkout is allowed to
 * proceed unauthenticated (identity stays null) except when app auth is
 * attempted and fails, which is a hard error.
 */
export async function resolveCheckoutIdentity(
  request: NextRequest,
): Promise<{ ok: true; identity: Identity | null } | { ok: false; error: string; status: number }> {
  if (request.headers.get('x-app-did')) {
    const appResult = await requireAppAuth(request, { scope: 'wallet:write' });
    if ('error' in appResult) {
      return { ok: false, error: appResult.error, status: appResult.status };
    }
    return { ok: true, identity: { id: appResult.appAuth.userDid, scope: 'actor' } };
  }

  const authResult = await requireAuth(request);
  return { ok: true, identity: 'error' in authResult ? null : authResult.identity };
}

export interface ConnectedAccountFeeResult {
  ok: true;
  connectedAccountId: string | undefined;
  applicationFeeAmount: number | undefined;
}
export type ConnectedAccountFeeError = { ok: false; error: string; status: number; code?: string };

interface CheckoutFairTax {
  jurisdiction: string;
  kind: string;
  amount: number;
  basisAmount: number;
  collectorDid?: string;
}

/** Sum of a manifest's `taxes[].amount` (cents). Zero for a manifest without `taxes[]` — fully backward compatible. */
function taxTotalCents(fairManifest: CheckoutBody['fairManifest']): number {
  const taxes = fairManifest?.taxes as CheckoutFairTax[] | undefined;
  return (taxes ?? []).reduce((sum, t) => sum + t.amount, 0);
}

/**
 * Build one manual Stripe line item per `.fair` `taxes[]` row (#2419) —
 * NEVER via Stripe Tax, since each row's `amount` is already computed from
 * the manifest's own `rateBps`/`basisAmount`. Returns `[]` for a manifest
 * without `taxes[]`. A zero-amount row (a 0% rate, or a basis too small to
 * round up to a cent) stays in the manifest but is not sent to Stripe as a
 * zero-priced line item (#2421).
 */
export function taxLineItems(fairManifest: CheckoutBody['fairManifest']): CheckoutItem[] {
  const taxes = fairManifest?.taxes as CheckoutFairTax[] | undefined;
  if (!taxes || taxes.length === 0) return [];
  return taxes.filter((tax) => tax.amount > 0).map((tax) => ({
    name: `${tax.kind} (${tax.jurisdiction})`,
    description: 'Sales tax collected in trust',
    amount: tax.amount,
    quantity: 1,
  }));
}

/**
 * Compute the platform share of a manifest-driven fee, falling back to the
 * account's flat bps rate. `merchandiseAmount` is `body.items`' own total
 * (cents) — the pre-tax subtotal/`basisAmount` (#2419 rule 2: platform
 * fee never sees tax). Callers must never fold a tax line item into
 * `body.items` itself; tax is appended separately via `taxLineItems()`.
 */
function computePlatformShareCents(
  merchandiseAmount: number,
  fairManifest: CheckoutBody['fairManifest'],
  accountPlatformFeeBps: number | null,
): number {
  const sellerEntry = fairManifest?.chain?.find((e: { role: string }) => e.role === 'seller');
  if (sellerEntry) {
    const feeShare = 1 - sellerEntry.share;
    return Math.round(merchandiseAmount * feeShare);
  }
  return Math.round(merchandiseAmount * (accountPlatformFeeBps || DEFAULT_PLATFORM_FEE_BPS) / 10000);
}

/**
 * Compute Stripe processing fees from the manifest's processor entry, or
 * the platform default rate. `grossAmount` (cents) MUST include tax
 * (#2419 rule 3, Ryan-approved 2026-09-28): Stripe's real processing fee
 * applies to the full charged total, and the seller absorbs the fee on
 * the tax portion — consistent with sellers already absorbing this fee on
 * their own share. For a manifest without `taxes[]`, `grossAmount` equals
 * the merchandise total, so this is byte-identical to pre-#2419 behavior.
 */
function computeProcessingFeeCents(grossAmount: number, fairManifest: CheckoutBody['fairManifest']): number {
  const feeEntry = fairManifest?.fees?.find((f: { role: string }) => f.role === 'processor');
  if (feeEntry) {
    return Math.round(grossAmount * feeEntry.rateBps / 10000) + (feeEntry.fixedCents || 0);
  }
  return processorFeeCents(CHECKOUT_RAIL, grossAmount);
}

/**
 * Validate that every `taxes[].basisAmount` equals the merchandise subtotal
 * (#2419 fix, review: "validate basisAmount matches the pre-tax subtotal").
 * A mismatch means the caller computed tax against a different total than
 * what's actually being charged for goods/services — refuse rather than
 * silently using the wrong basis anywhere downstream.
 */
function validateTaxesBasis(
  fairManifest: CheckoutBody['fairManifest'],
  merchandiseAmount: number,
): { ok: true } | { ok: false; error: string } {
  const taxes = fairManifest?.taxes as CheckoutFairTax[] | undefined;
  if (!taxes || taxes.length === 0) return { ok: true };
  for (const tax of taxes) {
    if (tax.basisAmount !== merchandiseAmount) {
      return {
        ok: false,
        error: `fairManifest.taxes[].basisAmount (${tax.basisAmount}) must equal the merchandise subtotal (${merchandiseAmount})`,
      };
    }
  }
  return { ok: true };
}

/**
 * Resolve the connected Stripe account (if a seller DID was supplied) and
 * compute the application fee: platform share (from the .fair manifest or
 * the account's fallback rate) plus processing fees (from the manifest or
 * Stripe defaults). Returns the original `connectedAccountId` unchanged and
 * no fee when there's no seller DID.
 */
export async function resolveConnectedAccountFee(body: CheckoutBody): Promise<ConnectedAccountFeeResult | ConnectedAccountFeeError> {
  const sellerDid = body.sellerDid || body.metadata?.sellerDid;
  if (!sellerDid) {
    return { ok: true, connectedAccountId: body.connectedAccountId, applicationFeeAmount: undefined };
  }

  const [account] = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.did, sellerDid))
    .limit(1);

  if (!account) {
    return { ok: false, error: "Seller hasn't completed payment setup", status: 400, code: 'SELLER_NOT_CONNECTED' };
  }
  if (!account.chargesEnabled) {
    return { ok: false, error: "Seller hasn't completed payment setup", status: 400 };
  }

  // `body.items` is the merchandise-only subtotal/`basisAmount` (#2419) —
  // tax line items are appended separately via `taxLineItems()` at the
  // point the Stripe session is built, never folded into `body.items`.
  const merchandiseAmount = body.items.reduce((sum, item) => sum + (item.amount * item.quantity), 0);

  const basisCheck = validateTaxesBasis(body.fairManifest, merchandiseAmount);
  if (!basisCheck.ok) {
    return { ok: false, error: basisCheck.error, status: 400 };
  }

  const grossAmount = merchandiseAmount + taxTotalCents(body.fairManifest);
  const platformShareCents = computePlatformShareCents(merchandiseAmount, body.fairManifest, account.platformFeeBps);
  const processingFeeCents = computeProcessingFeeCents(grossAmount, body.fairManifest);

  return {
    ok: true,
    connectedAccountId: account.stripeAccountId,
    applicationFeeAmount: platformShareCents + processingFeeCents,
  };
}
