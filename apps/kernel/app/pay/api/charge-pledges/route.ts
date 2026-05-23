/**
 * POST /api/charge-pledges
 *
 * Charge all confirmed pledges for a campaign event.
 * Service-to-service endpoint — requires PAY_SERVICE_API_KEY.
 * Called by the events service when a campaign reaches its goal.
 *
 * Request:
 * {
 *   eventId: string,
 *   pledges: Array<{
 *     pledgeId: string,
 *     amount: number,
 *     currency: string,
 *     stripeCustomerId: string,
 *     stripePaymentMethodId: string
 *   }>
 * }
 *
 * Response:
 * {
 *   charged: number,
 *   failed: number,
 *   total: number,
 *   results: Array<{ pledgeId: string, status: 'charged' | 'failed', error?: string }>
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@/src/lib/kernel/rate-limit';
import { withLogger } from '@imajin/logger';

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
    });
  }
  return _stripe;
}

interface PledgeCharge {
  pledgeId: string;
  amount: number;
  currency: string;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  // Heavy rate limit — this triggers real charges
  const ip = getClientIP(request);
  const rl = rateLimit(ip, 5, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  // Service-to-service auth via API key
  const apiKey = request.headers.get('authorization')?.replaceAll('Bearer ', '');
  const expectedKey = process.env.PAY_SERVICE_API_KEY;

  if (!expectedKey || apiKey !== expectedKey) {
    return NextResponse.json(
      { error: 'Unauthorized - invalid API key' },
      { status: 401, headers: cors }
    );
  }

  try {
    const body = await request.json();
    const { eventId, pledges }: { eventId: string; pledges: PledgeCharge[] } = body;

    if (!eventId || typeof eventId !== 'string') {
      return NextResponse.json(
        { error: 'eventId is required' },
        { status: 400, headers: cors }
      );
    }

    if (!Array.isArray(pledges) || pledges.length === 0) {
      return NextResponse.json(
        { charged: 0, failed: 0, total: 0, results: [] },
        { headers: cors }
      );
    }

    const stripe = getStripe();
    const results: Array<{ pledgeId: string; status: 'charged' | 'failed'; error?: string }> = [];
    let charged = 0;
    let failed = 0;

    for (const pledge of pledges) {
      try {
        if (!pledge.stripeCustomerId || !pledge.stripePaymentMethodId) {
          results.push({
            pledgeId: pledge.pledgeId,
            status: 'failed',
            error: 'Missing Stripe customer or payment method',
          });
          failed++;
          continue;
        }

        const paymentIntent = await stripe.paymentIntents.create({
          amount: pledge.amount,
          currency: pledge.currency.toLowerCase(),
          customer: pledge.stripeCustomerId,
          payment_method: pledge.stripePaymentMethodId,
          off_session: true,
          confirm: true,
          metadata: {
            eventId,
            pledgeId: pledge.pledgeId,
            type: 'campaign_pledge_charge',
          },
        });

        if (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing') {
          results.push({
            pledgeId: pledge.pledgeId,
            status: 'charged',
          });
          charged++;
        } else if (paymentIntent.status === 'requires_action') {
          // 3D Secure or similar — mark as failed for off_session
          results.push({
            pledgeId: pledge.pledgeId,
            status: 'failed',
            error: 'Payment requires additional authentication (3D Secure)',
          });
          failed++;
        } else {
          results.push({
            pledgeId: pledge.pledgeId,
            status: 'failed',
            error: `Payment status: ${paymentIntent.status}`,
          });
          failed++;
        }
      } catch (err: any) {
        const errorMessage = err.message || 'Payment failed';
        log.error({ err: errorMessage, pledgeId: pledge.pledgeId }, 'Pledge charge failed');
        results.push({
          pledgeId: pledge.pledgeId,
          status: 'failed',
          error: errorMessage,
        });
        failed++;
      }
    }

    return NextResponse.json({
      charged,
      failed,
      total: pledges.length,
      results,
    }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Charge pledges error');
    return NextResponse.json(
      { error: 'Failed to charge pledges' },
      { status: 500, headers: cors }
    );
  }
});
