/**
 * GET /pay/api/card-rail/check?did=xxx
 *
 * Public (no auth required) endpoint — tells buyer-facing pages (an event's
 * ticket panel) whether the seller can take a card payment, so they show a card
 * button only when it would work (#2757; replaces the removed
 * `/api/connect/check`). The answer is `resolveCardRail`'s: the seller's own
 * Stripe connector, or no card rail.
 *
 * Reveals one boolean — never the key, the grant or anything about the account.
 *
 * Response: { cardEnabled: boolean }
 */

import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { rateLimit, getClientIP } from '@imajin/config';
import { withLogger } from '@imajin/logger';
import { resolveCardRail } from '@/src/lib/pay/payment-requests/card-rail';

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

export const GET = withLogger('kernel', async (request: NextRequest, { log }) => {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 60, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } },
    );
  }

  const did = new URL(request.url).searchParams.get('did');
  if (!did) {
    return NextResponse.json({ error: 'did query parameter is required' }, { status: 400, headers: cors });
  }

  try {
    const rail = await resolveCardRail(did);
    return NextResponse.json({ cardEnabled: rail.kind !== 'none' }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'Card rail check error');
    return NextResponse.json({ error: 'Check failed' }, { status: 500, headers: cors });
  }
});
