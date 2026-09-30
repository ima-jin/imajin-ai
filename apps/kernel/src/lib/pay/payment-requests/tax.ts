/**
 * Tax for `pay.payment_request` (#2421) — server side.
 *
 * The client (Money tab) may PREVIEW tax, and may even send the amounts it
 * previewed, but nothing it sends is trusted: every `taxes[]` row is
 * rebuilt here from the issuer's own stored registration (number,
 * jurisdiction, kind), the client's `rateBps`, and the server-computed
 * pre-tax subtotal. A client-supplied amount that disagrees with the
 * recomputation is a 400, never silently corrected.
 *
 * Rows are built with `buildFairManifest`'s #2419 tax helper
 * (`packages/fair`), so the stored `FairTax` shape, the `amount =
 * round(basis × rateBps / 10000)` rule and the `fair_manifest.taxes[]`
 * that settle-core's tax silo (#2426) consumes all come from one place.
 * Sums and the `total = subtotal + tax_total` invariant use
 * `packages/money` (integer minor units, no floats).
 */
import { AUTHORITY_DID_CA_CRA, DEFAULT_SELLER_ROLES, buildFairManifest, type FairTax } from '@imajin/fair';
import { add as moneyAdd, equals as moneyEquals, type Money } from '@imajin/money';
import type { TaxRegistration } from '@/src/lib/profile/tax-registrations';
import type { PaymentRequestTaxBreakdown, PaymentRequestTaxLine } from './types';

export type TaxResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** One issuer-chosen tax row as it arrives on the wire (already camel-cased by the route/service). The registration number is deliberately NOT accepted from the client. */
export interface TaxRowInput {
  jurisdiction: string;
  kind: string;
  rateBps: number;
  /** Client-previewed amount (minor units). Optional; validated against the recomputation when present. */
  amount?: number;
}

export interface TaxCharge {
  /** Full `FairTax` rows, ready for `fair_manifest.taxes`. */
  taxes: FairTax[];
  taxTotal: Money;
}

const MAX_TAX_ROWS = 10;
const MAX_RATE_BPS = 10_000;

/** Quebec's revenue authority placeholder — the same `did:imajin:authority:*` creditor-label convention #2419 uses for CRA (see packages/fair `AUTHORITY_DID_CA_CRA`). */
const AUTHORITY_DID_CA_QC_RQ = 'did:imajin:authority:ca-qc-rq';

/**
 * The `taxes[].remitTo` placeholder DID for a jurisdiction + kind — a
 * creditor label only, never a settlement payee. GST/HST is always the
 * federal CRA; QST is Revenu Québec; anything else (PST, VAT) follows the
 * same `did:imajin:authority:<jurisdiction>` shape.
 */
export function remitToFor(jurisdiction: string, kind: string): string {
  if (kind === 'GST/HST') return AUTHORITY_DID_CA_CRA;
  if (kind === 'QST') return AUTHORITY_DID_CA_QC_RQ;
  return `did:imajin:authority:${jurisdiction.toLowerCase()}`;
}

function parseTaxRow(raw: unknown, index: number): TaxResult<TaxRowInput> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `taxes[${index}] must be an object` };
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.jurisdiction !== 'string' || !row.jurisdiction) {
    return { ok: false, error: `taxes[${index}].jurisdiction must be a non-empty string` };
  }
  if (typeof row.kind !== 'string' || !row.kind) {
    return { ok: false, error: `taxes[${index}].kind must be a non-empty string` };
  }
  const rate = row.rate_bps;
  if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 0 || rate > MAX_RATE_BPS) {
    return { ok: false, error: `taxes[${index}].rate_bps must be an integer between 0 and ${MAX_RATE_BPS}` };
  }
  if (row.amount !== undefined && (typeof row.amount !== 'number' || !Number.isInteger(row.amount) || row.amount < 0)) {
    return { ok: false, error: `taxes[${index}].amount must be a non-negative integer (minor units)` };
  }
  return {
    ok: true,
    value: {
      jurisdiction: row.jurisdiction,
      kind: row.kind,
      rateBps: rate,
      ...(typeof row.amount === 'number' ? { amount: row.amount } : {}),
    },
  };
}

/** Validate the wire `taxes` array: non-empty, bounded, no duplicate jurisdiction+kind (one row per charged registration). */
export function parseTaxRowInputs(raw: unknown): TaxResult<TaxRowInput[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'taxes must be a non-empty array when charge_tax is true' };
  }
  if (raw.length > MAX_TAX_ROWS) {
    return { ok: false, error: `taxes must have at most ${MAX_TAX_ROWS} entries` };
  }
  const rows: TaxRowInput[] = [];
  const seen = new Set<string>();
  for (const [index, rawRow] of raw.entries()) {
    const parsed = parseTaxRow(rawRow, index);
    if (!parsed.ok) return parsed;
    const key = `${parsed.value.jurisdiction}|${parsed.value.kind}`;
    if (seen.has(key)) {
      return { ok: false, error: `taxes[${index}] duplicates ${parsed.value.kind} (${parsed.value.jurisdiction})` };
    }
    seen.add(key);
    rows.push(parsed.value);
  }
  return { ok: true, value: rows };
}

/**
 * Rebuild the authoritative `FairTax[]` for `rows`: the registration number
 * comes from the issuer's profile registration (never the client), the
 * collector is the issuer, `basisAmount` is the server-computed pre-tax
 * subtotal, and each `amount` is derived by the #2419 helper — then any
 * client-previewed amount is checked against it.
 */
export function resolveTaxCharge(params: {
  issuerDid: string;
  subtotal: Money;
  registrations: readonly TaxRegistration[];
  rows: TaxRowInput[];
}): TaxResult<TaxCharge> {
  const { issuerDid, subtotal, registrations, rows } = params;

  const inputs = [];
  for (const row of rows) {
    const registration = registrations.find((r) => r.jurisdiction === row.jurisdiction && r.kind === row.kind);
    if (!registration) {
      return { ok: false, error: `issuer has no ${row.kind} tax registration for ${row.jurisdiction} on their business profile` };
    }
    inputs.push({
      jurisdiction: row.jurisdiction,
      kind: row.kind,
      rateBps: row.rateBps,
      registrationNumber: registration.number,
      collectorDid: issuerDid,
      remitTo: remitToFor(row.jurisdiction, row.kind),
    });
  }

  const taxes = buildFairManifest({
    creatorDid: issuerDid,
    contentDid: 'payment_request',
    contentType: 'payment_request',
    taxes: inputs,
    basisAmountCents: subtotal.amount,
  }).taxes ?? [];

  for (const [index, tax] of taxes.entries()) {
    const asserted = rows[index].amount;
    if (asserted !== undefined && asserted !== tax.amount) {
      return {
        ok: false,
        error: `taxes[${index}].amount (${asserted}) does not match the recomputed ${tax.kind} amount (${tax.amount}) — tax is always recomputed from rate_bps and the subtotal`,
      };
    }
  }

  return { ok: true, value: { taxes, taxTotal: sumTaxes(taxes, subtotal.currency) } };
}

/** Σ `taxes[].amount` via `packages/money` — zero for an empty array. */
export function sumTaxes(taxes: ReadonlyArray<{ amount: number }>, currency: string): Money {
  let total: Money = { amount: 0, currency };
  for (const tax of taxes) {
    total = moneyAdd(total, { amount: tax.amount, currency });
  }
  return total;
}

/** Client-asserted totals (all optional). Each one that is present must equal the server's own figure. */
export interface AssertedTotals {
  subtotalAmount?: unknown;
  taxTotalAmount?: unknown;
  totalAmount?: unknown;
}

/** Check whichever of `subtotal_amount` / `tax_total_amount` / `total_amount` the client sent against the server-computed values. Returns an error message, or `null` when consistent. */
export function checkAssertedTotals(
  asserted: AssertedTotals,
  computed: { subtotal: Money; taxTotal: Money; total: Money },
): string | null {
  const checks: Array<[string, unknown, Money]> = [
    ['subtotal_amount', asserted.subtotalAmount, computed.subtotal],
    ['tax_total_amount', asserted.taxTotalAmount, computed.taxTotal],
    ['total_amount', asserted.totalAmount, computed.total],
  ];
  for (const [name, value, expected] of checks) {
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return `${name} must be an integer (minor units)`;
    }
    if (!moneyEquals({ amount: value, currency: expected.currency }, expected)) {
      return `${name} (${value}) does not match the server-computed value (${expected.amount})`;
    }
  }
  return null;
}

/** `total = subtotal + tax_total`, exactly, via `packages/money`. */
export function computeGrandTotal(subtotal: Money, taxTotal: Money): Money {
  return moneyAdd(subtotal, taxTotal);
}

/**
 * True when `did` appears as a seller-role recipient in a `.fair` chain —
 * the same role set (`DEFAULT_SELLER_ROLES`) settle-core's
 * `validateFundedTaxCollectors` requires a tax collector to belong to, so a
 * row that would 400 at settle is caught at create time instead.
 */
export function isChainSeller(chain: unknown, did: string): boolean {
  if (!Array.isArray(chain)) return false;
  return chain.some((entry) => {
    const e = entry as { did?: unknown; role?: unknown } | null;
    return !!e && e.did === did && typeof e.role === 'string' && DEFAULT_SELLER_ROLES.has(e.role);
  });
}

/**
 * The tax breakdown a payment_request row carries, for the pay page,
 * receipt attestations and content hash — `null` when the request charges
 * no tax (so every consumer renders/emits exactly what it did before
 * #2421). Also `null` for a row whose `tax_total_amount` disagrees with its
 * manifest's `taxes[]` (a pre-#2421 custom-manifest row that was backfilled
 * with `tax_total_amount = 0`): it keeps rendering as before rather than
 * showing a half-consistent breakdown.
 */
export function taxBreakdownOf(row: {
  subtotalAmount: number;
  taxTotalAmount: number;
  fairManifest: unknown;
}): PaymentRequestTaxBreakdown | null {
  const manifestTaxes = (row.fairManifest as { taxes?: unknown } | null)?.taxes;
  if (!Array.isArray(manifestTaxes) || manifestTaxes.length === 0) return null;

  const taxes: PaymentRequestTaxLine[] = (manifestTaxes as FairTax[]).map((t) => ({
    jurisdiction: t.jurisdiction,
    kind: t.kind,
    rateBps: t.rateBps,
    amount: t.amount,
    registrationNumber: t.registrationNumber,
  }));
  const sum = taxes.reduce((acc, t) => acc + t.amount, 0);
  if (sum !== row.taxTotalAmount) return null;

  return { subtotalAmount: row.subtotalAmount, taxTotalAmount: row.taxTotalAmount, taxes };
}
