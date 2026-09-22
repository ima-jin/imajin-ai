/**
 * POST /api/connect/webhook
 *
 * Stripe Connect webhook handler for connected account events.
 *
 * Events handled:
 * - account.updated
 * - payout.paid
 * - payout.failed
 *
 * #2175: signature verification and Stripe SDK access live entirely behind
 * `lib/pay/providers/stripe-webhook.ts` now — this route never imports the
 * `stripe` package or references a `Stripe.*` type; every case dispatches
 * on a normalized `RailEvent`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, connectedAccounts } from '@/src/db';
import { verifyStripeWebhook, markStripeEventProcessed, toRailEvent } from '@/src/lib/pay/providers/stripe-webhook';
import type { StripeAccountLike, StripePayoutLike } from '@/src/lib/pay/webhook-event-shapes';
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

  try {
    switch (verified.eventType) {
      case 'account.updated': {
        const railEvent = toRailEvent(verified.event)!;
        const account = railEvent.raw as unknown as StripeAccountLike;

        const rows = await db
          .select()
          .from(connectedAccounts)
          .where(eq(connectedAccounts.stripeAccountId, account.id))
          .limit(1);

        if (rows.length > 0) {
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
        break;
      }

      case 'payout.paid': {
        const railEvent = toRailEvent(verified.event)!;
        const payout = railEvent.raw as unknown as StripePayoutLike;
        const connectAccountId = (verified.event as { account?: string } | undefined)?.account;
        log.info({ account: connectAccountId, payoutId: payout.id, amount: payout.amount, currency: payout.currency }, 'Connect payout.paid');
        break;
      }

      case 'payout.failed': {
        const railEvent = toRailEvent(verified.event)!;
        const payout = railEvent.raw as unknown as StripePayoutLike;
        const connectAccountId = (verified.event as { account?: string } | undefined)?.account;
        log.info({ account: connectAccountId, payoutId: payout.id, amount: payout.amount, currency: payout.currency }, 'Connect payout.failed');
        break;
      }

      default:
        log.info({ eventType: verified.eventType }, 'Unhandled connect event type');
    }

    markStripeEventProcessed(verified.eventId);
    return NextResponse.json({ received: true });
  } catch (error) {
    log.error({ err: String(error) }, 'Connect webhook handler error');
    return NextResponse.json(
      { error: 'Webhook handler failed' },
      { status: 500 }
    );
  }
});
