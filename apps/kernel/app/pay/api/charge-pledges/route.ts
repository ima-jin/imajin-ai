/**
 * POST /api/charge-pledges
 *
 * Charge all confirmed pledges for a campaign event.
 * Requires the originating app's operator-approved pay:charge-pledges token.
 * Called by the events service when a campaign reaches its goal.
 *
 * Request:
 * {
 *   eventId: string,
 *   pledges: Array<{
 *     pledgeId: string,
 *     setupIntentId: string
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
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { authenticatePayApp } from '@/src/lib/pay/app-settle';
import { loadAppPledges, chargeBoundPledge, type PledgeReference } from '@/src/lib/pay/app-pledges';
import { forEachSequential } from '@/src/lib/async/sequential';


export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

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

  const auth = await authenticatePayApp(request, 'pay:charge-pledges');
  if ('error' in auth) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status, headers: cors }
    );
  }

  try {
    const body = await request.json();
    const { eventId, pledges }: { eventId: string; pledges: PledgeReference[] } = body;

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

    const bound = await loadAppPledges(auth.appDid, eventId, pledges);
    if ('error' in bound) {
      return NextResponse.json({ error: bound.error }, { status: bound.status, headers: cors });
    }
    const results: Array<{ pledgeId: string; status: 'charged' | 'failed'; error?: string }> = [];
    let charged = 0;
    let failed = 0;

    // Sequential on purpose: each pledge is an off-session Stripe charge — one
    // card charge at a time (Stripe rate limits, no burst of simultaneous
    // charges), with `results` reported in pledge order.
    await forEachSequential(bound, async (pledge) => {
      try {
        const status = await chargeBoundPledge(pledge, eventId);

        if (status === 'succeeded' || status === 'processing') {
          results.push({
            pledgeId: pledge.pledgeId,
            status: 'charged',
          });
          charged++;
        } else if (status === 'requires_action') {
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
            error: `Payment status: ${status}`,
          });
          failed++;
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : 'Payment failed';
        log.error({ err: errorMessage, pledgeId: pledge.pledgeId }, 'Pledge charge failed');
        results.push({
          pledgeId: pledge.pledgeId,
          status: 'failed',
          error: errorMessage,
        });
        failed++;
      }
    });

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
