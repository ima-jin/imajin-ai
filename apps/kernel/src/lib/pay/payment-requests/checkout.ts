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
import { resolveSettlementChain, type FairSettlementEntry } from '@imajin/fair';
import { getPaymentService } from '../pay';
import { getStripe } from '../stripe';
import { resolveConnectedAccountFee, type CheckoutBody, type CheckoutItem } from '../checkout';
import type { CheckoutRequest, FiatCurrency } from '../types';
import { settlePayment } from '../settle-core';
import { getPaymentRequestById, type ServiceError } from './service';
import { emitPaymentRequestSettledStripeAttestation } from './attestations';
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
    const stripe = getStripe();
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

  const items = toCheckoutItems(existing.lineItems);
  const fairManifest = existing.fairManifest as unknown as CheckoutBody['fairManifest'];

  // `successUrl`/`cancelUrl` are part of the shared `CheckoutBody` shape but
  // are never read by `resolveConnectedAccountFee` (fee computation only) —
  // the real ones are built below, once fee resolution has succeeded.
  const feeResult = await resolveConnectedAccountFee({
    items,
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
 * Best-effort settle + attest, called only once — immediately after the
 * guarded `issued -> paid` transition wins. Never throws: a settle/
 * attestation failure is logged, not fatal to the webhook response, matching
 * every other post-primary-effect side action in this codebase (see
 * `settle-core.ts`'s `emitAttestations`, `webhook-handlers.ts`'s
 * `notifyCheckoutServices`).
 */
async function settleAndAttestStripePaid(
  paymentRequest: PaymentRequest,
  settlementRef: PaymentRequestSettlementRef,
): Promise<void> {
  try {
    const manifest = paymentRequest.fairManifest as unknown as PaymentRequestFairManifest;
    const chain = (manifest?.chain ?? []) as FairSettlementEntry[];
    if (chain.length === 0) {
      log.error(
        { paymentRequestId: paymentRequest.id },
        'payment_request stripe settle skipped: fair_manifest.chain is empty',
      );
      return;
    }

    const buyerDid = paymentRequest.recipientDid ?? paymentRequest.issuerDid;
    const nodeDid = (await getNodeDid()) || null;

    const { resolvedChain, expectedTotal } = resolveSettlementChain({
      amountCents: paymentRequest.totalAmount,
      chain,
      fees: manifest?.fees as Array<{ role: string; rateBps: number; fixedCents: number }> | undefined,
      buyerDid,
      nodeDid,
    });

    const settleResult = await settlePayment({
      from_did: buyerDid,
      total_amount: expectedTotal,
      service: 'pay',
      type: 'payment_request',
      fair_manifest: { chain: resolvedChain },
      funded: true,
      funded_provider: 'stripe',
      metadata: { payment_request_id: paymentRequest.id },
      currency: paymentRequest.currency,
    });

    if ('error' in settleResult) {
      log.error(
        { paymentRequestId: paymentRequest.id, error: settleResult.error },
        'payment_request stripe settle failed',
      );
      return;
    }

    const attestationId = await emitPaymentRequestSettledStripeAttestation({
      paymentRequestId: paymentRequest.id,
      issuerDid: paymentRequest.issuerDid,
      recipientDid: paymentRequest.recipientDid,
      contentHash: paymentRequest.contentHash,
      totalAmount: paymentRequest.totalAmount,
      currency: paymentRequest.currency,
      settlementRef,
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
  } catch (error) {
    log.error({ err: String(error), paymentRequestId: paymentRequest.id }, 'payment_request stripe settle error');
  }
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
