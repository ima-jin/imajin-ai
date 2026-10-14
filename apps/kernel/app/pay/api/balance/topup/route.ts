/**
 * Legacy topup alias. A user session initiates the existing Stripe checkout;
 * only its confirmed receipt may credit MJN. Caller amounts never mint cash.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { POST as startTopup } from '../../topup/stripe/route';

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);
  const auth = await requireAuth(request, { sessionOnly: true, service: 'pay' });
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  let body: { did?: unknown };
  try {
    body = await request.clone().json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }
  if (body?.did !== undefined && body.did !== resolveActingDid(auth.identity)) {
    return NextResponse.json(
      { error: 'Forbidden - topup is limited to the session identity' },
      { status: 403, headers: cors },
    );
  }
  return startTopup(request);
}
