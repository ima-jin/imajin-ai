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
import { and, desc, eq } from 'drizzle-orm';
import { db, paymentRequests } from '@/src/db';
import type { PaymentRequest, PaymentRequestKind } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { publish } from '@imajin/bus';
import { add as moneyAdd, type Money } from '@imajin/money';
import { computePaymentRequestContentHash } from './content-hash';
import { buildDefaultPaymentRequestManifest, validateCustomPaymentRequestManifest } from './manifest';
import { emitPaymentRequestIssuedAttestation, emitPaymentRequestSettledAttestation } from './attestations';
import type { PaymentRequestFairManifest, PaymentRequestLineItem, PaymentRequestSettlementRef } from './types';

export type ServiceError = { error: string; status: number };

function err(error: string, status: number): ServiceError {
  return { error, status };
}

export function isServiceError<T>(value: T | ServiceError): value is ServiceError {
  return typeof value === 'object' && value !== null && 'error' in value && 'status' in value;
}

const MAX_LINE_ITEMS = 100;
const MAX_LINE_ITEM_NAME_LENGTH = 256;

type LineItemsResult = { total: Money; items: PaymentRequestLineItem[] } | ServiceError;

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

/** Validate `line_items` and compute the request total via `packages/money` — no float intermediates. */
function validateLineItems(raw: unknown, currency: string): LineItemsResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return err('line_items must be a non-empty array', 400);
  }
  if (raw.length > MAX_LINE_ITEMS) {
    return err(`line_items must have at most ${MAX_LINE_ITEMS} entries`, 400);
  }

  const items: PaymentRequestLineItem[] = [];
  let total: Money = { amount: 0, currency };

  for (const [index, rawItem] of raw.entries()) {
    const validated = validateLineItem(rawItem, index);
    if (isServiceError(validated)) return validated;

    items.push(validated);
    total = moneyAdd(total, { amount: validated.amount * validated.quantity, currency });
  }

  return { total, items };
}

export interface CreatePaymentRequestInput {
  /** The authenticated caller's resolved effective DID (`resolveActingDid`). */
  callerDid: string;
  issuerDid: unknown;
  payeeAccount?: unknown;
  kind?: unknown;
  recipientDid?: unknown;
  recipientStubId?: unknown;
  lineItems?: unknown;
  currency?: unknown;
  dueAt?: unknown;
  allowOnPlatform?: unknown;
  fairManifest?: unknown;
}

export interface CreatedPaymentRequest extends PaymentRequest {
  attestationId: string | null;
}

/**
 * Resolve + validate the recipient fields: exactly one of `recipientDid` /
 * `recipientStubId` must be supplied at create time (#2207 hard
 * requirement — enforced here AND by the migration's CHECK constraint).
 */
function resolveRecipient(input: CreatePaymentRequestInput): { recipientDid: string | null; recipientStubId: string | null } | ServiceError {
  const recipientDid = typeof input.recipientDid === 'string' && input.recipientDid ? input.recipientDid : null;
  const recipientStubId = typeof input.recipientStubId === 'string' && input.recipientStubId ? input.recipientStubId : null;
  if (Boolean(recipientDid) === Boolean(recipientStubId)) {
    return err('exactly one of recipient_did or recipient_stub_id is required', 400);
  }
  return { recipientDid, recipientStubId };
}

/** Parse and validate the optional `due_at` ISO date string. */
function resolveDueAt(dueAt: unknown): { dueAt: Date | null } | ServiceError {
  if (dueAt === undefined || dueAt === null) return { dueAt: null };
  if (typeof dueAt !== 'string') return err('due_at must be an ISO date string', 400);
  const parsed = new Date(dueAt);
  if (Number.isNaN(parsed.getTime())) return err('due_at must be a valid date', 400);
  return { dueAt: parsed };
}

/** Resolve the stored `fair_manifest`: caller-supplied (validated against the computed total) or the default single-payee manifest. */
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

/**
 * Create a payment_request: issuer-only (caller must resolve to
 * `issuer_did`). Validates the recipient and line items, computes the
 * total via `packages/money`, resolves/validates `fair_manifest`, computes
 * `content_hash`, writes the row, mints exactly ONE `payment_request.issued`
 * attestation, and publishes `payment_request.issued`.
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

  const recipientResult = resolveRecipient(input);
  if (isServiceError(recipientResult)) return recipientResult;
  const { recipientDid, recipientStubId } = recipientResult;

  const currency = typeof input.currency === 'string' && input.currency ? input.currency.toUpperCase() : 'CAD';

  const lineItemsResult = validateLineItems(input.lineItems, currency);
  if (isServiceError(lineItemsResult)) return lineItemsResult;
  const { total, items } = lineItemsResult;

  const dueAtResult = resolveDueAt(input.dueAt);
  if (isServiceError(dueAtResult)) return dueAtResult;
  const { dueAt } = dueAtResult;

  const allowOnPlatform = input.allowOnPlatform === undefined ? true : Boolean(input.allowOnPlatform);
  const payeeAccount = typeof input.payeeAccount === 'string' && input.payeeAccount ? input.payeeAccount : input.issuerDid;

  const id = generateId('pr');

  const fairManifestResult = resolveFairManifest(input.fairManifest, { payeeAccount, paymentRequestId: id, total });
  if (isServiceError(fairManifestResult)) return fairManifestResult;
  const fairManifest = fairManifestResult;

  const contentHash = await computePaymentRequestContentHash({
    kind,
    issuerDid: input.issuerDid,
    payeeAccount,
    recipientDid,
    recipientStubId,
    lineItems: items,
    currency,
    totalAmount: total.amount,
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
      fairManifest,
      dueAt,
      allowOnPlatform,
      status: 'issued',
      settlementRef: null,
      contentHash,
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

  return { ...row, attestationId };
}

export async function getPaymentRequestById(id: string): Promise<PaymentRequest | null> {
  const [row] = await db.select().from(paymentRequests).where(eq(paymentRequests.id, id)).limit(1);
  return row ?? null;
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

  return db
    .select()
    .from(paymentRequests)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(paymentRequests.createdAt))
    .limit(limit);
}

/**
 * Void a payment_request: issuer-only, and only valid from `issued` — a
 * `settled_manual` or already-`void` request rejects cleanly (409) rather
 * than silently no-op'ing, so a replayed void call is never mistaken for
 * a fresh one.
 */
export async function voidPaymentRequest(params: { id: string; callerDid: string }): Promise<PaymentRequest | ServiceError> {
  const existing = await getPaymentRequestById(params.id);
  if (!existing) return err('payment_request not found', 404);
  if (existing.issuerDid !== params.callerDid) return err('only the issuer may void this payment_request', 403);
  if (existing.status !== 'issued') {
    return err(`cannot void a payment_request in status '${existing.status}' (void is only valid from 'issued')`, 409);
  }

  const [row] = await db
    .update(paymentRequests)
    .set({ status: 'void', updatedAt: new Date() })
    .where(and(eq(paymentRequests.id, params.id), eq(paymentRequests.status, 'issued')))
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
