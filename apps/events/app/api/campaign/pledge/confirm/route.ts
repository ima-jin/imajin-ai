/**
 * POST /api/campaign/pledge/confirm
 *
 * Confirm only after the kernel verifies Stripe success and every pledge/buyer binding
 * on the recorded seller's BYO account. Client Stripe results are never authoritative.
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
import { db, pledges } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { authenticateDid, createPreflight, rateLimitResponse } from '../../../../../src/lib/campaign-route';
import { withLogger } from '@imajin/logger';
import { verifyPledgePayment, SETUP_INTENT_CONTRACT } from '../../../../../src/lib/pledge-payment';

export const OPTIONS = createPreflight();

type Pledge = typeof pledges.$inferSelect;

function paymentError(error: string, code: string, status: number, cors: HeadersInit) {
  return NextResponse.json({ error, code }, { status, headers: cors });
}
async function readConfirmation(request: NextRequest, cors: HeadersInit) {
  let body: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return paymentError('Invalid JSON body', 'invalid_request', 400, cors);
    }
    body = value as Record<string, unknown>;
  } catch {
    return paymentError('Invalid JSON body', 'invalid_request', 400, cors);
  }
  for (const field of ['pledgeId', 'setupIntentId', 'paymentMethodId']) {
    if (typeof body[field] !== 'string' || !body[field]) {
      return paymentError(`${field} is required`, 'invalid_request', 400, cors);
    }
  }
  return body as { pledgeId: string; setupIntentId: string; paymentMethodId: string };
}

function confirmedResponse(pledge: Pledge, cors: HeadersInit) {
  return NextResponse.json({
    success: true,
    pledge: { id: pledge.id, amount: pledge.amount, status: pledge.status },
  }, { headers: cors });
}

function sameConfirmedPayment(current: Pledge, original: Pledge, paymentMethodId: string): boolean {
  return ['confirmed', 'charged'].includes(current.status)
    && current.backerDid === original.backerDid && current.eventId === original.eventId
    && current.amount === original.amount && current.currency === original.currency
    && current.stripeSetupIntentId === original.stripeSetupIntentId
    && current.stripeCustomerId === original.stripeCustomerId
    && current.stripePaymentMethodId === paymentMethodId
    && (current.metadata as Record<string, unknown>)?.sellerDid
      === (original.metadata as Record<string, unknown>)?.sellerDid;
}

async function verifyAndConfirm(pledge: Pledge, did: string, paymentMethodId: string, cors: HeadersInit) {
  if (!['pending', 'confirmed', 'charged'].includes(pledge.status)) {
    return paymentError('Pledge is not confirmable', 'pledge_state_conflict', 409, cors);
  }
  const metadata = pledge.metadata as Record<string, unknown> | null;
  if (metadata?.setupIntentContract !== SETUP_INTENT_CONTRACT
    || typeof metadata.sellerDid !== 'string' || !metadata.sellerDid
    || !pledge.stripeCustomerId || !pledge.stripeSetupIntentId) {
    return paymentError('Pledge requires a new payment setup', 'setup_intent_legacy', 409, cors);
  }
  const verified = await verifyPledgePayment({
    pledgeId: pledge.id, eventId: pledge.eventId, buyerDid: did,
    sellerDid: metadata.sellerDid, amount: pledge.amount, currency: pledge.currency,
    setupIntentId: pledge.stripeSetupIntentId, customerId: pledge.stripeCustomerId,
  });
  if ('error' in verified) {
    return paymentError(verified.error, verified.code, verified.status, cors);
  }
  if (paymentMethodId !== verified.paymentMethodId) {
    return paymentError('Payment method does not match verified SetupIntent', 'setup_intent_payment_method_mismatch', 403, cors);
  }
  if (pledge.status !== 'pending') {
    if (sameConfirmedPayment(pledge, pledge, verified.paymentMethodId)) return confirmedResponse(pledge, cors);
    return paymentError('Confirmed payment does not match', 'pledge_state_conflict', 409, cors);
  }

  // Compare-and-set: a concurrent cancel, re-pledge or charge must never be overwritten.
  const [confirmed] = await db
    .update(pledges)
    .set({
      status: 'confirmed',
      stripePaymentMethodId: verified.paymentMethodId,
      metadata: {
        ...metadata,
        confirmedAt: new Date().toISOString(),
      },
    })
    .where(and(
      eq(pledges.id, pledge.id), eq(pledges.eventId, pledge.eventId),
      eq(pledges.backerDid, did), eq(pledges.status, 'pending'),
      eq(pledges.stripeSetupIntentId, pledge.stripeSetupIntentId),
      eq(pledges.stripeCustomerId, pledge.stripeCustomerId),
      eq(pledges.amount, pledge.amount), eq(pledges.currency, pledge.currency),
      eq(pledges.metadata, pledge.metadata),
    ))
    .returning();
  if (confirmed) return confirmedResponse(confirmed, cors);
  const [current] = await db.select().from(pledges)
    .where(and(eq(pledges.id, pledge.id), eq(pledges.backerDid, did))).limit(1);
  if (current && sameConfirmedPayment(current, pledge, verified.paymentMethodId)) {
    return confirmedResponse(current, cors);
  }
  return paymentError('Pledge changed; please retry', 'pledge_state_conflict', 409, cors);
}

export const POST = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const limited = rateLimitResponse(request, 20, cors);
  if (limited) return limited;

  const did = await authenticateDid(request, cors);
  if (did instanceof NextResponse) return did;

  try {
    const body = await readConfirmation(request, cors);
    if (body instanceof NextResponse) return body;
    const { pledgeId, setupIntentId, paymentMethodId } = body;

    // Find the pledge
    const [pledge] = await db
      .select()
      .from(pledges)
      .where(and(eq(pledges.id, pledgeId), eq(pledges.backerDid, did)))
      .limit(1);

    if (!pledge) {
      return paymentError('Pledge not found', 'pledge_not_found', 404, cors);
    }

    if (pledge.stripeSetupIntentId !== setupIntentId) {
      return NextResponse.json(
        { error: 'SetupIntent ID mismatch', code: 'setup_intent_mismatch' },
        { status: 400, headers: cors }
      );
    }

    return await verifyAndConfirm(pledge, did, paymentMethodId, cors);
  } catch (error) {
    log.error({ err: String(error) }, 'Campaign pledge confirm error');
    return NextResponse.json(
      { error: 'Failed to confirm pledge' },
      { status: 500, headers: cors }
    );
  }
});