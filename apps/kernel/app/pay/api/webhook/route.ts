/**
 * POST /api/webhook
 *
 * Stripe webhook handler for async payment events.
 *
 * Events handled:
 * - payment_intent.succeeded
 * - payment_intent.payment_failed
 * - checkout.session.completed
 * - customer.subscription.created
 * - customer.subscription.updated
 * - customer.subscription.deleted
 * - invoice.paid
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { db, transactions, feeLedger } from '@/src/db';
import { eq } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { createLogger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { getStripe } from '@/src/lib/pay/stripe';
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

const log = createLogger('kernel');

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    log.error({}, 'STRIPE_WEBHOOK_SECRET not configured');
    return NextResponse.json(
      { error: 'Webhook not configured' },
      { status: 500 }
    );
  }
  
  const body = await request.text();
  const signature = request.headers.get('stripe-signature');
  
  if (!signature) {
    return NextResponse.json(
      { error: 'Missing stripe-signature header' },
      { status: 400 }
    );
  }
  
  let event: Stripe.Event;
  
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    log.error({ err: String(err) }, 'Webhook signature verification failed');
    return NextResponse.json(
      { error: 'Invalid signature' },
      { status: 400 }
    );
  }
  
  // Handle the event
  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        log.info({ paymentIntentId: paymentIntent.id }, 'Payment succeeded');
        // TODO: Update order status, send confirmation, etc.
        await handlePaymentSucceeded(paymentIntent);
        break;
      }
      
      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        log.info({ paymentIntentId: paymentIntent.id }, 'Payment failed');
        // TODO: Notify customer, update order status
        await handlePaymentFailed(paymentIntent);
        break;
      }
      
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        log.info({ sessionId: session.id }, 'Checkout completed');
        // TODO: Fulfill order, send receipt
        await handleCheckoutCompleted(session);
        break;
      }
      
      case 'customer.subscription.created': {
        const subscription = event.data.object as Stripe.Subscription;
        log.info({ subscriptionId: subscription.id }, 'Subscription created');
        // TODO: Provision access
        await handleSubscriptionCreated(subscription);
        break;
      }
      
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        log.info({ subscriptionId: subscription.id }, 'Subscription updated');
        await handleSubscriptionUpdated(subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        log.info({ subscriptionId: subscription.id }, 'Subscription canceled');
        await handleSubscriptionDeleted(subscription);
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        log.info({ invoiceId: invoice.id }, 'Invoice paid');
        await handleInvoicePaid(invoice);
        break;
      }

      default:
        log.info({ eventType: event.type }, 'Unhandled event type');
    }
    
    return NextResponse.json({ received: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Webhook handler error');
    return NextResponse.json(
      { error: 'Webhook handler failed' },
      { status: 500 }
    );
  }
}

// =============================================================================
// Event Handlers (implement these based on your needs)
// =============================================================================

async function handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent) {
  // Idempotency: skip if already completed
  const existing = await db.select().from(transactions).where(eq(transactions.stripeId, paymentIntent.id)).limit(1);
  if (existing[0]?.status === 'completed') {
    log.info({ paymentIntentId: paymentIntent.id }, 'Payment already completed, skipping');
    return;
  }

  // Check if this is an escrow release
  if (paymentIntent.metadata.escrow === 'true') {
    log.info({ id: paymentIntent.id, from: paymentIntent.metadata.from_did, to: paymentIntent.metadata.to_did, amount: paymentIntent.amount }, 'Escrow released');
    // TODO: Notify parties, update escrow record
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

async function handlePaymentFailed(paymentIntent: Stripe.PaymentIntent) {
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

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
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
 * Record the Stripe processor fee, reconcile estimate vs actual, then
 * distribute the remaining amount across the .fair manifest chain.
 */
async function processFairManifest(
  session: Stripe.Checkout.Session,
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

  await processChainDistribution({
    tx,
    totalAmountCents,
    currency,
    buyerDid,
    chain: manifest.chain,
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
  paymentIntent: Stripe.PaymentIntent
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

async function handleSubscriptionCreated(subscription: Stripe.Subscription) {
  log.info({ id: subscription.id, customerId: subscription.customer, subscriptionStatus: subscription.status }, 'Subscription created');

  // Create a new transaction for the subscription
  const amount = subscription.items.data[0]?.price.unit_amount || 0;
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

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  log.info({ id: subscription.id, customerId: subscription.customer, subscriptionStatus: subscription.status }, 'Subscription updated');

  // Log the status change as a transaction metadata update
  // (no new transaction row — status changes are informational)
  if (subscription.metadata?.service === 'coffee') {
    await notifyCoffeeServiceSubscription('subscription.updated', subscription);
  }
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  log.info({ id: subscription.id, customerId: subscription.customer }, 'Subscription canceled');

  // Notify originating service about cancellation
  if (subscription.metadata?.service === 'coffee') {
    await notifyCoffeeServiceSubscription('subscription.canceled', subscription);
  }
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
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
  subscription: Stripe.Subscription | null,
  invoice?: Stripe.Invoice,
  metadata?: Record<string, string>
) {
  const coffeeServiceUrl = process.env.COFFEE_SERVICE_URL!;
  const webhookSecret = process.env.COFFEE_WEBHOOK_SECRET!;

  if (!coffeeServiceUrl || !webhookSecret) {
    log.warn({}, 'Coffee service URL or webhook secret not configured');
    return;
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
        subscriptionId: subscription?.id || (invoice?.subscription
          ? (typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id)
          : undefined),
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
