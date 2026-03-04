/**
 * POST /api/connect/webhook
 *
 * Stripe Connect webhook handler for connected account events.
 *
 * Events handled:
 * - account.updated
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';

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
        console.log('Connect account updated:', {
          id: account.id,
          chargesEnabled: account.charges_enabled,
          payoutsEnabled: account.payouts_enabled,
          detailsSubmitted: account.details_submitted,
          did: account.metadata?.did,
        });

        if (account.charges_enabled && account.payouts_enabled) {
          console.log('Account fully onboarded:', account.id, 'did:', account.metadata?.did);
        }
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
