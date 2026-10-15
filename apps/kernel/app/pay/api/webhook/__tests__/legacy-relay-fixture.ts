/**
 * Test-only harness for legacy platform settlement characterization. The live
 * unbound ingress is retired; these fixtures still pin the historical reactor
 * business behavior independently of any externally reachable route.
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
