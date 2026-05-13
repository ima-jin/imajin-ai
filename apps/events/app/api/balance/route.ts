/**
 * GET /api/balance
 *
 * Proxy route that fetches the authenticated buyer's MJNx balance from the
 * pay service. Exists because the buyer's DID isn't available client-side
 * and the pay service may be on a different origin.
 */

import { NextResponse } from 'next/server';
import { withLogger } from '@imajin/logger';
import { requireAuth } from '@imajin/auth';

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;

export const GET = withLogger('events', async (request, { log }) => {
  try {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const buyerDid = authResult.identity.actingAs || authResult.identity.id;

    const payRes = await fetch(
      `${PAY_SERVICE_URL}/pay/api/balance/${encodeURIComponent(buyerDid)}`,
      {
        headers: {
          'Cookie': request.headers.get('cookie') || '',
        },
      },
    );

    if (!payRes.ok) {
      // If the pay service returns 404 (no balance record), treat as zero
      if (payRes.status === 404) {
        return NextResponse.json({ balance: 0, currency: 'CAD' });
      }
      log.warn({ status: payRes.status }, 'Failed to fetch balance from pay service');
      return NextResponse.json({ balance: 0, currency: 'CAD' });
    }

    const data = await payRes.json();
    return NextResponse.json({
      balance: data.total ?? 0,
      currency: data.currency ?? 'CAD',
    });
  } catch (error) {
    log.error({ err: String(error) }, 'Balance check error');
    return NextResponse.json({ balance: 0, currency: 'CAD' });
  }
});
