/**
 * Stripe Checkout <-> `pay.payment_request` linkage (#2206/#2209).
 *
 * `createPaymentRequestCheckoutSession` composes the EXISTING checkout code
 * path (`resolveConnectedAccountFee` from `lib/pay/checkout.ts`,
 * `pay.checkout()` from `lib/pay/pay.ts` — the same primitives
 * `POST /pay/api/checkout` uses) with the payment_request's own
 * `line_items` / `currency` / `fair_manifest` / `issuer_did`, and records a
 * pending `pay.transactions` row carrying `metadata.payment_request_id` so:
 *   - the Stripe webhook (`app/pay/api/webhook/route.ts`) can look the
 *     request back up by `session.metadata.payment_request_id`, and
 *   - a second checkout call for the same still-open request reuses the
 *     existing Stripe session instead of minting a duplicate one.
 *
 * That pending transaction row's `fairManifest` column is deliberately left
 * NULL — the generic webhook's `processFairManifest` (chain distribution
 * via `feeLedger`/`balanceRollups`, see `webhook-handlers.ts`) must never
 * fire for a payment_request checkout. Settlement for these sessions runs
 * exclusively through `settlePaymentRequestFromStripeCheckout` below, which
 * calls the canonical `settlePayment()` primitive (`../settle-core.ts`)
 * directly, in-process — never an HTTP self-call to `/pay/api/settle`. This
 * is the one intentional divergence from the generic checkout's tx-row
 * shape — see `docs/guide/canonical-patterns.md` "Known divergences".
 *
 * `settlePaymentRequestFromStripeCheckout` is the webhook-side half: it
 * transitions `issued -> paid` (guarded compare-and-swap, so only one
 * concurrent webhook delivery ever wins the race), publishes
 * `payment_request.paid`, ALWAYS resolves the stored `.fair` manifest to
 * absolute amounts and runs `settlePayment()` (every payment_request
 * carries a manifest — #2207 NOT NULL), mints exactly ONE kernel-signed
 * `payment_request.settled` attestation, and publishes
 * `payment_request.settled`. Idempotent on webhook replay: once the row has
 * left `issued`, a repeat delivery for the same session is a no-op.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, paymentRequests, transactions } from '@/src/db';
import type { PaymentRequest } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { buildPublicUrlAbsolute } from '@imajin/config';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { resolveSettlementChain, type FairSettlementEntry, type FairSettlementTax } from '@imajin/fair';
import { getPaymentService } from '../pay';
import { getStripeClient } from '../providers/stripe-client';
import { resolveConnectedAccountFee, taxLineItems, type CheckoutBody, type CheckoutItem } from '../checkout';
import type { CheckoutRequest, FiatCurrency } from '../types';
import { settlePayment } from '../settle-core';
import { getPaymentRequestById, type ServiceError } from './service';
import { emitPaymentRequestSettledStripeAttestation } from './attestations';
import { taxBreakdownOf } from './tax';
import type { PaymentRequestFairManifest, PaymentRequestLineItem, PaymentRequestSettlementRef } from './types';

const log = createLogger('kernel');

function err(error: string, status: number): ServiceError {
  return { error, status };
}

// ---------------------------------------------------------------------------
// Checkout session creation
// ---------------------------------------------------------------------------

export interface CreatePaymentRequestCheckoutInput {
  id: string;
  /** The authenticated caller's resolved effective DID. Must be the issuer or the recipient. */
  callerDid: string;
  customerEmail?: string;
}

export interface CreatedPaymentRequestCheckoutSession {
  id: string;
  url: string;
  expiresAt: string;
  /** true when an existing open Stripe session was reused instead of minting a new one. */
  reused: boolean;
}

/** Look up a still-open Stripe Checkout session already created for this payment_request, if any. */
async function findReusableCheckoutSession(
  paymentRequestId: string,
): Promise<{ id: string; url: string; expiresAt: string } | null> {
  const [pendingTx] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.status, 'pending'),
        sql`${transactions.metadata}->>'payment_request_id' = ${paymentRequestId}`,
      ),
    )
    .orderBy(desc(transactions.createdAt))
    .limit(1);
  if (!pendingTx?.stripeId) return null;

  try {
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(pendingTx.stripeId);
    if (session.status === 'open' && session.url) {
      return { id: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1000).toISOString() };
    }
  } catch (error) {
    log.warn(
      { err: String(error), paymentRequestId, sessionId: pendingTx.stripeId },
      'payment_request checkout: failed to retrieve existing Stripe session — creating a new one',
    );
  }
  return null;
}

function toCheckoutItems(lineItems: unknown): CheckoutItem[] {
  return (lineItems as PaymentRequestLineItem[]).map((item) => ({
    name: item.name,
    ...(item.description ? { description: item.description } : {}),
    amount: item.amount,
    quantity: item.quantity,
  }));
}

/** Σ amount × quantity over checkout items, in minor units (integers only). */
function merchandiseTotal(items: CheckoutItem[]): number {
  return items.reduce((sum, item) => sum + item.amount * item.quantity, 0);
}

/**
 * Create (or reuse) a Stripe Checkout session for a payment_request. Either
 * the issuer or the recipient may call this — anonymous pay-link checkout
 * (no recipient DID) is deferred to #2210. Refuses when the request isn't
 * `issued` or doesn't `allow_on_platform`.
 */
export async function createPaymentRequestCheckoutSession(
  input: CreatePaymentRequestCheckoutInput,
): Promise<CreatedPaymentRequestCheckoutSession | ServiceError> {
  const existing = await getPaymentRequestById(input.id);
  if (!existing) return err('payment_request not found', 404);
  if (existing.issuerDid !== input.callerDid && existing.recipientDid !== input.callerDid) {
    return err('Not authorized to create a checkout session for this payment_request', 403);
  }
  if (existing.status !== 'issued') {
    return err(
      `cannot create a checkout session for a payment_request in status '${existing.status}' (checkout is only valid from 'issued')`,
      409,
    );
  }
  if (!existing.allowOnPlatform) {
    return err('payment_request does not allow on-platform (Stripe) payment', 400);
  }

  const reused = await findReusableCheckoutSession(existing.id);
  if (reused) return { ...reused, reused: true };

  // #2419/#2421: tax is appended as its own manual Stripe line item (never
  // Stripe Tax), derived from the manifest's `taxes[]` — `existing.lineItems`
  // (-> `merchandiseItems`) stays the merchandise-only, PRE-TAX subtotal that
  // `resolveConnectedAccountFee` below computes the platform fee on (the
  // #2426 settle-core tax silo; not re-derived here). `[]` for a manifest
  // without `taxes[]`.
  const merchandiseItems = toCheckoutItems(existing.lineItems);
  if (merchandiseTotal(merchandiseItems) !== existing.subtotalAmount) {
    // The row's stored subtotal is what `.fair` `taxes[].basisAmount` and the
    // settlement basis are pinned to — refuse rather than charge something else.
    log.error(
      { paymentRequestId: existing.id, subtotalAmount: existing.subtotalAmount },
      'payment_request checkout refused: line items do not sum to subtotal_amount',
    );
    return err('payment_request amounts are inconsistent (line items do not sum to the subtotal)', 409);
  }
  const fairManifest = existing.fairManifest as unknown as CheckoutBody['fairManifest'];
  const items = [...merchandiseItems, ...taxLineItems(fairManifest)];

  // `successUrl`/`cancelUrl` are part of the shared `CheckoutBody` shape but
  // are never read by `resolveConnectedAccountFee` (fee computation only) —
  // the real ones are built below, once fee resolution has succeeded.
  const feeResult = await resolveConnectedAccountFee({
    items: merchandiseItems,
    currency: existing.currency,
    successUrl: '',
    cancelUrl: '',
    fairManifest,
    sellerDid: existing.issuerDid,
  });
  if (!feeResult.ok) return err(feeResult.error, feeResult.status);

  const baseUrl = buildPublicUrlAbsolute('pay');
  const metadata: Record<string, string> = {
    payment_request_id: existing.id,
    service: 'payment_request',
    type: 'payment_request_checkout',
  };

  const checkoutRequest: CheckoutRequest = {
    items,
    currency: existing.currency as FiatCurrency,
    ...(input.customerEmail && { customerEmail: input.customerEmail }),
    successUrl: `${baseUrl}/payment-requests/${existing.id}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${baseUrl}/payment-requests/${existing.id}`,
    metadata,
    connectedAccountId: feeResult.connectedAccountId,
    applicationFeeAmount: feeResult.applicationFeeAmount,
  };

  const pay = getPaymentService();
  const session = await pay.checkout(checkoutRequest);

  await db.insert(transactions).values({
    id: generateId('tx'),
    service: 'payment_request',
    type: 'payment_request_checkout',
    fromDid: existing.recipientDid,
    toDid: existing.issuerDid,
    amount: (existing.totalAmount / 100).toString(),
    currency: existing.currency,
    status: 'pending',
    stripeId: session.id,
    metadata,
    // fairManifest intentionally omitted — see module doc comment.
  });

  return { id: session.id, url: session.url, expiresAt: session.expiresAt.toISOString(), reused: false };
}

// ---------------------------------------------------------------------------
// Webhook-side settlement
// ---------------------------------------------------------------------------

export interface SettlePaymentRequestFromStripeInput {
  paymentRequestId: string;
  checkoutSessionId: string;
  paymentIntentId: string | null;
}

export interface SettledFromStripeResult {
  paymentRequest: PaymentRequest;
  /** false when this call was an idempotent no-op (already processed by a prior/concurrent delivery). */
  settled: boolean;
}

/**
 * Why a paid payment_request's on-platform settlement did not complete
 * (#2439) — the `reason` carried by `payment_request.settlement_failed`.
 */
export type StripeSettlementFailureReason = 'empty_chain' | 'basis_mismatch' | 'settle_rejected' | 'settle_error';

interface StripeSettlementFailure {
  ok: false;
  reason: StripeSettlementFailureReason;
  error: string;
}

type StripeSettlementOutcome = { ok: true } | StripeSettlementFailure;

function settlementFailure(reason: StripeSettlementFailureReason, error: string): StripeSettlementFailure {
  return { ok: false, reason, error };
}

type ResolvedStripeSettlement = ReturnType<typeof resolveSettlementChain>;

/**
 * Resolve a paid request's stored `.fair` manifest to absolute amounts, or
 * say why it can't be settled. Pure — no I/O.
 */
function planStripeSettlement(
  paymentRequest: PaymentRequest,
  buyerDid: string,
  nodeDid: string | null,
): { ok: true; resolved: ResolvedStripeSettlement } | StripeSettlementFailure {
  const manifest = paymentRequest.fairManifest as unknown as PaymentRequestFairManifest;
  const chain = (manifest?.chain ?? []) as FairSettlementEntry[];
  if (chain.length === 0) {
    return settlementFailure('empty_chain', 'fair_manifest.chain is empty');
  }

  // #2419/#2421: the settlement basis is the PRE-TAX `subtotalAmount`
  // (`service.ts`'s `validateLineItems` sums line items into it, and
  // `validateCustomPaymentRequestManifest` enforces `fair_manifest.total ==
  // Σline_items`). `totalAmount` is subtotal + tax — the gross that was
  // actually charged via Stripe — so it is NOT the basis (using it would
  // fold tax into every chain share). Tax rides only in `taxes[]`.
  const taxes = (manifest?.taxes ?? []) as FairSettlementTax[];
  const basisAmountCents = paymentRequest.subtotalAmount;

  // Defense in depth (#2426, unchanged): every tax row's `basisAmount`
  // must equal the request's own pre-tax subtotal. A mismatch means the
  // stored manifest is stale/tampered — refuse to settle rather than
  // silently using the wrong basis for chain-share math.
  const basisMismatch = taxes.find((t) => t.basisAmount !== basisAmountCents);
  if (basisMismatch) {
    return settlementFailure(
      'basis_mismatch',
      `taxes[].basisAmount (${basisMismatch.basisAmount}) does not match subtotalAmount (${basisAmountCents})`,
    );
  }

  return {
    ok: true,
    resolved: resolveSettlementChain({
      amountCents: basisAmountCents,
      chain,
      fees: manifest?.fees as Array<{ role: string; rateBps: number; fixedCents: number }> | undefined,
      buyerDid,
      nodeDid,
      taxes,
    }),
  };
}

/** Mint the single kernel-signed `payment_request.settled` attestation and publish `payment_request.settled`. */
async function attestAndAnnounceStripeSettled(
  paymentRequest: PaymentRequest,
  settlementRef: PaymentRequestSettlementRef,
  nodeDid: string | null,
): Promise<void> {
  const attestationId = await emitPaymentRequestSettledStripeAttestation({
    paymentRequestId: paymentRequest.id,
    issuerDid: paymentRequest.issuerDid,
    recipientDid: paymentRequest.recipientDid,
    contentHash: paymentRequest.contentHash,
    totalAmount: paymentRequest.totalAmount,
    currency: paymentRequest.currency,
    settlementRef,
    tax: taxBreakdownOf(paymentRequest),
  });

  publish('payment_request.settled', {
    issuer: nodeDid || paymentRequest.issuerDid,
    subject: paymentRequest.recipientDid ?? paymentRequest.issuerDid,
    scope: 'pay',
    payload: {
      paymentRequestId: paymentRequest.id,
      method: 'stripe',
      issuerDid: paymentRequest.issuerDid,
      recipientDid: paymentRequest.recipientDid,
      totalAmount: paymentRequest.totalAmount,
      currency: paymentRequest.currency,
      contentHash: paymentRequest.contentHash,
      settlementRef: settlementRef as unknown as Record<string, unknown>,
      attestationId,
      context_id: paymentRequest.id,
      context_type: 'payment_request',
    },
  }).catch((error: unknown) => log.error({ err: String(error) }, 'payment_request.settled publish error'));
}

/**
 * One settlement attempt for a Stripe-paid request: resolve the manifest,
 * run `settlePayment()`, then attest + announce. Never throws — every
 * failure comes back as a typed outcome so the caller can alert on it.
 */
async function attemptStripeSettlement(
  paymentRequest: PaymentRequest,
  settlementRef: PaymentRequestSettlementRef,
): Promise<StripeSettlementOutcome> {
  try {
    const buyerDid = paymentRequest.recipientDid ?? paymentRequest.issuerDid;
    const nodeDid = (await getNodeDid()) || null;

    const plan = planStripeSettlement(paymentRequest, buyerDid, nodeDid);
    if (!plan.ok) return plan;
    const { resolvedChain, expectedTotal, taxCredits, totalTaxDollars } = plan.resolved;

    const settleResult = await settlePayment({
      from_did: buyerDid,
      // #2419: the widened validateChain invariant is chain + taxCredits == total_amount.
      total_amount: expectedTotal + totalTaxDollars,
      service: 'pay',
      type: 'payment_request',
      fair_manifest: { chain: resolvedChain, ...(taxCredits.length > 0 && { taxCredits }) },
      funded: true,
      funded_provider: 'stripe',
      metadata: { payment_request_id: paymentRequest.id },
      currency: paymentRequest.currency,
    });
    if ('error' in settleResult) return settlementFailure('settle_rejected', settleResult.error);

    await attestAndAnnounceStripeSettled(paymentRequest, settlementRef, nodeDid);
    return { ok: true };
  } catch (error) {
    return settlementFailure('settle_error', String(error));
  }
}

/**
 * #2439: the buyer's money has already moved through Stripe by the time a
 * settlement fails, so a bare log line is not enough — publish
 * `payment_request.settlement_failed`, whose default chain (`emit` +
 * `notify`, `packages/bus/src/config.ts`) puts an operator card on the
 * node DID. The retry path is `retryPaymentRequestStripeSettlement` below
 * (`POST /pay/api/admin/payment-requests/:id/retry-settlement`). Never throws.
 */
async function alertSettlementFailure(paymentRequest: PaymentRequest, failure: StripeSettlementFailure): Promise<void> {
  log.error(
    { paymentRequestId: paymentRequest.id, reason: failure.reason, error: failure.error },
    'payment_request stripe settle failed — operator alerted',
  );
  const nodeDid = await getNodeDid().catch(() => null);
  const operatorDid = nodeDid || paymentRequest.issuerDid;
  await publish('payment_request.settlement_failed', {
    issuer: operatorDid,
    subject: operatorDid,
    scope: 'pay',
    payload: {
      paymentRequestId: paymentRequest.id,
      reason: failure.reason,
      error: failure.error,
      issuerDid: paymentRequest.issuerDid,
      recipientDid: paymentRequest.recipientDid,
      totalAmount: paymentRequest.totalAmount,
      currency: paymentRequest.currency,
      method: 'stripe',
      context_id: paymentRequest.id,
      context_type: 'payment_request',
    },
  }).catch((error: unknown) => log.error({ err: String(error) }, 'payment_request.settlement_failed publish error'));
}

/**
 * Best-effort settle + attest, called only once — immediately after the
 * guarded `issued -> paid` transition wins. Never throws: a settle/
 * attestation failure is not fatal to the webhook response (Stripe must
 * still get its 200), matching every other post-primary-effect side action
 * in this codebase (see `settle-core.ts`'s `emitAttestations`,
 * `webhook-handlers.ts`'s `notifyCheckoutServices`) — but unlike those, a
 * failure here is alerted (#2439), not just logged.
 */
async function settleAndAttestStripePaid(
  paymentRequest: PaymentRequest,
  settlementRef: PaymentRequestSettlementRef,
): Promise<void> {
  const outcome = await attemptStripeSettlement(paymentRequest, settlementRef);
  if (!outcome.ok) await alertSettlementFailure(paymentRequest, outcome);
}

/**
 * Webhook-side handler for `checkout.session.completed` with
 * `metadata.payment_request_id`: transitions `issued -> paid`, publishes
 * `payment_request.paid`, then ALWAYS settles via `settlePayment()` and
 * mints the kernel-signed `payment_request.settled` attestation.
 *
 * Idempotent on webhook replay: the `issued -> paid` transition is a
 * guarded compare-and-swap (`WHERE status = 'issued'`), so once a request
 * has moved on (this session or a concurrent delivery already won the
 * race), a repeat delivery is a clean no-op — `settled: false`.
 */
export async function settlePaymentRequestFromStripeCheckout(
  input: SettlePaymentRequestFromStripeInput,
): Promise<SettledFromStripeResult | ServiceError> {
  const { paymentRequestId, checkoutSessionId, paymentIntentId } = input;

  const existing = await getPaymentRequestById(paymentRequestId);
  if (!existing) return err('payment_request not found', 404);

  if (existing.status !== 'issued') {
    return { paymentRequest: existing, settled: false };
  }

  const settledAt = new Date();
  const settlementRef: PaymentRequestSettlementRef = {
    method: 'stripe',
    checkout_session_id: checkoutSessionId,
    payment_intent_id: paymentIntentId,
    settled_at: settledAt.toISOString(),
  };

  const [paidRow] = await db
    .update(paymentRequests)
    .set({ status: 'paid', settlementRef, updatedAt: settledAt })
    .where(and(eq(paymentRequests.id, paymentRequestId), eq(paymentRequests.status, 'issued')))
    .returning();
  if (!paidRow) {
    // Lost a race against a concurrent webhook delivery — the other one settles.
    const current = await getPaymentRequestById(paymentRequestId);
    return { paymentRequest: current ?? existing, settled: false };
  }

  publish('payment_request.paid', {
    issuer: paidRow.issuerDid,
    subject: paidRow.recipientDid ?? paidRow.issuerDid,
    scope: 'pay',
    payload: {
      paymentRequestId: paidRow.id,
      issuerDid: paidRow.issuerDid,
      recipientDid: paidRow.recipientDid,
      totalAmount: paidRow.totalAmount,
      currency: paidRow.currency,
      settlementRef: settlementRef as unknown as Record<string, unknown>,
      context_id: paidRow.id,
      context_type: 'payment_request',
    },
  }).catch((error: unknown) => log.error({ err: String(error) }, 'payment_request.paid publish error'));

  await settleAndAttestStripePaid(paidRow, settlementRef);

  return { paymentRequest: paidRow, settled: true };
}


// ---------------------------------------------------------------------------
// Operator retry path (#2439)
// ---------------------------------------------------------------------------

export interface RetriedSettlementResult {
  paymentRequest: PaymentRequest;
  settled: true;
}

/** True when `settlePayment()` already wrote ledger rows for this payment_request — a retry must never settle twice. */
async function hasSettlementLedgerRows(paymentRequestId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.service, 'pay'),
        eq(transactions.type, 'payment_request'),
        eq(transactions.status, 'completed'),
        sql`${transactions.metadata}->>'payment_request_id' = ${paymentRequestId}`,
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Re-run the on-platform settlement for a payment_request that Stripe
 * collected but whose ledger settlement failed (#2439 — see
 * `payment_request.settlement_failed`). Operator-only (the route wrapping
 * this is admin-gated); never invoked automatically, because the failures
 * it recovers from — a stale manifest basis, an empty chain, a rejected
 * settlement — don't heal on their own and re-running blind could double-
 * credit. Preconditions:
 *   - the request is `paid` via Stripe (`settlementRef.method === 'stripe'`);
 *   - no settlement ledger rows exist yet for it (checked here; a request
 *     that already settled gets a 409, so a retry is safe to repeat).
 * A retry that fails again re-alerts the operator and returns 422 with the
 * reason, so the fix-then-retry loop is observable.
 */
export async function retryPaymentRequestStripeSettlement(
  paymentRequestId: string,
): Promise<RetriedSettlementResult | ServiceError> {
  const existing = await getPaymentRequestById(paymentRequestId);
  if (!existing) return err('payment_request not found', 404);

  const settlementRef = existing.settlementRef as PaymentRequestSettlementRef | null;
  if (existing.status !== 'paid' || settlementRef?.method !== 'stripe') {
    return err(
      `only a payment_request paid via Stripe (status 'paid') can be re-settled — this one is '${existing.status}'`,
      409,
    );
  }
  if (await hasSettlementLedgerRows(existing.id)) {
    return err('payment_request already has settlement ledger rows — refusing to settle twice', 409);
  }

  const outcome = await attemptStripeSettlement(existing, settlementRef);
  if (!outcome.ok) {
    await alertSettlementFailure(existing, outcome);
    return err(`settlement retry failed (${outcome.reason}): ${outcome.error}`, 422);
  }
  return { paymentRequest: existing, settled: true };
}
