import type { NextRequest } from 'next/server';
import { requireAppAuth, requireAuth } from '@imajin/auth';
import type { Identity } from '@imajin/auth';
import { db, connectedAccounts } from '@/src/db';
import { eq } from 'drizzle-orm';
import { DEFAULT_PLATFORM_FEE_BPS } from '@/src/lib/pay';
import { STRIPE_RATE_BPS, STRIPE_FIXED_CENTS } from '@imajin/fair';

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

/** Validate the checkout request body: items array shape, per-item bounds, and required URLs. */
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
  return { ok: true };
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

/** Compute the platform share of a manifest-driven fee, falling back to the account's flat bps rate. */
function computePlatformShareCents(
  totalAmount: number,
  fairManifest: CheckoutBody['fairManifest'],
  accountPlatformFeeBps: number | null,
): number {
  const sellerEntry = fairManifest?.chain?.find((e: { role: string }) => e.role === 'seller');
  if (sellerEntry) {
    const feeShare = 1 - sellerEntry.share;
    return Math.round(totalAmount * feeShare);
  }
  return Math.round(totalAmount * (accountPlatformFeeBps || DEFAULT_PLATFORM_FEE_BPS) / 10000);
}

/** Compute Stripe processing fees from the manifest's processor entry, or the platform default rate. */
function computeProcessingFeeCents(totalAmount: number, fairManifest: CheckoutBody['fairManifest']): number {
  const feeEntry = fairManifest?.fees?.find((f: { role: string }) => f.role === 'processor');
  if (feeEntry) {
    return Math.round(totalAmount * feeEntry.rateBps / 10000) + (feeEntry.fixedCents || 0);
  }
  return Math.round(totalAmount * STRIPE_RATE_BPS / 10000) + STRIPE_FIXED_CENTS;
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

  const totalAmount = body.items.reduce((sum, item) => sum + (item.amount * item.quantity), 0);
  const platformShareCents = computePlatformShareCents(totalAmount, body.fairManifest, account.platformFeeBps);
  const processingFeeCents = computeProcessingFeeCents(totalAmount, body.fairManifest);

  return {
    ok: true,
    connectedAccountId: account.stripeAccountId,
    applicationFeeAmount: platformShareCents + processingFeeCents,
  };
}
