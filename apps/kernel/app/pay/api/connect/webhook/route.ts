/**
 * POST /api/connect/webhook
 *
 * Stripe Connect webhook ingress for connected account events.
 *
 * Events relayed to the bus consumer:
 * - account.updated
 * - payout.paid
 * - payout.failed
 *
 * #2177: ingress only — verifies the signature, then republishes the delivery
 * onto the #1785 connector bus as a `stripe.<type>` event
 * (`lib/pay/stripe-relay.ts`); the handlers now live in the `pay-stripe` bus
 * consumer (`lib/pay/stripe-bus-consumer.ts`). A delivery the consumer fails
 * to handle is answered 500 so Stripe retries.
 *
 * #2175: signature verification and Stripe SDK access live entirely behind
 * `lib/pay/providers/stripe-webhook.ts` — this route never imports the
 * `stripe` package or references a `Stripe.*` type.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyStripeWebhook, markStripeEventProcessed } from '@/src/lib/pay/providers/stripe-webhook';
import { relayVerifiedStripeEvent } from '@/src/lib/pay/stripe-relay';
import { withLogger } from '@imajin/logger';

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  const body = await request.text();
  const signature = request.headers.get('stripe-signature');

  const verified = verifyStripeWebhook(body, signature, webhookSecret);
  if (!verified.ok) {
    log.error({}, `Connect webhook verification failed: ${verified.reason}`);
    return NextResponse.json({ error: verified.reason }, { status: verified.status });
  }
  if (verified.duplicate) {
    log.info({ eventId: verified.eventId }, 'Connect webhook event already processed — skipping duplicate delivery');
    return NextResponse.json({ received: true, duplicate: true });
  }

  const result = await relayVerifiedStripeEvent(verified.event, 'connect');
  if (result.status === 'failed') {
    log.error({ eventType: verified.eventType, reason: result.reason }, 'Connect webhook handler error');
    return NextResponse.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
  if (result.status === 'ignored') {
    log.info({ eventType: verified.eventType }, 'Unhandled connect event type');
  }

  markStripeEventProcessed(verified.eventId);
  return NextResponse.json({ received: true });
});
