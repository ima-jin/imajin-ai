/**
 * POST /api/campaign/{eventId}/settle
 *
 * Charge all confirmed pledges for a campaign.
 * Requires campaign creator auth.
 *
 * Request: { eventId: string } (from URL)
 *
 * Response:
 * {
 *   charged: number,
 *   failed: number,
 *   total: number,
 *   results: Array<{ pledgeId: string, status: string, error?: string }>
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { db, events, pledges } from '@/src/db';
import { eq, and } from 'drizzle-orm';
import { corsHeaders, rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY!;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export const POST = withLogger('events', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  // Heavy rate limit — triggers real charges
  const ip = getClientIP(request);
  const rl = rateLimit(ip, 5, 60_000);
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
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    const eventId = pathParts.at(-2); // /api/campaign/{eventId}/settle

    if (!eventId) {
      return NextResponse.json({ error: 'eventId is required' }, { status: 400, headers: cors });
    }

    // Fetch event
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404, headers: cors });
    }

    if (event.eventType !== 'campaign') {
      return NextResponse.json({ error: 'Not a campaign event' }, { status: 400, headers: cors });
    }

    if (event.creatorDid !== did) {
      return NextResponse.json(
        { error: 'Only the campaign creator can settle' },
        { status: 403, headers: cors }
      );
    }

    // Get all confirmed pledges
    const confirmedPledges = await db
      .select()
      .from(pledges)
      .where(
        and(
          eq(pledges.eventId, eventId),
          eq(pledges.status, 'confirmed')
        )
      );

    if (confirmedPledges.length === 0) {
      return NextResponse.json(
        { charged: 0, failed: 0, total: 0, results: [] },
        { headers: cors }
      );
    }

    // Check if target is met
    const totalPledged = confirmedPledges.reduce((sum, p) => sum + p.amount, 0);
    if (event.targetAmount && totalPledged < event.targetAmount) {
      return NextResponse.json(
        { error: 'Campaign target has not been met' },
        { status: 400, headers: cors }
      );
    }

    // Call pay service to charge pledges
    const payRes = await fetch(`${PAY_SERVICE_URL}/api/charge-pledges`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PAY_SERVICE_API_KEY}`,
      },
      body: JSON.stringify({
        eventId,
        pledges: confirmedPledges.map((p) => ({
          pledgeId: p.id,
          amount: p.amount,
          currency: p.currency,
          stripeCustomerId: p.stripeCustomerId,
          stripePaymentMethodId: p.stripePaymentMethodId,
        })),
      }),
    });

    if (!payRes.ok) {
      const err = await payRes.json().catch(() => ({}));
      log.error({ err: err.error || payRes.statusText }, 'Pay service charge-pledges failed');
      return NextResponse.json(
        { error: err.error || 'Failed to charge pledges' },
        { status: 500, headers: cors }
      );
    }

    const chargeResult = await payRes.json();

    // Update pledge statuses based on results
    for (const result of chargeResult.results || []) {
      if (result.status === 'charged') {
        await db
          .update(pledges)
          .set({ status: 'charged', chargedAt: new Date() })
          .where(eq(pledges.id, result.pledgeId));
      } else {
        await db
          .update(pledges)
          .set({ status: 'failed', failureReason: result.error || 'Charge failed' })
          .where(eq(pledges.id, result.pledgeId));
      }
    }

    return NextResponse.json(chargeResult, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Campaign settle error');
    return NextResponse.json(
      { error: 'Failed to settle campaign' },
      { status: 500, headers: cors }
    );
  }
});
