/**
 * `pay.payment_request` write/read model (#2206/#2207/#2208).
 *
 * Route handlers under `apps/kernel/app/pay/api/payment-requests/**` own
 * HTTP concerns (auth, request parsing, response mapping) only — the
 * validation, manifest defaulting, content-hash computation, attestation
 * emission, and bus publishing all live here, mirroring the
 * route/lib split already used for `/api/settle` (`settle-core.ts`) and
 * `/usage/api/billed` (`lib/usage/billed/manual.ts`).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, paymentRequests, profiles } from '@/src/db';
import type { PaymentRequest, PaymentRequestKind } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { publish } from '@imajin/bus';
import { add as moneyAdd, type Money } from '@imajin/money';
import { isConnected } from '@/src/lib/chat/connection-check';
import { createPaymentRequestInvite } from '@/src/lib/connections/payment-request-invite';
import type { TaxRegistration } from '@/src/lib/profile/tax-registrations';
import { computePaymentRequestContentHash } from './content-hash';
import { emtOptionOf, type EmtPayOption } from './emt-offer';
import { resolveCardRail } from './card-rail';
import { invoiceNumberOf, issuerAddressOf, publicSettlementOf, type PublicSettlement } from './invoice';
import { payingDidOf } from './settlement-payer';
import {
  FAIR_VERSION_WITH_TAXES,
  buildDefaultPaymentRequestManifest,
  validateCustomPaymentRequestManifest,
} from './manifest';
import { emitPaymentRequestIssuedAttestation, emitPaymentRequestSettledAttestation } from './attestations';
import {
  checkAssertedTotals,
  computeGrandTotal,
  parseTaxRowInputs,
  resolveTaxCharge,
  sumTaxes,
  taxBreakdownOf,
} from './tax';
import type {
  PaymentRequestFairManifest,
  PaymentRequestLineItem,
  PaymentRequestSettlementRef,
  PaymentRequestTaxLine,
} from './types';

/** `code` (#2754) is a stable machine-readable reason the pay page maps to a specific message; absent for plain validation errors. */
export type ServiceError = { error: string; status: number; code?: string };

function err(error: string, status: number): ServiceError {
  return { error, status };
}

export function isServiceError<T>(value: T | ServiceError): value is ServiceError {
  return typeof value === 'object' && value !== null && 'error' in value && 'status' in value;
}

const MAX_LINE_ITEMS = 100;
const MAX_LINE_ITEM_NAME_LENGTH = 256;

/** `subtotal` is the PRE-TAX line-items sum — tax (#2421) is added on top of it in `createPaymentRequest`. */
type LineItemsResult = { subtotal: Money; items: PaymentRequestLineItem[] } | ServiceError;

/** Validate a single `line_items[index]` entry. Extracted from `validateLineItems` to keep that function's cognitive complexity within budget. */
function validateLineItem(rawItem: unknown, index: number): PaymentRequestLineItem | ServiceError {
  const item = rawItem as Partial<PaymentRequestLineItem> | null;
  if (!item || typeof item !== 'object') {
    return err(`line_items[${index}] must be an object`, 400);
  }
  if (typeof item.name !== 'string' || !item.name.trim()) {
    return err(`line_items[${index}].name is required`, 400);
  }
  if (item.name.length > MAX_LINE_ITEM_NAME_LENGTH) {
    return err(`line_items[${index}].name must be ${MAX_LINE_ITEM_NAME_LENGTH} characters or fewer`, 400);
  }
  if (item.description !== undefined && typeof item.description !== 'string') {
    return err(`line_items[${index}].description must be a string`, 400);
  }
  if (!Number.isInteger(item.amount) || (item.amount as number) <= 0) {
    return err(`line_items[${index}].amount must be a positive integer (minor units)`, 400);
  }
  if (!Number.isInteger(item.quantity) || (item.quantity as number) < 1) {
    return err(`line_items[${index}].quantity must be a positive integer >= 1`, 400);
  }

  return {
    name: item.name.trim(),
    ...(item.description ? { description: item.description } : {}),
    amount: item.amount as number,
    quantity: item.quantity as number,
  };
}

/** Validate `line_items` and compute the pre-tax subtotal via `packages/money` — no float intermediates. */
function validateLineItems(raw: unknown, currency: string): LineItemsResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return err('line_items must be a non-empty array', 400);
  }
  if (raw.length > MAX_LINE_ITEMS) {
    return err(`line_items must have at most ${MAX_LINE_ITEMS} entries`, 400);
  }

  const items: PaymentRequestLineItem[] = [];
  let subtotal: Money = { amount: 0, currency };

  for (const [index, rawItem] of raw.entries()) {
    const validated = validateLineItem(rawItem, index);
    if (isServiceError(validated)) return validated;

    items.push(validated);
    subtotal = moneyAdd(subtotal, { amount: validated.amount * validated.quantity, currency });
  }

  return { subtotal, items };
}

export interface CreatePaymentRequestInvite {
  email?: unknown;
  delivery?: unknown;
  note?: unknown;
}

export interface CreatePaymentRequestInput {
  /** The authenticated caller's resolved effective DID (`resolveActingDid`). */
  callerDid: string;
  issuerDid: unknown;
  payeeAccount?: unknown;
  kind?: unknown;
  recipientDid?: unknown;
  recipientStubId?: unknown;
  /** New-counterparty path (#2210): create/reuse a claimable stub + connections invite carrying this request as the invite's opaque reason. */
  recipientInvite?: unknown;
  lineItems?: unknown;
  currency?: unknown;
  dueAt?: unknown;
  allowOnPlatform?: unknown;
  fairManifest?: unknown;
  /** #2421 — opt in to charging the issuer's registered tax(es) on top of the subtotal. */
  chargeTax?: unknown;
  /** #2421 — one `{ jurisdiction, kind, rate_bps, amount? }` per charged registration; required (non-empty) when `chargeTax` is true. */
  taxes?: unknown;
  /** #2421 — optional client-previewed amounts. Never trusted: each one present must equal the server's recomputation, else 400. */
  subtotalAmount?: unknown;
  taxTotalAmount?: unknown;
  totalAmount?: unknown;
}

export interface CreatedPaymentRequestInvite {
  id: string;
  code: string;
  url: string;
}

export interface CreatedPaymentRequest extends PaymentRequest {
  attestationId: string | null;
  /** Present only when the recipient was resolved via `recipientInvite` (#2210). */
  invite?: CreatedPaymentRequestInvite;
}

type RecipientResolution = { recipientDid: string | null; recipientStubId: string | null; invite?: CreatedPaymentRequestInvite };

/** Validate the `recipientInvite` object shape; does not touch the DB. */
function validateRecipientInvite(raw: unknown): { email: string; delivery: 'link' | 'email'; note: string | null } | ServiceError {
  const invite = raw as CreatePaymentRequestInvite;
  if (typeof invite.email !== 'string' || !invite.email.trim()) {
    // The claim-resolution seam (#1834) is keyed on email — without one
    // there's no dedup target and no way to ever resolve recipient_did.
    return err('recipient_invite.email is required', 400);
  }
  if (invite.delivery !== undefined && invite.delivery !== 'link' && invite.delivery !== 'email') {
    return err("recipient_invite.delivery must be 'link' or 'email'", 400);
  }
  if (invite.note !== undefined && invite.note !== null && typeof invite.note !== 'string') {
    return err('recipient_invite.note must be a string', 400);
  }
  return {
    email: invite.email.trim(),
    delivery: invite.delivery === 'link' ? 'link' : 'email',
    note: typeof invite.note === 'string' ? invite.note : null,
  };
}

/**
 * Resolve + validate the recipient fields: exactly one of `recipientDid` /
 * `recipientStubId` / `recipientInvite` must be supplied at create time
 * (#2207/#2210 hard requirement — the XOR of the first two is enforced
 * here AND by the migration's CHECK constraint; `recipientInvite` is
 * request-shape sugar that resolves to a fresh `recipientStubId`).
 *
 *  - `recipientDid` must be a DID the issuer already has an active
 *    connection with (#2210) — an arbitrary DID would let a payment_request
 *    address someone with no established relationship to the issuer at
 *    all, bypassing the invite/claim path entirely.
 *  - `recipientInvite` creates (or reuses, per #1834's one-stub-per-email
 *    dedup) a claimable stub and a connections invite carrying this
 *    request as its opaque reason (`createPaymentRequestInvite`) — the
 *    resulting stub DID becomes `recipientStubId`.
 */
async function resolveRecipientForCreate(
  input: CreatePaymentRequestInput,
  issuerDid: string,
  paymentRequestId: string,
): Promise<RecipientResolution | ServiceError> {
  const recipientDid = typeof input.recipientDid === 'string' && input.recipientDid ? input.recipientDid : null;
  const recipientStubId = typeof input.recipientStubId === 'string' && input.recipientStubId ? input.recipientStubId : null;
  const recipientInviteRaw = input.recipientInvite && typeof input.recipientInvite === 'object' ? input.recipientInvite : null;

  const provided = [recipientDid, recipientStubId, recipientInviteRaw].filter(Boolean).length;
  if (provided !== 1) {
    return err('exactly one of recipient_did, recipient_stub_id, or recipient_invite is required', 400);
  }

  if (recipientDid) {
    if (!(await isConnected(issuerDid, recipientDid))) {
      return err('recipient_did must be a DID the issuer has an existing connection with', 403);
    }
    return { recipientDid, recipientStubId: null };
  }

  if (recipientStubId) {
    return { recipientDid: null, recipientStubId };
  }

  const inviteInput = validateRecipientInvite(recipientInviteRaw);
  if (isServiceError(inviteInput)) return inviteInput;

  const invite = await createPaymentRequestInvite({
    issuerDid,
    email: inviteInput.email,
    delivery: inviteInput.delivery,
    note: inviteInput.note,
    reasonContextId: paymentRequestId,
    reasonContextType: 'payment_request',
  });

  return {
    recipientDid: null,
    recipientStubId: invite.recipientStubId,
    invite: { id: invite.inviteId, code: invite.inviteCode, url: invite.inviteUrl },
  };
}

/** Parse and validate the optional `due_at` ISO date string. */
function resolveDueAt(dueAt: unknown): { dueAt: Date | null } | ServiceError {
  if (dueAt === undefined || dueAt === null) return { dueAt: null };
  if (typeof dueAt !== 'string') return err('due_at must be an ISO date string', 400);
  const parsed = new Date(dueAt);
  if (Number.isNaN(parsed.getTime())) return err('due_at must be a valid date', 400);
  return { dueAt: parsed };
}

/** Resolve the stored `fair_manifest`: caller-supplied (validated against the computed pre-tax subtotal) or the default single-payee manifest. */
function resolveFairManifest(
  fairManifestInput: unknown,
  params: { payeeAccount: string; paymentRequestId: string; total: Money },
): PaymentRequestFairManifest | ServiceError {
  if (fairManifestInput === undefined || fairManifestInput === null) {
    return buildDefaultPaymentRequestManifest(params);
  }
  const validation = validateCustomPaymentRequestManifest(fairManifestInput, params.total);
  if (!validation.ok) return err(validation.error, 400);
  return fairManifestInput as PaymentRequestFairManifest;
}

/** The issuer's tax registrations (#2420), read server-side straight off their profile — the authoritative source for every `taxes[].registrationNumber`. */
async function fetchIssuerTaxRegistrations(issuerDid: string): Promise<TaxRegistration[]> {
  const [profile] = await db
    .select({ taxRegistrations: profiles.taxRegistrations })
    .from(profiles)
    .where(eq(profiles.did, issuerDid))
    .limit(1);
  return profile?.taxRegistrations ?? [];
}

interface ResolvedManifestAndTax {
  fairManifest: PaymentRequestFairManifest;
  taxTotal: Money;
}

interface ManifestAndTaxParams {
  issuerDid: string;
  payeeAccount: string;
  paymentRequestId: string;
  subtotal: Money;
}

/** No `charge_tax`: the manifest is the default (untaxed) or a caller-supplied custom one — which may itself carry `taxes[]` (#2419), but only collected by the issuer. */
function resolveUnchargedManifest(input: CreatePaymentRequestInput, params: ManifestAndTaxParams): ResolvedManifestAndTax | ServiceError {
  const taxesSupplied = input.taxes !== undefined && input.taxes !== null;
  const taxesEmptyArray = Array.isArray(input.taxes) && input.taxes.length === 0;
  if (taxesSupplied && !taxesEmptyArray) {
    return err('taxes requires charge_tax: true', 400);
  }
  const fairManifest = resolveFairManifest(input.fairManifest, {
    payeeAccount: params.payeeAccount,
    paymentRequestId: params.paymentRequestId,
    total: params.subtotal,
  });
  if (isServiceError(fairManifest)) return fairManifest;

  const taxes = fairManifest.taxes ?? [];
  const foreignCollector = taxes.find((t) => t.collectorDid !== params.issuerDid);
  if (foreignCollector) {
    return err(`fair_manifest.taxes[].collectorDid (${foreignCollector.collectorDid}) must be the issuer`, 400);
  }
  return { fairManifest, taxTotal: sumTaxes(taxes, params.subtotal.currency) };
}

/**
 * `charge_tax: true`: rebuild `taxes[]` from the issuer's registrations and
 * the server-computed subtotal, stamp `fair: '1.2'`, then run the FULL
 * custom-manifest validation over the result — which is what asserts the
 * collector (the issuer) is a seller in the manifest chain, so a payee
 * account that isn't the issuer 400s here rather than at settle (#2439 item 2).
 */
async function resolveChargedManifest(input: CreatePaymentRequestInput, params: ManifestAndTaxParams): Promise<ResolvedManifestAndTax | ServiceError> {
  const rows = parseTaxRowInputs(input.taxes);
  if (!rows.ok) return err(rows.error, 400);

  const customManifest = input.fairManifest ?? null;
  if (customManifest && (customManifest as { taxes?: unknown }).taxes !== undefined) {
    return err('fair_manifest.taxes cannot be combined with charge_tax — send one or the other', 400);
  }

  const registrations = await fetchIssuerTaxRegistrations(params.issuerDid);
  const charge = resolveTaxCharge({ issuerDid: params.issuerDid, subtotal: params.subtotal, registrations, rows: rows.value });
  if (!charge.ok) return err(charge.error, 400);

  const base = customManifest
    ? { ...(customManifest as PaymentRequestFairManifest), taxes: charge.value.taxes, fair: FAIR_VERSION_WITH_TAXES }
    : buildDefaultPaymentRequestManifest({
        payeeAccount: params.payeeAccount,
        paymentRequestId: params.paymentRequestId,
        total: params.subtotal,
        taxes: charge.value.taxes,
      });

  const validation = validateCustomPaymentRequestManifest(base, params.subtotal);
  if (!validation.ok) return err(validation.error, 400);
  return { fairManifest: base, taxTotal: charge.value.taxTotal };
}

/** Resolve the stored `fair_manifest` and the tax total it implies (zero for an untaxed request). */
async function resolveManifestAndTax(input: CreatePaymentRequestInput, params: ManifestAndTaxParams): Promise<ResolvedManifestAndTax | ServiceError> {
  if (input.chargeTax !== undefined && typeof input.chargeTax !== 'boolean') {
    return err('charge_tax must be a boolean', 400);
  }
  return input.chargeTax === true ? resolveChargedManifest(input, params) : resolveUnchargedManifest(input, params);
}

/**
 * `total = subtotal + tax_total`, exactly (packages/money), plus the tax
 * breakdown carried by the attestations and the content hash. Any
 * subtotal/tax/total the client previewed and sent is checked against this —
 * never trusted (400 on mismatch).
 */
function deriveTotals(
  input: CreatePaymentRequestInput,
  params: { subtotal: Money; taxTotal: Money; fairManifest: PaymentRequestFairManifest },
): { total: Money; tax: ReturnType<typeof taxBreakdownOf> } | ServiceError {
  const { subtotal, taxTotal, fairManifest } = params;
  const total = computeGrandTotal(subtotal, taxTotal);
  const assertedError = checkAssertedTotals(input, { subtotal, taxTotal, total });
  if (assertedError) return err(assertedError, 400);
  const tax = taxBreakdownOf({ subtotalAmount: subtotal.amount, taxTotalAmount: taxTotal.amount, fairManifest });
  return { total, tax };
}

interface ResolvedPricing extends ResolvedManifestAndTax {
  /** subtotal + tax_total — what the payer owes. */
  total: Money;
  tax: ReturnType<typeof taxBreakdownOf>;
}

/** The stored `fair_manifest`, tax total, grand total and tax breakdown for a create — or the first 400 found. */
async function resolvePricing(input: CreatePaymentRequestInput, params: ManifestAndTaxParams): Promise<ResolvedPricing | ServiceError> {
  const manifestAndTax = await resolveManifestAndTax(input, params);
  if (isServiceError(manifestAndTax)) return manifestAndTax;

  const totals = deriveTotals(input, { subtotal: params.subtotal, ...manifestAndTax });
  if (isServiceError(totals)) return totals;
  return { ...manifestAndTax, ...totals };
}

/**
 * Create a payment_request: issuer-only (caller must resolve to
 * `issuer_did`). Validates the recipient and line items, computes the
 * pre-tax subtotal via `packages/money`, resolves/validates `fair_manifest`
 * (and, when `charge_tax` is set, rebuilds `taxes[]` server-side — #2421),
 * derives `total = subtotal + tax_total` exactly, computes `content_hash`,
 * writes the row, mints exactly ONE `payment_request.issued` attestation,
 * and publishes `payment_request.issued`.
 */
export async function createPaymentRequest(input: CreatePaymentRequestInput): Promise<CreatedPaymentRequest | ServiceError> {
  if (typeof input.issuerDid !== 'string' || !input.issuerDid) {
    return err('issuer_did is required', 400);
  }
  if (input.callerDid !== input.issuerDid) {
    return err('issuer_did must resolve to the authenticated principal', 403);
  }

  const kindRaw = input.kind ?? 'invoice';
  if (kindRaw !== 'invoice' && kindRaw !== 'request') {
    return err("kind must be 'invoice' or 'request'", 400);
  }
  const kind: PaymentRequestKind = kindRaw;

  // Generated up front: the recipient_invite path (#2210) needs the
  // payment_request's own id to stamp as the invite's opaque
  // reasonContextId before the row itself exists.
  const id = generateId('pr');
  const payHandle = generateId('ph');

  const recipientResult = await resolveRecipientForCreate(input, input.issuerDid, id);
  if (isServiceError(recipientResult)) return recipientResult;
  const { recipientDid, recipientStubId, invite } = recipientResult;

  const currency = typeof input.currency === 'string' && input.currency ? input.currency.toUpperCase() : 'CAD';

  const lineItemsResult = validateLineItems(input.lineItems, currency);
  if (isServiceError(lineItemsResult)) return lineItemsResult;
  const { subtotal, items } = lineItemsResult;

  const dueAtResult = resolveDueAt(input.dueAt);
  if (isServiceError(dueAtResult)) return dueAtResult;
  const { dueAt } = dueAtResult;

  const allowOnPlatform = input.allowOnPlatform === undefined ? true : Boolean(input.allowOnPlatform);
  const payeeAccount = typeof input.payeeAccount === 'string' && input.payeeAccount ? input.payeeAccount : input.issuerDid;

  const pricing = await resolvePricing(input, { issuerDid: input.issuerDid, payeeAccount, paymentRequestId: id, subtotal });
  if (isServiceError(pricing)) return pricing;
  const { fairManifest, taxTotal, total, tax } = pricing;

  const contentHash = await computePaymentRequestContentHash({
    kind,
    issuerDid: input.issuerDid,
    payeeAccount,
    recipientDid,
    recipientStubId,
    lineItems: items,
    currency,
    totalAmount: total.amount,
    tax,
    dueAt: dueAt ? dueAt.toISOString() : null,
    allowOnPlatform,
  });

  const [row] = await db
    .insert(paymentRequests)
    .values({
      id,
      kind,
      issuerDid: input.issuerDid,
      payeeAccount,
      recipientDid,
      recipientStubId,
      lineItems: items,
      currency,
      totalAmount: total.amount,
      subtotalAmount: subtotal.amount,
      taxTotalAmount: taxTotal.amount,
      fairManifest,
      dueAt,
      allowOnPlatform,
      status: 'issued',
      settlementRef: null,
      contentHash,
      payHandle,
    })
    .returning();

  const attestationId = await emitPaymentRequestIssuedAttestation({
    paymentRequestId: id,
    issuerDid: input.issuerDid,
    recipientDid,
    recipientStubId,
    kind,
    totalAmount: total.amount,
    currency,
    contentHash,
    tax,
  });

  publish('payment_request.issued', {
    issuer: input.issuerDid,
    subject: recipientDid ?? input.issuerDid,
    scope: 'pay',
    payload: {
      paymentRequestId: id,
      kind,
      issuerDid: input.issuerDid,
      recipientDid,
      recipientStubId,
      totalAmount: total.amount,
      currency,
      contentHash,
      attestationId,
      context_id: id,
      context_type: 'payment_request',
    },
  }).catch(() => {});

  return { ...row, attestationId, ...(invite ? { invite } : {}) };
}

export async function getPaymentRequestById(id: string): Promise<PaymentRequest | null> {
  const [row] = await db.select().from(paymentRequests).where(eq(paymentRequests.id, id)).limit(1);
  return row ?? null;
}

export interface PaymentRequestPublicView {
  kind: PaymentRequestKind;
  lineItems: PaymentRequestLineItem[];
  /** The GRAND total the payer owes (`subtotalAmount + taxTotalAmount`). */
  totalAmount: number;
  /** #2421 — pre-tax subtotal; equals `totalAmount` when no tax is charged. */
  subtotalAmount: number;
  taxTotalAmount: number;
  /** #2421 — one line per charged tax (kind, jurisdiction, rate, amount, issuer registration number — public by design, #2420); empty, and the page renders exactly as before, when no tax is charged. */
  taxes: PaymentRequestTaxLine[];
  currency: string;
  issuerDisplayName: string;
  status: string;
}

/** `PaymentRequestPublicView` + the printable invoice / receipt fields (#2661) — see `getPaymentRequestInvoiceByHandle`. */
export interface PaymentRequestInvoiceView extends PaymentRequestPublicView {
  /** Human-facing document number (`INV-…` / `REQ-…`), derived from the internal id. */
  invoiceNumber: string;
  /** ISO instant the request was issued. */
  issuedAt: string | null;
  /** Calendar due date stored as UTC midnight (#2651) — render with `formatDueDate`. */
  dueAt: string | null;
  /** The issuer's public business address, when the profile has one. */
  issuerAddress: string | null;
  /** ISO instant of payment; `null` until settled. */
  paidAt: string | null;
  /** Sanitised settlement reference; `null` until settled. */
  settlement: PublicSettlement | null;
  /**
   * #2656 — who paid, once settled: `paid_by_did ?? recipient_did`, with the
   * profile name when there is one. `null` until settled (and for a request
   * settled with neither a chosen payer nor a resolved recipient).
   */
  paidBy: { did: string; displayName: string } | null;
  /**
   * #2665 — the e-Transfer option; `null` (nothing renders) unless the issuer
   * has set a receiving email AND the request is still open. The receiving
   * email itself is only ever included once the payer has chosen e-Transfer.
   */
  emt: EmtPayOption | null;
  /**
   * #2754 — whether a card payment can actually start for this request RIGHT NOW:
   * still open, the issuer allows on-platform payment, and they have a working card
   * rail (their own Stripe connector — see `card-rail.ts`).
   * Resolved server-side at render time, so the page never offers a card button that
   * can only fail. `false` once the request is no longer open.
   */
  card: boolean;
}

type IssuerProfile = typeof profiles.$inferSelect;

async function findIssuerProfile(issuerDid: string): Promise<IssuerProfile | undefined> {
  const [profile] = await db.select().from(profiles).where(eq(profiles.did, issuerDid)).limit(1);
  return profile;
}

/** Best-effort display name for the issuer — falls back to a truncated DID rather than failing the whole read. */
function issuerDisplayNameOf(profile: IssuerProfile | undefined, issuerDid: string): string {
  return profile?.displayName || profile?.handle || issuerDid.slice(0, 16);
}

/** The row behind an opaque `pay_handle`, or `null` when unknown or `void` (both 404 the same). */
export async function findLiveRowByHandle(handle: string): Promise<PaymentRequest | null> {
  const [row] = await db.select().from(paymentRequests).where(eq(paymentRequests.payHandle, handle)).limit(1);
  if (!row || row.status === 'void') return null;
  return row;
}

function publicViewOf(row: PaymentRequest, profile: IssuerProfile | undefined): PaymentRequestPublicView {
  return {
    kind: row.kind as PaymentRequestKind,
    lineItems: row.lineItems as PaymentRequestLineItem[],
    totalAmount: row.totalAmount,
    subtotalAmount: row.subtotalAmount,
    taxTotalAmount: row.taxTotalAmount,
    taxes: taxBreakdownOf(row)?.taxes ?? [],
    currency: row.currency,
    issuerDisplayName: issuerDisplayNameOf(profile, row.issuerDid),
    status: row.status,
  };
}

/**
 * Unauthenticated read of the minimum needed to pay, keyed by the opaque
 * `pay_handle` rather than the internal id (#2210) — what both the
 * pay-first and claim-first recipient orderings resolve against before an
 * account/connection exists. Deliberately excludes issuerDid,
 * recipientDid/recipientStubId, fairManifest, settlementRef, and
 * contentHash — no recipient PII, and nothing beyond what's needed to pay.
 * Hidden (404, same as an unknown handle) once `void`.
 */
export async function getPaymentRequestByHandle(handle: string): Promise<PaymentRequestPublicView | null> {
  const row = await findLiveRowByHandle(handle);
  if (!row) return null;
  return publicViewOf(row, await findIssuerProfile(row.issuerDid));
}

/** Who a settled request names as having paid (#2656) — the paying DID and its profile name; `null` when nobody is named. */
async function paidByViewOf(row: PaymentRequest): Promise<PaymentRequestInvoiceView['paidBy']> {
  const did = payingDidOf(row);
  if (!did) return null;
  return { did, displayName: issuerDisplayNameOf(await findIssuerProfile(did), did) };
}

/** ISO string for a nullable timestamp column, `null` when unset. */
function isoOrNull(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * #2661 — the public view plus exactly what a printable invoice / receipt
 * needs on top of it, behind the SAME opaque `pay_handle` gate (unknown and
 * `void` handles are `null`, same as the pay page). Used only by the
 * server-rendered pay page: `GET /pay/api/payment-requests/by-handle/:handle`
 * keeps returning `getPaymentRequestByHandle`'s narrower view, unchanged.
 *
 * Adds a document number, issue/due dates, the issuer's public business
 * address, and — only once settled — the payment date, a sanitised
 * settlement reference (see `invoice.ts`) and who paid (#2656: the paying DID,
 * `paid_by_did ?? recipient_did`). Still no issuer DID, unsettled recipient,
 * settlement note or asserter, fair_manifest or content_hash.
 */
export async function getPaymentRequestInvoiceByHandle(handle: string): Promise<PaymentRequestInvoiceView | null> {
  const row = await findLiveRowByHandle(handle);
  if (!row) return null;

  const profile = await findIssuerProfile(row.issuerDid);
  const settled = row.status === 'paid' || row.status === 'settled_manual';
  const { paidAt, settlement } = settled ? publicSettlementOf(row.settlementRef) : { paidAt: null, settlement: null };
  const paidBy = settled ? await paidByViewOf(row) : null;

  return {
    ...publicViewOf(row, profile),
    invoiceNumber: invoiceNumberOf(row.kind as PaymentRequestKind, row.id),
    issuedAt: isoOrNull(row.createdAt),
    dueAt: isoOrNull(row.dueAt),
    issuerAddress: issuerAddressOf(profile),
    paidAt,
    settlement,
    paidBy,
    emt: emtOptionOf(row, profile?.etransferEmail),
    card: await cardAvailableFor(row),
  };
}

/** Whether a card payment can start for `row` now (#2754) — open, on-platform, and a working card rail. */
async function cardAvailableFor(row: PaymentRequest): Promise<boolean> {
  if (row.status !== 'issued' && row.status !== 'emt_pending') return false;
  if (!row.allowOnPlatform) return false;
  return (await resolveCardRail(row.issuerDid)).kind !== 'none';
}

export interface ListPaymentRequestsInput {
  issuerDid?: string | null;
  recipientDid?: string | null;
  status?: string | null;
  kind?: string | null;
  limit?: number;
}

const LIST_LIMIT_DEFAULT = 20;
const LIST_LIMIT_MAX = 100;

/** List payment_requests, filtered by issuer and/or recipient (the by-issuer and by-payer-side views #2208 asks for). */
export async function listPaymentRequests(input: ListPaymentRequestsInput): Promise<PaymentRequest[]> {
  const conditions = [];
  if (input.issuerDid) conditions.push(eq(paymentRequests.issuerDid, input.issuerDid));
  if (input.recipientDid) conditions.push(eq(paymentRequests.recipientDid, input.recipientDid));
  if (input.status) conditions.push(eq(paymentRequests.status, input.status));
  if (input.kind) conditions.push(eq(paymentRequests.kind, input.kind));

  const limit = Math.min(Math.max(1, input.limit ?? LIST_LIMIT_DEFAULT), LIST_LIMIT_MAX);

  const rows = await db
    .select()
    .from(paymentRequests)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(paymentRequests.createdAt))
    .limit(limit);
  return rows;
}

/**
 * Void a payment_request: issuer-only, and only valid while it is still open
 * — `issued`, or `emt_pending` (#2665: a payer choosing e-Transfer must not
 * be able to lock the issuer out of voiding). A `paid`, `settled_manual` or
 * already-`void` request rejects cleanly (409) rather than silently
 * no-op'ing, so a replayed void call is never mistaken for a fresh one.
 */
export async function voidPaymentRequest(params: { id: string; callerDid: string }): Promise<PaymentRequest | ServiceError> {
  const existing = await getPaymentRequestById(params.id);
  if (!existing) return err('payment_request not found', 404);
  if (existing.issuerDid !== params.callerDid) return err('only the issuer may void this payment_request', 403);
  if (existing.status !== 'issued' && existing.status !== 'emt_pending') {
    return err(
      `cannot void a payment_request in status '${existing.status}' (void is only valid from 'issued' or 'emt_pending')`,
      409,
    );
  }

  const [row] = await db
    .update(paymentRequests)
    .set({ status: 'void', updatedAt: new Date() })
    .where(and(eq(paymentRequests.id, params.id), inArray(paymentRequests.status, ['issued', 'emt_pending'])))
    .returning();
  if (!row) {
    // Lost a race against a concurrent void/settle between the read above and this guarded update.
    return err('payment_request status changed concurrently — refresh and retry', 409);
  }

  publish('payment_request.voided', {
    issuer: existing.issuerDid,
    subject: existing.recipientDid ?? existing.issuerDid,
    scope: 'pay',
    payload: {
      paymentRequestId: row.id,
      issuerDid: existing.issuerDid,
      recipientDid: existing.recipientDid,
      context_id: row.id,
      context_type: 'payment_request',
    },
  }).catch(() => {});

  return row;
}

export interface SettlePaymentRequestManualInput {
  id: string;
  callerDid: string;
  note?: string;
}

export interface SettledPaymentRequest extends PaymentRequest {
  attestationId: string | null;
}

/**
 * Settle a payment_request off-platform: issuer-only, and only valid from
 * `issued`. Records `settlement_ref = { method: 'manual', note, asserted_by }`,
 * mints exactly ONE `payment_request.settled` attestation signed by the
 * issuer, and publishes `payment_request.settled`. A second settle call
 * against an already-`settled_manual`/`void` request rejects cleanly (409).
 */
export async function settlePaymentRequestManual(input: SettlePaymentRequestManualInput): Promise<SettledPaymentRequest | ServiceError> {
  const existing = await getPaymentRequestById(input.id);
  if (!existing) return err('payment_request not found', 404);
  if (existing.issuerDid !== input.callerDid) return err('only the issuer may settle this payment_request', 403);
  if (existing.status !== 'issued') {
    return err(`cannot settle a payment_request in status '${existing.status}' (settle-manual is only valid from 'issued')`, 409);
  }
  if (input.note !== undefined && typeof input.note !== 'string') {
    return err('note must be a string', 400);
  }

  const settledAt = new Date();
  const settlementRef: PaymentRequestSettlementRef = {
    method: 'manual',
    ...(input.note ? { note: input.note } : {}),
    asserted_by: input.callerDid,
    settled_at: settledAt.toISOString(),
  };

  const [row] = await db
    .update(paymentRequests)
    .set({ status: 'settled_manual', settlementRef, updatedAt: settledAt })
    .where(and(eq(paymentRequests.id, input.id), eq(paymentRequests.status, 'issued')))
    .returning();
  if (!row) {
    return err('payment_request status changed concurrently — refresh and retry', 409);
  }

  const attestationId = await emitPaymentRequestSettledAttestation({
    paymentRequestId: input.id,
    issuerDid: existing.issuerDid,
    recipientDid: existing.recipientDid,
    method: 'manual',
    assertedBy: input.callerDid,
    note: input.note,
    contentHash: existing.contentHash,
    totalAmount: existing.totalAmount,
    currency: existing.currency,
    tax: taxBreakdownOf(existing),
  });

  publish('payment_request.settled', {
    issuer: input.callerDid,
    subject: existing.recipientDid ?? existing.issuerDid,
    scope: 'pay',
    payload: {
      paymentRequestId: row.id,
      method: 'manual',
      issuerDid: existing.issuerDid,
      recipientDid: existing.recipientDid,
      totalAmount: existing.totalAmount,
      currency: existing.currency,
      contentHash: existing.contentHash,
      settlementRef: settlementRef as unknown as Record<string, unknown>,
      attestationId,
      context_id: row.id,
      context_type: 'payment_request',
    },
  }).catch(() => {});

  return { ...row, attestationId };
}
