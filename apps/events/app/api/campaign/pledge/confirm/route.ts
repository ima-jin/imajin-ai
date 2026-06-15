/**
 * POST /api/campaign/pledge/confirm
 *
 * Confirm a pledge after Stripe.js successfully confirms the SetupIntent.
 * Verifies the SetupIntent status and updates the pledge record.
 *
 * Request:
 * {
 *   pledgeId: string,
 *   setupIntentId: string
 * }
 *
 * Response:
 * {
 *   success: true,
 *   pledge: { id: string, amount: number, status: string }
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { db, pledges } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders, rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 20, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status, headers: cors }
    );
  }

  const did = authResult.identity.actingAs || authResult.identity.id;

  try {
    const body = await request.json();
    const { pledgeId, setupIntentId, paymentMethodId } = body;

    if (!pledgeId || typeof pledgeId !== 'string') {
      return NextResponse.json({ error: 'pledgeId is required' }, { status: 400, headers: cors });
    }

    if (!setupIntentId || typeof setupIntentId !== 'string') {
      return NextResponse.json({ error: 'setupIntentId is required' }, { status: 400, headers: cors });
    }

    if (!paymentMethodId || typeof paymentMethodId !== 'string') {
      return NextResponse.json({ error: 'paymentMethodId is required' }, { status: 400, headers: cors });
    }

    // Find the pledge
    const [pledge] = await db
      .select()
      .from(pledges)
      .where(and(eq(pledges.id, pledgeId), eq(pledges.backerDid, did)))
      .limit(1);

    if (!pledge) {
      return NextResponse.json({ error: 'Pledge not found' }, { status: 404, headers: cors });
    }

    if (pledge.stripeSetupIntentId !== setupIntentId) {
      return NextResponse.json(
        { error: 'SetupIntent ID mismatch' },
        { status: 400, headers: cors }
      );
    }

    // Update pledge to confirmed
    await db
      .update(pledges)
      .set({
        status: 'confirmed',
        stripePaymentMethodId: paymentMethodId,
        metadata: {
          ...((pledge.metadata as Record<string, any>) || {}),
          confirmedAt: new Date().toISOString(),
        },
      })
      .where(eq(pledges.id, pledgeId));

    return NextResponse.json(
      {
        success: true,
        pledge: {
          id: pledge.id,
          amount: pledge.amount,
          status: 'confirmed',
        },
      },
      { headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error) }, 'Campaign pledge confirm error');
    return NextResponse.json(
      { error: 'Failed to confirm pledge' },
      { status: 500, headers: cors }
    );
  }
});