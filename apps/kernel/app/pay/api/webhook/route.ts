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
import { db, transactions, feeLedger, balances, balanceRollups } from '@/src/db';
import { eq, sql } from 'drizzle-orm';
import { generateId } from '@/src/lib/kernel/id';
import { notify } from '@imajin/notify';

// Lazy Stripe initialization to avoid build-time errors in CI
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY not configured');
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
    });
  }
  return _stripe;
}

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
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
    console.error('Webhook signature verification failed:', err);
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
        console.log('Payment succeeded:', paymentIntent.id);
        // TODO: Update order status, send confirmation, etc.
        await handlePaymentSucceeded(paymentIntent);
        break;
      }
      
      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        console.log('Payment failed:', paymentIntent.id);
        // TODO: Notify customer, update order status
        await handlePaymentFailed(paymentIntent);
        break;
      }
      
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        console.log('Checkout completed:', session.id);
        // TODO: Fulfill order, send receipt
        await handleCheckoutCompleted(session);
        break;
      }
      
      case 'customer.subscription.created': {
        const subscription = event.data.object as Stripe.Subscription;
        console.log('Subscription created:', subscription.id);
        // TODO: Provision access
        await handleSubscriptionCreated(subscription);
        break;
      }
      
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        console.log('Subscription updated:', subscription.id);
        await handleSubscriptionUpdated(subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        console.log('Subscription canceled:', subscription.id);
        await handleSubscriptionDeleted(subscription);
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        console.log('Invoice paid:', invoice.id);
        await handleInvoicePaid(invoice);
        break;
      }

      default:
        console.log('Unhandled event type:', event.type);
    }
    
    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('Webhook handler error:', error);
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
    console.log('Payment already completed, skipping:', paymentIntent.id);
    return;
  }

  // Check if this is an escrow release
  if (paymentIntent.metadata.escrow === 'true') {
    console.log('Escrow released:', {
      id: paymentIntent.id,
      from: paymentIntent.metadata.from_did,
      to: paymentIntent.metadata.to_did,
      amount: paymentIntent.amount,
    });
    // TODO: Notify parties, update escrow record
    return;
  }

  // Regular payment
  console.log('Payment completed:', {
    id: paymentIntent.id,
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    metadata: paymentIntent.metadata,
  });

  // Update transaction status to completed
  const updated = await db
    .update(transactions)
    .set({ status: 'completed' })
    .where(eq(transactions.stripeId, paymentIntent.id));

  console.log('Transaction updated:', { stripeId: paymentIntent.id, updated });

  // Notify originating service
  if (paymentIntent.metadata.service === 'coffee') {
    await notifyCoffeeService('payment.succeeded', paymentIntent);
  }
}

async function handlePaymentFailed(paymentIntent: Stripe.PaymentIntent) {
  console.log('Payment failed:', {
    id: paymentIntent.id,
    amount: paymentIntent.amount,
    lastError: paymentIntent.last_payment_error?.message,
  });

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
    console.log('Checkout already completed, skipping:', session.id);
    return;
  }

  console.log('Checkout completed:', {
    id: session.id,
    customerEmail: session.customer_email,
    amountTotal: session.amount_total,
    metadata: session.metadata,
  });

  // Update transaction status to completed
  await db
    .update(transactions)
    .set({ status: 'completed' })
    .where(eq(transactions.stripeId, session.id));

  // Fee ledger: subdivide payment per .fair manifest
  const [tx] = await db.select().from(transactions).where(eq(transactions.stripeId, session.id)).limit(1);

  if (tx?.fairManifest) {
    const manifest = tx.fairManifest as { chain?: Array<{ did: string; role: string; share: number }> };
    const totalAmountCents = session.amount_total || 0;
    const currency = (session.currency || 'usd').toUpperCase();
    const buyerDid = session.metadata?.buyerDid || session.metadata?.identity_id || null;

    if (manifest.chain && totalAmountCents > 0) {
      for (const entry of manifest.chain) {
        const amountCents = Math.round(totalAmountCents * entry.share);
        if (amountCents <= 0) continue;

        // Resolve BUYER_PLACEHOLDER to actual buyer DID
        const recipientDid = entry.did === 'BUYER_PLACEHOLDER' ? (buyerDid || 'unresolved') : entry.did;

        const isSeller = entry.role === 'seller';
        const isBuyerCredit = entry.role === 'buyer_credit';
        const status = isSeller ? 'paid_out' : 'accrued';

        // Insert fee ledger row
        await db.insert(feeLedger).values({
          id: generateId('fl'),
          transactionId: tx.id,
          recipientDid,
          role: entry.role,
          amountCents,
          currency,
          status,
        });

        // Increment balance (skip unresolved and seller — seller's money is already in their Stripe)
        if (recipientDid !== 'unresolved' && !isSeller) {
          if (isBuyerCredit) {
            // Buyer credit goes to creditAmount (virtual MJN)
            await db.insert(balances).values({
              did: recipientDid,
              cashAmount: '0',
              creditAmount: (amountCents / 100).toFixed(8),
              currency,
            }).onConflictDoUpdate({
              target: balances.did,
              set: {
                creditAmount: sql`${balances.creditAmount} + ${(amountCents / 100).toFixed(8)}`,
                updatedAt: new Date(),
              },
            });
          } else {
            // Fee beneficiaries (protocol, node, scope) get cashAmount — held in Imajin account
            await db.insert(balances).values({
              did: recipientDid,
              cashAmount: (amountCents / 100).toFixed(8),
              creditAmount: '0',
              currency,
            }).onConflictDoUpdate({
              target: balances.did,
              set: {
                cashAmount: sql`${balances.cashAmount} + ${(amountCents / 100).toFixed(8)}`,
                updatedAt: new Date(),
              },
            });
          }

          // Update daily rollup
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          await db.insert(balanceRollups).values({
            did: recipientDid,
            date: today,
            service: tx.service || 'unknown',
            earned: (amountCents / 100).toFixed(8),
            spent: '0',
            txCount: 1,
          }).onConflictDoUpdate({
            target: [balanceRollups.did, balanceRollups.date, balanceRollups.service],
            set: {
              earned: sql`${balanceRollups.earned} + ${(amountCents / 100).toFixed(8)}`,
              txCount: sql`${balanceRollups.txCount} + 1`,
            },
          });
        }
      }
    }
  }

  // Notify the originating service based on metadata
  // Events service handles event tickets
  if (session.metadata?.eventId) {
    await notifyEventsService('checkout.completed', session);
  }

  // Market: fire sale + purchase notifications
  if (session.metadata?.service === 'market' && session.metadata?.sellerDid) {
    const sellerDid = session.metadata.sellerDid;
    const buyerDid = session.metadata.buyerDid;
    const listingTitle = session.metadata.listingTitle;
    const amount = session.amount_total ?? 0;
    const currency = (session.currency ?? 'usd').toUpperCase();
    const buyerEmail = session.customer_email || session.customer_details?.email || undefined;
    const buyerName = session.customer_details?.name || undefined;

    notify.send({
      to: sellerDid,
      scope: "market:sale",
      data: {
        listingTitle,
        amount,
        currency,
        ...(buyerName && { buyerName }),
      },
    }).catch((err) => console.error("Notify market:sale error:", err));

    if (buyerDid) {
      notify.send({
        to: buyerDid,
        scope: "market:purchase",
        data: {
          ...(buyerEmail && { email: buyerEmail }),
          listingTitle,
          amount,
          currency,
        },
      }).catch((err) => console.error("Notify market:purchase error:", err));
    }
  }
}

/**
 * Notify events service about payment completion
 */
async function notifyEventsService(
  type: 'checkout.completed' | 'payment.failed',
  session: Stripe.Checkout.Session
) {
  const eventsServiceUrl = process.env.EVENTS_SERVICE_URL!;
  const webhookSecret = process.env.EVENTS_WEBHOOK_SECRET!;
  
  try {
    const response = await fetch(`${eventsServiceUrl}/api/webhook/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${webhookSecret}`,
      },
      body: JSON.stringify({
        type,
        sessionId: session.id,
        paymentId: typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id,
        customerEmail: session.customer_email || session.customer_details?.email || null,
        customerName: session.customer_details?.name || null,
        amountTotal: session.amount_total,
        currency: session.currency,
        metadata: session.metadata,
      }),
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error('Events service webhook failed:', error);
    } else {
      console.log('Events service notified successfully');
    }
  } catch (error) {
    console.error('Failed to notify events service:', error);
    // Don't throw - we don't want to fail the Stripe webhook
    // The payment is still valid, we just need to handle the fulfillment separately
  }
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

    if (!response.ok) {
      const error = await response.text();
      console.error('Coffee service webhook failed:', error);
    } else {
      console.log('Coffee service notified successfully');
    }
  } catch (error) {
    console.error('Failed to notify coffee service:', error);
    // Don't throw - we don't want to fail the Stripe webhook
  }
}

async function handleSubscriptionCreated(subscription: Stripe.Subscription) {
  console.log('Subscription created:', {
    id: subscription.id,
    customerId: subscription.customer,
    status: subscription.status,
  });

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
  console.log('Subscription updated:', {
    id: subscription.id,
    customerId: subscription.customer,
    status: subscription.status,
  });

  // Log the status change as a transaction metadata update
  // (no new transaction row — status changes are informational)
  if (subscription.metadata?.service === 'coffee') {
    await notifyCoffeeServiceSubscription('subscription.updated', subscription);
  }
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  console.log('Subscription canceled:', {
    id: subscription.id,
    customerId: subscription.customer,
  });

  // Notify originating service about cancellation
  if (subscription.metadata?.service === 'coffee') {
    await notifyCoffeeServiceSubscription('subscription.canceled', subscription);
  }
}

async function handleInvoicePaid(invoice: Stripe.Invoice) {
  console.log('Invoice paid:', {
    id: invoice.id,
    amount: invoice.amount_paid,
    currency: invoice.currency,
    subscriptionId: invoice.subscription,
  });

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

  console.log('Subscription renewal transaction created:', txId);

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
    console.warn('Coffee service URL or webhook secret not configured');
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

    if (!response.ok) {
      const error = await response.text();
      console.error('Coffee service subscription webhook failed:', error);
    } else {
      console.log('Coffee service notified of subscription event:', type);
    }
  } catch (error) {
    console.error('Failed to notify coffee service of subscription event:', error);
  }
}
