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
 *     setupIntentId: string,
 *     sellerDid: string
 *   }>
 * }
 *
 * Response:
 * {
 *   charged: number,
 *   failed: number,
 *   total: number,
 *   results: Array<{ pledgeId: string, status: 'charged' | 'failed', error?: string, code?: string }>
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { authenticatePayApp } from '@/src/lib/kernel/app-service-auth';
import { loadAppPledges, chargeBoundPledge, pledgeFailure, PledgeChargeError, type PledgeReference } from '@/src/lib/pay/app-pledges';
import { forEachSequential } from '@/src/lib/async/sequential';


export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

async function readPledgeBatch(request: NextRequest): Promise<{ eventId: string; pledges: PledgeReference[] }> {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new PledgeChargeError(400, 'INVALID_PLEDGE_REQUEST', 'Invalid JSON body');
  }
  if (!body || typeof body !== 'object') {
    throw new PledgeChargeError(400, 'INVALID_PLEDGE_REQUEST', 'Pledge request must be an object');
  }
  return body;
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

  const auth = await authenticatePayApp(request, 'pay:charge-pledges');
  if ('error' in auth) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status, headers: cors }
    );
  }

  try {
    const body = await readPledgeBatch(request);
    const { eventId, pledges }: { eventId: string; pledges: PledgeReference[] } = body;

    if (!eventId || typeof eventId !== 'string') {
      return NextResponse.json(
        { error: 'eventId is required' },
        { status: 400, headers: cors }
      );
    }

    if (!Array.isArray(pledges)) {
      return NextResponse.json({ error: 'pledges must be an array' }, { status: 400, headers: cors });
    }
    if (pledges.length === 0) {
      return NextResponse.json(
        { charged: 0, failed: 0, total: 0, results: [] },
        { headers: cors }
      );
    }

    const bound = await loadAppPledges(auth.appDid, eventId, pledges);
    const results: Array<{ pledgeId: string; status: 'charged' | 'failed'; error?: string; code?: string }> = [];
    let charged = 0;
    let failed = 0;

    // Sequential on purpose: each pledge is an off-session Stripe charge — one
    // card charge at a time (Stripe rate limits, no burst of simultaneous
    // charges), with `results` reported in pledge order.
    await forEachSequential(bound, async (outcome) => {
      if ('failure' in outcome) {
        results.push({
          pledgeId: outcome.pledgeId,
          status: 'failed',
          error: outcome.failure.error,
          code: outcome.failure.code,
        });
        failed++;
        return;
      }
      const { pledge } = outcome;
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
            code: 'PLEDGE_CHARGE_REQUIRES_ACTION',
          });
          failed++;
        } else {
          results.push({
            pledgeId: pledge.pledgeId,
            status: 'failed',
            error: 'Payment did not complete; reconcile before retrying',
            code: 'PLEDGE_CHARGE_RECONCILIATION_REQUIRED',
          });
          failed++;
        }
      } catch (err: unknown) {
        const failure = pledgeFailure(err);
        log.error({ pledgeId: pledge.pledgeId }, 'Pledge charge failed');
        results.push({
          pledgeId: pledge.pledgeId,
          status: 'failed',
          error: failure.error,
          code: failure.code,
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
    log.error({}, 'Charge pledges error');
    const failure = pledgeFailure(error);
    return NextResponse.json(
      { error: failure.error, code: failure.code },
      { status: failure.status, headers: cors }
    );
  }
});
