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
import { buildFairManifest, type FairTax } from '@imajin/fair';
import { equals as moneyEquals, type Money } from '@imajin/money';
import { isChainSeller } from './tax';
import type { PaymentRequestFairManifest } from './types';

/** `.fair` version stamped on a manifest that carries `taxes[]` (#2419). */
export const FAIR_VERSION_WITH_TAXES = '1.2';

/**
 * Build the default single-payee manifest: one payee (the issuer/payee
 * account), one customer. `total` is the PRE-TAX subtotal; when `taxes` is
 * supplied (#2421) the rows ride along as `taxes[]` (built against that same
 * subtotal by `resolveTaxCharge`) and `fair` is set to `'1.2'`.
 */
export function buildDefaultPaymentRequestManifest(params: {
  payeeAccount: string;
  paymentRequestId: string;
  total: Money;
  taxes?: FairTax[];
}): PaymentRequestFairManifest {
  const manifest = buildFairManifest({
    creatorDid: params.payeeAccount,
    contentDid: params.paymentRequestId,
    contentType: 'payment_request',
  });
  const taxes = params.taxes ?? [];
  return {
    ...manifest,
    total: { amount: params.total.amount, currency: params.total.currency },
    ...(taxes.length > 0 ? { taxes, version: '0.5.0', fair: FAIR_VERSION_WITH_TAXES } : {}),
  };
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
 *
 * #2439 item 2: the row's `collectorDid` must be a seller in the manifest's
 * `chain` (`chain` is the manifest's own `chain`). Settlement credits tax
 * to the collector and 400s when it isn't a chain seller — by which point
 * the buyer has already paid through Stripe — so it is refused here, at
 * create time, before any charge.
 */
function validateCustomManifestTaxRow(tax: unknown, i: number, requestTotal: Money, chain: unknown): string | null {
  if (!tax || typeof tax !== 'object') return `fair_manifest.taxes[${i}] must be an object`;
  const shapeError = validateTaxRowShape(tax as Record<string, unknown>, i);
  if (shapeError) return shapeError;
  return validateTaxRowSemantics(tax as ShapedTaxRow, i, requestTotal, chain);
}

/** Required `taxes[]` row fields, in the order they are reported. */
const TAX_ROW_FIELDS: ReadonlyArray<readonly [string, 'string' | 'integer']> = [
  ['jurisdiction', 'string'],
  ['kind', 'string'],
  ['rateBps', 'integer'],
  ['basisAmount', 'integer'],
  ['amount', 'integer'],
  ['collectorDid', 'string'],
  ['remitTo', 'string'],
  ['registrationNumber', 'string'],
];

interface ShapedTaxRow {
  collectorDid: string;
  basisAmount: number;
  rateBps: number;
  amount: number;
}

function isFieldValid(value: unknown, type: 'string' | 'integer'): boolean {
  if (type === 'string') return typeof value === 'string' && value.length > 0;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Presence/type of every required `taxes[]` field. */
function validateTaxRowShape(t: Record<string, unknown>, i: number): string | null {
  for (const [field, type] of TAX_ROW_FIELDS) {
    if (!isFieldValid(t[field], type)) {
      const expected = type === 'string' ? 'a non-empty string' : 'a non-negative integer';
      return `fair_manifest.taxes[${i}].${field} must be ${expected}`;
    }
  }
  return null;
}

/** Cross-field rules on a shape-valid row: collector is a chain seller (#2439 item 2), basis = request subtotal, amount ≈ basis × rate. */
function validateTaxRowSemantics(t: ShapedTaxRow, i: number, requestTotal: Money, chain: unknown): string | null {
  if (!isChainSeller(chain, t.collectorDid)) {
    return `fair_manifest.taxes[${i}].collectorDid (${t.collectorDid}) must be a seller in fair_manifest.chain`;
  }
  if (t.basisAmount !== requestTotal.amount) {
    return `fair_manifest.taxes[${i}].basisAmount (${t.basisAmount}) must equal the request total (${requestTotal.amount})`;
  }
  const expected = Math.round((t.basisAmount * t.rateBps) / 10000);
  if (Math.abs(expected - t.amount) > TAX_AMOUNT_TOLERANCE_CENTS) {
    return `fair_manifest.taxes[${i}].amount (${t.amount}) does not match basisAmount × rateBps / 10000 (${expected})`;
  }
  return null;
}

/** Validate the optional `fair_manifest.taxes[]` field on a custom manifest. `undefined` is valid (no tax). */
function validateCustomManifestTaxes(taxes: unknown, requestTotal: Money, chain: unknown): string | null {
  if (taxes === undefined) return null;
  if (!Array.isArray(taxes)) return 'fair_manifest.taxes must be an array';
  for (let i = 0; i < taxes.length; i++) {
    const error = validateCustomManifestTaxRow(taxes[i], i, requestTotal, chain);
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
 * `packages/fair`'s `validate.ts` validates a `.fair` manifest's `taxes[]`,
 * plus the create-time collector-is-a-chain-seller check (#2439 item 2).
 *
 * `requestTotal` is the request's PRE-TAX subtotal (`subtotal_amount`) — the
 * same value `fair_manifest.total` and every `taxes[].basisAmount` carry.
 */
export function validateCustomPaymentRequestManifest(
  manifest: unknown,
  requestTotal: Money,
): ManifestValidationResult {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, error: 'fair_manifest must be an object' };
  }
  const candidate = manifest as { total?: unknown; taxes?: unknown; chain?: unknown };
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
  const taxesError = validateCustomManifestTaxes(candidate.taxes, requestTotal, candidate.chain);
  if (taxesError) return { ok: false, error: taxesError };
  return { ok: true };
}
