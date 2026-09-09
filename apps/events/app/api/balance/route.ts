/**
 * GET /api/balance
 *
 * Proxy route that fetches the authenticated buyer's MJNx balance from the
 * pay service. Exists because the buyer's DID isn't available client-side
 * and the pay service may be on a different origin.
 */

import { NextResponse } from 'next/server';
import { withLogger } from '@imajin/logger';
import { requireAuth , resolveActingDid } from '@imajin/auth';

// PAY_SERVICE_URL already includes the /pay path prefix (kernel-hosted
// service convention, e.g. http://localhost:3000/pay in dev) — callers
// append only the endpoint path, e.g. /api/balance/{did}. This call site
// used to hardcode a duplicated /pay segment that pay.yaml never
// documented, resolving to /pay/pay/api/balance/{did} → 404, silently
// masked by the `{balance: 0}` catch-all below (#2137, sibling of #2002).
const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;

export const GET = withLogger('events', async (request, { log }) => {
  try {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const buyerDid = resolveActingDid(authResult.identity);
    const payUrl = `${PAY_SERVICE_URL}/api/balance/${encodeURIComponent(buyerDid)}`;

    const payRes = await fetch(payUrl, {
      headers: {
        'Cookie': request.headers.get('cookie') || '',
      },
    });

    if (!payRes.ok) {
      // Log the upstream status + URL so a 404 (e.g. from a proxy-prefix
      // regression) can't hide as a real zero balance again (#2137). The
      // body stays `{balance: 0}` for UI stability (the buyer balance
      // widget renders whatever comes back), but `unavailable: true` plus
      // a non-2xx status lets callers/monitoring distinguish this from an
      // actual zero balance.
      log.warn({ status: payRes.status, url: payUrl }, 'Failed to fetch balance from pay service');
      return NextResponse.json({ balance: 0, currency: 'CAD', unavailable: true }, { status: 502 });
    }

    const data = await payRes.json();
    return NextResponse.json({
      balance: data.total ?? 0,
      currency: data.currency ?? 'CAD',
    });
  } catch (error) {
    log.error({ err: String(error), url: `${PAY_SERVICE_URL}/api/balance/{did}` }, 'Balance check error');
    return NextResponse.json({ balance: 0, currency: 'CAD', unavailable: true }, { status: 502 });
  }
});
