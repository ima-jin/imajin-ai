/**
 * POST /api/checkout
 * 
 * Creates a Stripe Checkout session for one-time or recurring support.
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';

// Lazy Stripe init to avoid build-time errors
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY not configured');
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2023-10-16' as any,
    });
  }
  return _stripe;
}

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3009';

export async function POST(request: NextRequest) {
  try {
    const { amount, recurring, joinMailingList } = await request.json();

    if (!amount || amount < 500) {
      return NextResponse.json(
        { error: 'Minimum amount is $5' },
        { status: 400 }
      );
    }

    const metadata: Record<string, string> = {
      joinMailingList: joinMailingList ? 'true' : 'false',
    };

    if (recurring) {
      // Create subscription checkout
      const session = await getStripe().checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Support Imajin (Monthly)',
              description: 'Monthly support for sovereign infrastructure development',
            },
            unit_amount: amount,
            recurring: {
              interval: 'month',
            },
          },
          quantity: 1,
        }],
        subscription_data: {
          metadata,
        },
        metadata, // Also on session for webhook access
        success_url: `${BASE_URL}/success?type=subscription`,
        cancel_url: BASE_URL,
      });

      return NextResponse.json({ url: session.url });
    } else {
      // One-time payment
      const session = await getStripe().checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Support Imajin',
              description: 'One-time support for sovereign infrastructure development',
            },
            unit_amount: amount,
          },
          quantity: 1,
        }],
        payment_intent_data: {
          metadata,
        },
        metadata, // Also on session for webhook access
        success_url: `${BASE_URL}/success?type=onetime`,
        cancel_url: BASE_URL,
      });

      return NextResponse.json({ url: session.url });
    }
  } catch (error) {
    console.error('Checkout error:', error);
    return NextResponse.json(
      { error: 'Failed to create checkout' },
      { status: 500 }
    );
  }
}
