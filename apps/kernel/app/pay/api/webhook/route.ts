/**
 * POST /api/webhook
 *
 * Stripe webhook ingress for the platform account's async payment events.
 *
 * Events relayed to the bus consumer:
 * - payment_intent.succeeded
 * - payment_intent.payment_failed
 * - checkout.session.completed
 * - customer.subscription.created
 * - customer.subscription.updated
 * - customer.subscription.deleted
 * - invoice.paid
 * - transfer.created
 *
 * #2177: this route is ingress only. It verifies the delivery's signature and
 * then republishes it onto the #1785 connector bus as a `stripe.<type>` event
 * (`lib/pay/stripe-relay.ts`); every business handler that used to live here
 * now lives in the `pay-stripe` bus consumer (`lib/pay/stripe-bus-consumer.ts`).
 * A delivery the consumer fails to handle is answered 500 so Stripe retries.
 *
 * #2175: signature verification and Stripe SDK access live entirely behind
 * `lib/pay/providers/stripe-webhook.ts` — this route never imports the
 * `stripe` package or references a `Stripe.*` type.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { verifyStripeWebhook, markStripeEventProcessed } from '@/src/lib/pay/providers/stripe-webhook';
import { relayVerifiedStripeEvent } from '@/src/lib/pay/stripe-relay';

const log = createLogger('kernel');

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const body = await request.text();
  const signature = request.headers.get('stripe-signature');

  const verified = verifyStripeWebhook(body, signature, webhookSecret);
  if (!verified.ok) {
    log.error({}, `Webhook verification failed: ${verified.reason}`);
    return NextResponse.json({ error: verified.reason }, { status: verified.status });
  }
  if (verified.duplicate) {
    log.info({ eventId: verified.eventId }, 'Webhook event already processed — skipping duplicate delivery');
    return NextResponse.json({ received: true, duplicate: true });
  }

  const result = await relayVerifiedStripeEvent(verified.event, 'platform');
  if (result.status === 'failed') {
    log.error({ eventType: verified.eventType, reason: result.reason }, 'Webhook handler error');
    return NextResponse.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
  if (result.status === 'ignored') {
    log.info({ eventType: verified.eventType }, 'Unhandled event type');
  }

  markStripeEventProcessed(verified.eventId);
  return NextResponse.json({ received: true });
}
