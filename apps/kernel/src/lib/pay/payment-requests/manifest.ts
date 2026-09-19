/**
 * `.fair` manifest handling for `pay.payment_request` (#2206/#2208).
 *
 * `fair_manifest` is REQUIRED on every payment_request. When the caller
 * supplies none, `POST /pay/api/payment-requests` builds a default
 * single-payee manifest (one payee, one customer) via the existing
 * `buildFairManifest` helper (`@imajin/fair`) — the same helper
 * `apps/market`'s listing-create route and `apps/kernel`'s supply
 * settlement path already use to build a seller-share fee manifest at
 * creation time (see `apps/market/app/api/listings/route.ts` and
 * `apps/kernel/src/lib/quickbooks/settlement.ts`).
 *
 * `buildFairManifest`'s output describes the split as fractional `share`s
 * (protocol/node/buyer_credit/platform/seller), not absolute amounts —
 * consistent with how every other `fairManifest` column in this codebase
 * is populated at creation time (checkout, listings, supply). It carries
 * no `total` of its own, so this module tacks one on (`{ amount, currency }`,
 * a `packages/money` `Money` value) purely so a caller-supplied custom
 * manifest can be validated against the request's own computed total —
 * per #2208's "reject the request when the manifest total != the request
 * total" requirement.
 */
import { buildFairManifest } from '@imajin/fair';
import { equals as moneyEquals, type Money } from '@imajin/money';
import type { PaymentRequestFairManifest } from './types';

/** Build the default single-payee manifest: one payee (the issuer/payee account), one customer. */
export function buildDefaultPaymentRequestManifest(params: {
  payeeAccount: string;
  paymentRequestId: string;
  total: Money;
}): PaymentRequestFairManifest {
  const manifest = buildFairManifest({
    creatorDid: params.payeeAccount,
    contentDid: params.paymentRequestId,
    contentType: 'payment_request',
  });
  return { ...manifest, total: { amount: params.total.amount, currency: params.total.currency } };
}

export type ManifestValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Validate a caller-supplied `fair_manifest`: it must be an object carrying
 * a `total: { amount, currency }` Money value equal to the request's own
 * computed total — a manifest silently describing a different total than
 * the line items sum to would let the split diverge from what the payer
 * actually owes.
 */
export function validateCustomPaymentRequestManifest(
  manifest: unknown,
  requestTotal: Money,
): ManifestValidationResult {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, error: 'fair_manifest must be an object' };
  }
  const candidate = manifest as { total?: unknown };
  const total = candidate.total;
  if (
    !total ||
    typeof total !== 'object' ||
    typeof (total as Money).amount !== 'number' ||
    typeof (total as Money).currency !== 'string'
  ) {
    return { ok: false, error: 'fair_manifest.total must be { amount: number, currency: string }' };
  }
  if (!moneyEquals(total as Money, requestTotal)) {
    return {
      ok: false,
      error: `fair_manifest.total (${(total as Money).amount} ${(total as Money).currency}) does not match the request total (${requestTotal.amount} ${requestTotal.currency})`,
    };
  }
  return { ok: true };
}
