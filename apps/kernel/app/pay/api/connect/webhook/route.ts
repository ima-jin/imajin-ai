/**
 * POST /api/connect/webhook
 *
 * Stripe Connect webhook handler for connected account events.
 *
 * Events handled:
 * - account.updated
 * - payout.paid
 * - payout.failed
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db, connectedAccounts } from '@/src/db';
import { getStripe } from '@/src/lib/pay/stripe';

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('STRIPE_CONNECT_WEBHOOK_SECRET not configured');
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
    console.error('Connect webhook signature verification failed:', err);
    return NextResponse.json(
      { error: 'Invalid signature' },
      { status: 400 }
    );
  }

  try {
    switch (event.type) {
      case 'account.updated': {
        const account = event.data.object as Stripe.Account;

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
        const payout = event.data.object as Stripe.Payout;
        console.log('Connect payout.paid:', {
          account: (event as Stripe.Event & { account?: string }).account,
          payoutId: payout.id,
          amount: payout.amount,
          currency: payout.currency,
        });
        break;
      }

      case 'payout.failed': {
        const payout = event.data.object as Stripe.Payout;
        console.log('Connect payout.failed:', {
          account: (event as Stripe.Event & { account?: string }).account,
          payoutId: payout.id,
          amount: payout.amount,
          currency: payout.currency,
        });
        break;
      }

      default:
        console.log('Unhandled connect event type:', event.type);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('Connect webhook handler error:', error);
    return NextResponse.json(
      { error: 'Webhook handler failed' },
      { status: 500 }
    );
  }
}
