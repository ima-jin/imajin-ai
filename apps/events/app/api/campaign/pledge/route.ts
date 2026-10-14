/**
 * POST /api/campaign/pledge
 *
 * Create a pledge for a campaign event.
 * Calls the pay service to create a Stripe SetupIntent.
 *
 * Request:
 * {
 *   eventId: string,
 *   amount: number          // cents, min 100 = $1
 * }
 *
 * Response:
 * {
 *   pledgeId: string,
 *   clientSecret: string
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, pledges } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { authenticateDid, findEvent, jsonError, createPreflight, rateLimitResponse } from '../../../../src/lib/campaign-route';
import { withLogger } from '@imajin/logger';
import { randomBytes } from 'node:crypto';
import { createPledgePayment, SETUP_INTENT_CONTRACT } from '../../../../src/lib/pledge-payment';

export const OPTIONS = createPreflight();

function recordedSetupIntent(id: string | null) {
  return id ? eq(pledges.stripeSetupIntentId, id) : isNull(pledges.stripeSetupIntentId);
}
function campaignAvailability(event: NonNullable<Awaited<ReturnType<typeof findEvent>>>, cors: HeadersInit) {
  if (event.eventType !== 'campaign') return jsonError('Not a campaign event', 400, cors);
  if (event.status !== 'published') return jsonError('Campaign is not available for pledging', 400, cors);
  if (event.deadline && new Date(event.deadline) < new Date()) {
    return jsonError('Campaign deadline has passed', 400, cors);
  }
  return null;
}

export const POST = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const limited = rateLimitResponse(request, 10, cors);
  if (limited) return limited;

  const did = await authenticateDid(request, cors);
  if (did instanceof NextResponse) return did;

  try {
    const body = await request.json();
    const { eventId, amount } = body;

    if (!eventId || typeof eventId !== 'string') {
      return NextResponse.json({ error: 'eventId is required' }, { status: 400, headers: cors });
    }

    if (typeof amount !== 'number' || amount < 100 || !Number.isSafeInteger(amount)) {
      return NextResponse.json(
        { error: 'amount must be an integer >= 100 (minimum $1.00)' },
        { status: 400, headers: cors }
      );
    }

    const event = await findEvent(eventId);
    if (!event) return jsonError('Event not found', 404, cors);
    const unavailable = campaignAvailability(event, cors);
    if (unavailable) return unavailable;

    // Check for existing pledge from this backer
    const [existingPledge] = await db
      .select()
      .from(pledges)
      .where(and(eq(pledges.eventId, eventId), eq(pledges.backerDid, did)))
      .limit(1);

    if (existingPledge && ['confirmed', 'charged'].includes(existingPledge.status)) {
      return NextResponse.json(
        { error: 'You already have an active pledge for this campaign' },
        { status: 409, headers: cors }
      );
    }

    // Bind server-derived pledge, buyer and seller values into Stripe metadata.
    const pledgeId = existingPledge?.id || `plg_${randomBytes(12).toString('hex')}`;
    const payment = await createPledgePayment({
      pledgeId, eventId, buyerDid: did, sellerDid: event.creatorDid, amount, currency: 'CAD',
    });
    if ('error' in payment) {
      log.error({ code: payment.code }, 'Pay service SetupIntent failed');
      return NextResponse.json(
        { error: payment.error, code: payment.code },
        { status: payment.status, headers: cors }
      );
    }

    const { clientSecret, setupIntentId, customerId } = payment;
    const bindingMetadata = { sellerDid: event.creatorDid, setupIntentContract: SETUP_INTENT_CONTRACT };

    // Create or update pledge record

    if (existingPledge) {
      const [updated] = await db
        .update(pledges)
        .set({
          amount,
          currency: 'CAD',
          stripeSetupIntentId: setupIntentId,
          stripeCustomerId: customerId,
          stripePaymentMethodId: null,
          status: 'pending',
          metadata: { ...bindingMetadata, updatedAt: new Date().toISOString() },
        })
        .where(and(
          eq(pledges.id, existingPledge.id),
          eq(pledges.backerDid, did),
          eq(pledges.status, existingPledge.status),
          eq(pledges.amount, existingPledge.amount),
          eq(pledges.currency, existingPledge.currency),
          recordedSetupIntent(existingPledge.stripeSetupIntentId),
          eq(pledges.metadata, existingPledge.metadata),
        ))
        .returning({ id: pledges.id });
      if (!updated) return NextResponse.json(
        { error: 'Pledge changed; please retry', code: 'pledge_changed' },
        { status: 409, headers: cors },
      );
    } else {
      await db.insert(pledges).values({
        id: pledgeId,
        eventId,
        backerDid: did,
        amount,
        currency: 'CAD',
        stripeSetupIntentId: setupIntentId,
        stripeCustomerId: customerId,
        status: 'pending',
        metadata: bindingMetadata,
      });
    }

    return NextResponse.json(
      { pledgeId, clientSecret },
      { headers: cors }
    );
  } catch (error) {
    log.error({ err: String(error) }, 'Campaign pledge error');
    return NextResponse.json(
      { error: 'Failed to create pledge' },
      { status: 500, headers: cors }
    );
  }
});