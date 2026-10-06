/**
 * Pay Stripe bus consumer (#2177, item 4 of the #2173 seam cleanup).
 *
 * The legacy pay webhook routes (`app/pay/api/webhook/route.ts` and
 * `app/pay/api/connect/webhook/route.ts`) used to verify a Stripe delivery AND
 * run every business handler inline. They are now thin ingress: verify the
 * signature, then republish the verified delivery onto the #1785 connector bus
 * as a `stripe.*` event (see `stripe-relay.ts`). This module is the consumer
 * side of that seam — the `pay-stripe` reactor, configured as the awaited
 * chain for every `stripe.*` type in `packages/bus/src/config.ts` — and it is
 * where all of the handlers that previously lived in those routes now live,
 * byte-for-byte in behavior (the golden webhook suites still pin them).
 *
 * ## Settlement seam (#1073)
 * A payment_request-linked `checkout.session.completed` settles exclusively
 * through `settlePayment()` (`settle-core.ts`, the canonical `/api/settle`
 * core) via `settlePaymentRequestFromStripeCheckout`; the generic checkout
 * path books the processor fee and `.fair` chain distribution as before.
 *
 * ## Which events this consumes
 * Only events the webhook ingress relayed (they carry a `relayId` that
 * resolves in `stripe-relay-store.ts`). The connector's BYO-account events
 * (`connector.ts`, same `stripe.*` types) carry no `relayId`, so this reactor
 * ignores them — an owner's own Stripe events must never mutate the
 * platform's `pay.transactions`.
 *
 * ## Failure contract
 * `publish()` swallows reactor errors, so a failing handler is recorded on the
 * relay entry (`error`) instead; the ingress reads it back and answers 500 so
 * Stripe retries. Every handler below is idempotent per Stripe object, which
 * is what makes that retry safe.
 *
 * Never imports the `stripe` package (CI guard `ci-guard-stripe-import-scope`);
 * every SDK touch stays behind `providers/stripe-webhook.ts`.
 */

import { eq } from 'drizzle-orm';
import { registerReactor, publish, type ReactorHandler } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, transactions, feeLedger, connectedAccounts } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { toRailEvent } from '@/src/lib/pay/providers/stripe-webhook';
import { confirmWithdrawalFromRailEvent } from '@/src/lib/pay/withdraw-intent';
import { getWithdrawRailByName } from '@/src/lib/pay/rails/registry';
import { STRIPE_RAIL_NAME } from '@/src/lib/pay/providers/stripe-withdraw-rail';
import type { RailEvent } from '@/src/lib/pay/rails/types';
import {
  type FairManifest,
  type TxRow,
  fetchActualStripeFee,
  calculateEstimatedFee,
  reconcileStripeFee,
  processChainDistribution,
  handleTopupCheckout,
  notifyCheckoutServices,
  verifyWebhookManifestSignature,
} from '@/src/lib/pay/webhook-handlers';
import type {
  StripeAccountLike,
  StripeCheckoutSessionLike,
  StripePaymentIntentLike,
  StripePayoutLike,
  StripeSubscriptionLike,
  StripeInvoiceLike,
} from '@/src/lib/pay/webhook-event-shapes';
import { settlePaymentRequestFromStripeCheckout } from '@/src/lib/pay/payment-requests/checkout';
import { getRelayEntry, type StripeRelaySource } from '@/src/lib/pay/stripe-relay-store';

const log = createLogger('kernel');

/** Name the consumer registers under — referenced by the `stripe.*` chains in `packages/bus/src/config.ts`. */
export const PAY_STRIPE_REACTOR = 'pay-stripe';

type StripeEventHandler = (stripeEvent: unknown) => Promise<void>;

/** Adapt a `RailEvent` handler: normalize the verified Stripe event first. */
function onRailEvent(handler: (event: RailEvent, stripeEvent: unknown) => Promise<void>): StripeEventHandler {
  return async (stripeEvent) => {
    const railEvent = toRailEvent(stripeEvent);
    if (!railEvent) {
      throw new Error('stripe event is not normalizable to a RailEvent');
    }
    await handler(railEvent, stripeEvent);
  };
}

/** `transfer.created` isn't normalized to a `RailEvent` (see `toRailEvent`'s doc comment) — it stays on the `WithdrawRail.confirmFromEvent` fast path, which expects the raw verified event. */
async function handleTransferCreated(stripeEvent: unknown): Promise<void> {
  // #2172 webhook fast path: confirms a withdrawal intent as soon as Stripe
  // reports the transfer, instead of waiting for the reconciliation cron
  // sweep. Idempotent on intent id — see `confirmWithdrawalFromRailEvent`.
  const stripeRail = getWithdrawRailByName(STRIPE_RAIL_NAME);
  const intentId = stripeRail ? await confirmWithdrawalFromRailEvent(stripeRail, stripeEvent) : null;
  log.info({ intentId }, 'Transfer created');
}

/** Platform-account webhook (`POST /pay/api/webhook`, `STRIPE_WEBHOOK_SECRET`). */
const PLATFORM_HANDLERS: Readonly<Record<string, StripeEventHandler>> = {
  'payment_intent.succeeded': onRailEvent(handlePaymentSucceeded),
  'payment_intent.payment_failed': onRailEvent(handlePaymentFailed),
  'checkout.session.completed': onRailEvent(handleCheckoutCompleted),
  'customer.subscription.created': onRailEvent(handleSubscriptionCreated),
  'customer.subscription.updated': onRailEvent(handleSubscriptionUpdated),
  'customer.subscription.deleted': onRailEvent(handleSubscriptionDeleted),
  'invoice.paid': onRailEvent(handleInvoicePaid),
  'transfer.created': handleTransferCreated,
};

/** Connect-account webhook (`POST /pay/api/connect/webhook`, `STRIPE_CONNECT_WEBHOOK_SECRET`). */
const CONNECT_HANDLERS: Readonly<Record<string, StripeEventHandler>> = {
  'account.updated': onRailEvent(handleAccountUpdated),
  'payout.paid': onRailEvent((event, stripeEvent) => handlePayoutEvent('Connect payout.paid', event, stripeEvent)),
  'payout.failed': onRailEvent((event, stripeEvent) => handlePayoutEvent('Connect payout.failed', event, stripeEvent)),
};

const HANDLERS_BY_SOURCE: Readonly<Record<StripeRelaySource, Readonly<Record<string, StripeEventHandler>>>> = {
  platform: PLATFORM_HANDLERS,
  connect: CONNECT_HANDLERS,
};

/** True when `eventType` has a pay handler for deliveries verified by `source`'s endpoint. */
export function hasStripeBusHandler(source: StripeRelaySource, eventType: string): boolean {
  return Object.hasOwn(HANDLERS_BY_SOURCE[source], eventType);
}

/**
 * The `pay-stripe` reactor. Resolves the relayed delivery from its `relayId`,
 * runs the matching handler, and records the outcome on the relay entry for
 * the ingress to read back (see the module docblock's failure contract).
 */
export const payStripeReactor: ReactorHandler = async (event) => {
  const relayId = event.payload?.relayId;
  if (typeof relayId !== 'string') return;

  const entry = getRelayEntry(relayId);
  if (!entry) return;

  const stripeEvent = entry.stripeEvent as { type?: unknown } | null | undefined;
  const eventType = typeof stripeEvent?.type === 'string' ? stripeEvent.type : '';
  const handler = HANDLERS_BY_SOURCE[entry.source][eventType];
  if (!handler) {
    entry.error = `no pay handler for ${entry.source} event type "${eventType}"`;
    log.error({ eventType, source: entry.source }, 'pay-stripe reactor: no handler for relayed event');
    return;
  }

  try {
    await handler(entry.stripeEvent);
    entry.handled = true;
  } catch (error) {
    entry.error = String(error);
    log.error({ err: String(error), eventType, source: entry.source }, 'Webhook handler error');
  }
};

let reactorRegistered = false;

/**
 * Register the `pay-stripe` reactor with the bus. Idempotent. Called by the
 * relay before every publish AND by the BYO connector before its own publish
 * (`stripe/connector.ts`): the `stripe.*` default chains reference this reactor
 * by name and `publish()` throws on an unregistered one, so any process that
 * can publish a `stripe.*` event must have registered it first.
 */
export function ensurePayStripeReactorRegistered(): void {
  if (reactorRegistered) return;
  registerReactor(PAY_STRIPE_REACTOR, payStripeReactor);
  reactorRegistered = true;
}

// =============================================================================
// Connect handlers (relocated from app/pay/api/connect/webhook/route.ts)
// =============================================================================

async function handleAccountUpdated(event: RailEvent): Promise<void> {
  const account = event.raw as unknown as StripeAccountLike;

  const rows = await db
    .select()
    .from(connectedAccounts)
    .where(eq(connectedAccounts.stripeAccountId, account.id))
    .limit(1);

  if (rows.length === 0) return;

  const chargesEnabled = account.charges_enabled ?? false;
  const payoutsEnabled = account.payouts_enabled ?? false;
  const detailsSubmitted = account.details_submitted ?? false;

  await db
    .update(connectedAccounts)
    .set({
      chargesEnabled,
      payoutsEnabled,
      detailsSubmitted,
      onboardingComplete: chargesEnabled && payoutsEnabled && detailsSubmitted,
      currentlyDue: account.requirements?.currently_due ?? [],
      eventuallyDue: account.requirements?.eventually_due ?? [],
      updatedAt: new Date(),
    })
    .where(eq(connectedAccounts.stripeAccountId, account.id));
}

async function handlePayoutEvent(label: string, event: RailEvent, stripeEvent: unknown): Promise<void> {
  const payout = event.raw as unknown as StripePayoutLike;
  const connectAccountId = (stripeEvent as { account?: string } | undefined)?.account;
  log.info({ account: connectAccountId, payoutId: payout.id, amount: payout.amount, currency: payout.currency }, label);
}

// =============================================================================
// Platform handlers (relocated from app/pay/api/webhook/route.ts)
// =============================================================================

async function handlePaymentSucceeded(event: RailEvent) {
  const paymentIntent = event.raw as unknown as StripePaymentIntentLike;

  // Idempotency: skip if already completed
  const existing = await db.select().from(transactions).where(eq(transactions.stripeId, paymentIntent.id)).limit(1);
  if (existing[0]?.status === 'completed') {
    log.info({ paymentIntentId: paymentIntent.id }, 'Payment already completed, skipping');
    return;
  }

  // Check if this is an escrow release
  if (paymentIntent.metadata.escrow === 'true') {
    log.info({ id: paymentIntent.id, from: paymentIntent.metadata.from_did, to: paymentIntent.metadata.to_did, amount: paymentIntent.amount }, 'Escrow released');
    // see: escrow release does not yet notify the parties or persist an escrow record
    return;
  }

  // Regular payment
  log.info({ id: paymentIntent.id, amount: paymentIntent.amount, currency: paymentIntent.currency, metadata: paymentIntent.metadata }, 'Regular payment completed');

  // Update transaction status to completed
  await db
    .update(transactions)
    .set({ status: 'completed' })
    .where(eq(transactions.stripeId, paymentIntent.id));

  log.info({ stripeId: paymentIntent.id }, 'Transaction updated');

  publish('payment.charge', {
    issuer: process.env.PLATFORM_DID || 'system',
    subject: paymentIntent.metadata?.buyerDid || paymentIntent.metadata?.from_did || 'unknown',
    scope: 'pay',
    payload: { paymentIntentId: paymentIntent.id, amount: paymentIntent.amount, currency: paymentIntent.currency, service: paymentIntent.metadata.service },
  }).catch((err) => log.error({ err: String(err) }, 'payment.charge publish error'));

  // Notify originating service
  if (paymentIntent.metadata.service === 'coffee') {
    await notifyCoffeeService('payment.succeeded', paymentIntent);
  }
}

async function handlePaymentFailed(event: RailEvent) {
  const paymentIntent = event.raw as unknown as StripePaymentIntentLike;

  log.info({ id: paymentIntent.id, amount: paymentIntent.amount, lastError: paymentIntent.last_payment_error?.message }, 'Payment failed');

  // Update transaction status to failed
  await db
    .update(transactions)
    .set({ status: 'failed' })
    .where(eq(transactions.stripeId, paymentIntent.id));

  // Notify originating service
  if (paymentIntent.metadata.service === 'coffee') {
    await notifyCoffeeService('payment.failed', paymentIntent);
  }
}

async function handleCheckoutCompleted(event: RailEvent) {
  const session = event.raw as unknown as StripeCheckoutSessionLike;

  // #2209: a payment_request-linked checkout is a structurally different
  // flow (settle exclusively via settlePayment(), never the generic
  // feeLedger/balanceRollups chain distribution below) — fully separate
  // code path, so it can never interact with or alter the generic checkout
  // behavior for non-payment_request sessions.
  if (session.metadata?.payment_request_id) {
    await handlePaymentRequestCheckoutCompleted(session);
    return;
  }

  // Idempotency: skip if already completed
  const existing = await db.select().from(transactions).where(eq(transactions.stripeId, session.id)).limit(1);
  if (existing[0]?.status === 'completed') {
    log.info({ sessionId: session.id }, 'Checkout already completed, skipping');
    return;
  }

  log.info({ id: session.id, customerEmail: session.customer_email, amountTotal: session.amount_total, metadata: session.metadata }, 'Checkout completed');

  await db.update(transactions).set({ status: 'completed' }).where(eq(transactions.stripeId, session.id));

  const [tx] = await db.select().from(transactions).where(eq(transactions.stripeId, session.id)).limit(1);
  await processFairManifest(session, tx as (TxRow & { fairManifest?: unknown }) | undefined);

  if (session.metadata?.service === 'topup') {
    await handleTopupCheckout(session);
    return;
  }

  await notifyCheckoutServices(session);
}

/**
 * `checkout.session.completed` for a payment_request-linked session
 * (#2209): marks the request `paid`, publishes `payment_request.paid`,
 * ALWAYS settles via `settlePayment()`, and mints the kernel-signed
 * `payment_request.settled` attestation. Idempotent on webhook replay —
 * see `settlePaymentRequestFromStripeCheckout`'s doc comment.
 */
async function handlePaymentRequestCheckoutCompleted(session: StripeCheckoutSessionLike): Promise<void> {
  const paymentRequestId = session.metadata?.payment_request_id;
  if (!paymentRequestId) return;

  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;

  const result = await settlePaymentRequestFromStripeCheckout({
    paymentRequestId,
    checkoutSessionId: session.id,
    paymentIntentId,
  });

  if ('error' in result) {
    log.error(
      { paymentRequestId, sessionId: session.id, error: result.error },
      'payment_request checkout webhook error',
    );
    return;
  }
  if (!result.settled) {
    log.info({ paymentRequestId, sessionId: session.id }, 'payment_request checkout webhook: already processed, no-op');
  }
}

/**
 * Record the Stripe processor fee, reconcile estimate vs actual, then
 * distribute the remaining amount across the .fair manifest chain.
 */
async function processFairManifest(
  session: StripeCheckoutSessionLike,
  tx: (TxRow & { fairManifest?: unknown }) | undefined,
): Promise<void> {
  if (!tx?.fairManifest) return;

  const manifest = tx.fairManifest as FairManifest;
  const totalAmountCents = session.amount_total || 0;
  if (!manifest.chain || totalAmountCents <= 0) return;

  const currency = (session.currency || 'usd').toUpperCase();
  const buyerDid = session.metadata?.buyerDid || session.metadata?.identity_id || null;

  // #1073: attempt manifest signature verification before distributing the
  // chain. Never blocks — Stripe has already collected the money — it only
  // makes an absent/invalid signature loud (settlement.manifest.unverified)
  // instead of the prior silent no-check-at-all behavior.
  await verifyWebhookManifestSignature({
    fair_manifest: manifest as unknown as Record<string, unknown>,
    from_did: buyerDid || 'unknown',
    service: tx.service || 'unknown',
  });

  const actualFeeCents = await fetchActualStripeFee(session, tx.id);
  const estimatedFeeCents = calculateEstimatedFee(manifest, totalAmountCents);
  const processingFeeCents = actualFeeCents ?? estimatedFeeCents;

  await recordProcessingFee(tx, processingFeeCents, currency);

  if (actualFeeCents !== null && actualFeeCents !== estimatedFeeCents) {
    await reconcileStripeFee({ tx, manifest, actualFeeCents, estimatedFeeCents, currency });
  }

  // #2435: `totalAmountCents` is the gross Stripe charge (tax included). The
  // processor-fee estimate above intentionally stays on gross (the seller
  // absorbs Stripe's fee on the tax portion), but chain shares are computed
  // on the pre-tax basis only and each tax row is booked as a trust liability.
  await processChainDistribution({
    tx,
    totalAmountCents,
    currency,
    buyerDid,
    chain: manifest.chain,
    taxes: Array.isArray(manifest.taxes) ? manifest.taxes : undefined,
  });
}

/** Insert the Stripe processor fee-ledger row and fire its bus event. */
async function recordProcessingFee(tx: TxRow, amountCents: number, currency: string): Promise<void> {
  await db.insert(feeLedger).values({
    id: generateId('fl'),
    transactionId: tx.id,
    recipientDid: 'stripe:processor',
    role: 'processor',
    amountCents,
    currency,
    status: 'paid_out',
  });

  publish('fee.record', {
    issuer: process.env.PLATFORM_DID || 'system',
    subject: 'stripe:processor',
    scope: 'pay',
    payload: { transactionId: tx.id, recipientDid: 'stripe:processor', role: 'processor', amountCents, currency },
  }).catch((err) => log.error({ err: String(err) }, 'fee.record publish error'));
}
/**
 * Notify coffee service about payment completion or failure
 */
async function notifyCoffeeService(
  type: 'payment.succeeded' | 'payment.failed',
  paymentIntent: StripePaymentIntentLike
) {
  const coffeeServiceUrl = process.env.COFFEE_SERVICE_URL!;
  const webhookSecret = process.env.COFFEE_WEBHOOK_SECRET!;

  try {
    const response = await fetch(`${coffeeServiceUrl}/api/webhook/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${webhookSecret}`,
      },
      body: JSON.stringify({
        type,
        tipId: paymentIntent.metadata.tipId,
        pageId: paymentIntent.metadata.pageId,
        pageHandle: paymentIntent.metadata.pageHandle,
        amount: paymentIntent.amount,
        paymentId: paymentIntent.id,
        to_did: paymentIntent.metadata.to_did,
        fromDid: paymentIntent.metadata.fromDid,
        fromName: paymentIntent.metadata.fromName,
        fromEmail: paymentIntent.receipt_email || null,
        message: paymentIntent.metadata.message || null,
        stripeSessionId: paymentIntent.id,
        status: type === 'payment.succeeded' ? 'completed' : 'failed',
      }),
    });

    if (response.ok) {
      log.info({}, 'Coffee service notified successfully');
    } else {
      const error = await response.text();
      log.error({ error }, 'Coffee service webhook failed');
    }
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to notify coffee service');
    // Don't throw - we don't want to fail the Stripe webhook
  }
}

async function handleSubscriptionCreated(event: RailEvent) {
  const subscription = event.raw as unknown as StripeSubscriptionLike;

  log.info({ id: subscription.id, customerId: subscription.customer, subscriptionStatus: subscription.status }, 'Subscription created');

  // Create a new transaction for the subscription
  const amount = subscription.items.data[0]?.price?.unit_amount || 0;
  const txId = generateId('tx');

  await db.insert(transactions).values({
    id: txId,
    service: subscription.metadata?.service || 'subscription',
    type: 'subscription',
    fromDid: subscription.metadata?.from_did || null,
    toDid: subscription.metadata?.to_did || 'platform',
    amount: (amount / 100).toString(),
    currency: (subscription.currency || 'usd').toUpperCase(),
    status: 'completed',
    stripeId: subscription.id,
    metadata: subscription.metadata,
  });
}

async function handleSubscriptionUpdated(event: RailEvent) {
  const subscription = event.raw as unknown as StripeSubscriptionLike;

  log.info({ id: subscription.id, customerId: subscription.customer, subscriptionStatus: subscription.status }, 'Subscription updated');

  // Log the status change as a transaction metadata update
  // (no new transaction row — status changes are informational)
  if (subscription.metadata?.service === 'coffee') {
    await notifyCoffeeServiceSubscription('subscription.updated', subscription);
  }
}

async function handleSubscriptionDeleted(event: RailEvent) {
  const subscription = event.raw as unknown as StripeSubscriptionLike;

  log.info({ id: subscription.id, customerId: subscription.customer }, 'Subscription canceled');

  // Notify originating service about cancellation
  if (subscription.metadata?.service === 'coffee') {
    await notifyCoffeeServiceSubscription('subscription.canceled', subscription);
  }
}

async function handleInvoicePaid(event: RailEvent) {
  const invoice = event.raw as unknown as StripeInvoiceLike;

  log.info({ id: invoice.id, amount: invoice.amount_paid, currency: invoice.currency, subscriptionId: invoice.subscription }, 'Invoice paid');

  // Only process subscription renewals (invoices linked to a subscription)
  if (!invoice.subscription) {
    return;
  }

  // Extract metadata from the subscription object on the invoice
  const subscriptionMetadata = (invoice.subscription_details?.metadata || {}) as Record<string, string>;

  const txId = generateId('tx');
  await db.insert(transactions).values({
    id: txId,
    service: subscriptionMetadata.service || 'subscription',
    type: 'subscription',
    fromDid: subscriptionMetadata.from_did || null,
    toDid: subscriptionMetadata.to_did || 'platform',
    amount: (invoice.amount_paid / 100).toString(),
    currency: (invoice.currency || 'usd').toUpperCase(),
    status: 'completed',
    stripeId: invoice.id,
    metadata: {
      ...subscriptionMetadata,
      subscription_id: typeof invoice.subscription === 'string'
        ? invoice.subscription
        : invoice.subscription?.id || '',
      invoice_number: invoice.number || '',
    },
  });

  log.info({ txId }, 'Subscription renewal transaction created');

  // Notify originating service
  if (subscriptionMetadata.service === 'coffee') {
    await notifyCoffeeServiceSubscription('subscription.renewed', null, invoice, subscriptionMetadata);
  }
}

/**
 * Notify coffee service about subscription events
 */
async function notifyCoffeeServiceSubscription(
  type: 'subscription.updated' | 'subscription.canceled' | 'subscription.renewed',
  subscription: StripeSubscriptionLike | null,
  invoice?: StripeInvoiceLike,
  metadata?: Record<string, string>
) {
  const coffeeServiceUrl = process.env.COFFEE_SERVICE_URL!;
  const webhookSecret = process.env.COFFEE_WEBHOOK_SECRET!;

  if (!coffeeServiceUrl || !webhookSecret) {
    log.warn({}, 'Coffee service URL or webhook secret not configured');
    return;
  }

  let invoiceSubscriptionId: string | undefined;
  if (invoice?.subscription) {
    invoiceSubscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
  } else {
    invoiceSubscriptionId = undefined;
  }

  try {
    const response = await fetch(`${coffeeServiceUrl}/api/webhook/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${webhookSecret}`,
      },
      body: JSON.stringify({
        type,
        subscriptionId: subscription?.id || invoiceSubscriptionId,
        invoiceId: invoice?.id,
        amount: invoice?.amount_paid,
        status: type === 'subscription.canceled' ? 'canceled' : 'active',
        metadata: metadata || subscription?.metadata,
      }),
    });

    if (response.ok) {
      log.info({ type }, 'Coffee service notified of subscription event');
    } else {
      const error = await response.text();
      log.error({ error }, 'Coffee service subscription webhook failed');
    }
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to notify coffee service of subscription event');
  }
}
