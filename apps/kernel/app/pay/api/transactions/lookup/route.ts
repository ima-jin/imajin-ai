import { NextRequest, NextResponse } from 'next/server';
import { rateLimit } from '@imajin/config';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { authenticatePayApp } from '@/src/lib/kernel/app-service-auth';
import { parsePaymentLookup, PAY_READ_SCOPE, readAppPayments } from '@/src/lib/pay/app-payment-read';

const log = createLogger('kernel');

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

/** Read-only batch lookup. User cookies, delegated tokens and shared keys confer no authority. */
export async function POST(request: NextRequest) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  try {
    const auth = await authenticatePayApp(request, PAY_READ_SCOPE);
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
    }
    const limit = rateLimit(`pay:read:${auth.appDid}`, 60, 60_000);
    if (limit.limited) {
      return NextResponse.json({ error: 'Too many requests' }, {
        status: 429, headers: { ...headers, 'Retry-After': String(limit.retryAfter) },
      });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers });
    }
    const lookup = parsePaymentLookup(body);
    if (!lookup) {
      return NextResponse.json({ error: 'Expected sellerDid and 1–100 checkout sessionIds' }, { status: 400, headers });
    }
    return NextResponse.json({ transactions: await readAppPayments(auth.appDid, lookup) }, { headers });
  } catch {
    log.error({}, 'App payment lookup failed');
    return NextResponse.json({ error: 'Payment lookup unavailable' }, { status: 500, headers });
  }
}
