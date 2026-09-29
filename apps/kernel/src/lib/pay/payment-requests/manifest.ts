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

// #2419 fix (review): rounding tolerance (cents) for `taxes[].amount ≈ basisAmount × rateBps / 10000`.
const TAX_AMOUNT_TOLERANCE_CENTS = 1;

/**
 * Validate a single `fair_manifest.taxes[]` row on a caller-supplied custom
 * manifest (#2419 fix, review: "validate `basisAmount` matches the pre-tax
 * subtotal" — the issue's own requirement, previously unenforced here).
 * `requestTotal` is the payment_request's own pre-tax line-items total (the
 * same `Money` `fair_manifest.total` must already equal), which is exactly
 * what `taxes[].basisAmount` must match — tax is added on top of it, never
 * folded into `total`.
 */
function validateCustomManifestTaxRow(tax: unknown, i: number, requestTotal: Money): string | null {
  if (!tax || typeof tax !== 'object') return `fair_manifest.taxes[${i}] must be an object`;
  const t = tax as Record<string, unknown>;
  if (typeof t.jurisdiction !== 'string' || !t.jurisdiction) return `fair_manifest.taxes[${i}].jurisdiction must be a non-empty string`;
  if (typeof t.kind !== 'string' || !t.kind) return `fair_manifest.taxes[${i}].kind must be a non-empty string`;
  if (typeof t.rateBps !== 'number' || !Number.isInteger(t.rateBps) || t.rateBps < 0) return `fair_manifest.taxes[${i}].rateBps must be a non-negative integer`;
  if (typeof t.basisAmount !== 'number' || !Number.isInteger(t.basisAmount) || t.basisAmount < 0) return `fair_manifest.taxes[${i}].basisAmount must be a non-negative integer`;
  if (typeof t.amount !== 'number' || !Number.isInteger(t.amount) || t.amount < 0) return `fair_manifest.taxes[${i}].amount must be a non-negative integer`;
  if (typeof t.collectorDid !== 'string' || !t.collectorDid) return `fair_manifest.taxes[${i}].collectorDid must be a non-empty string`;
  if (typeof t.remitTo !== 'string' || !t.remitTo) return `fair_manifest.taxes[${i}].remitTo must be a non-empty string`;
  if (typeof t.registrationNumber !== 'string' || !t.registrationNumber) return `fair_manifest.taxes[${i}].registrationNumber must be a non-empty string`;

  if (typeof t.basisAmount === 'number' && t.basisAmount !== requestTotal.amount) {
    return `fair_manifest.taxes[${i}].basisAmount (${t.basisAmount}) must equal the request total (${requestTotal.amount})`;
  }
  if (typeof t.basisAmount === 'number' && typeof t.rateBps === 'number' && typeof t.amount === 'number') {
    const expected = Math.round((t.basisAmount * t.rateBps) / 10000);
    if (Math.abs(expected - t.amount) > TAX_AMOUNT_TOLERANCE_CENTS) {
      return `fair_manifest.taxes[${i}].amount (${t.amount}) does not match basisAmount × rateBps / 10000 (${expected})`;
    }
  }
  return null;
}

/** Validate the optional `fair_manifest.taxes[]` field on a custom manifest. `undefined` is valid (no tax). */
function validateCustomManifestTaxes(taxes: unknown, requestTotal: Money): string | null {
  if (taxes === undefined) return null;
  if (!Array.isArray(taxes)) return 'fair_manifest.taxes must be an array';
  for (let i = 0; i < taxes.length; i++) {
    const error = validateCustomManifestTaxRow(taxes[i], i, requestTotal);
    if (error) return error;
  }
  return null;
}

/**
 * Validate a caller-supplied `fair_manifest`: it must be an object carrying
 * a `total: { amount, currency }` Money value equal to the request's own
 * computed total — a manifest silently describing a different total than
 * the line items sum to would let the split diverge from what the payer
 * actually owes. When present, `taxes[]` is validated the same way
 * `packages/fair`'s `validate.ts` validates a `.fair` manifest's `taxes[]`.
 */
export function validateCustomPaymentRequestManifest(
  manifest: unknown,
  requestTotal: Money,
): ManifestValidationResult {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, error: 'fair_manifest must be an object' };
  }
  const candidate = manifest as { total?: unknown; taxes?: unknown };
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
  const taxesError = validateCustomManifestTaxes(candidate.taxes, requestTotal);
  if (taxesError) return { ok: false, error: taxesError };
  return { ok: true };
}
