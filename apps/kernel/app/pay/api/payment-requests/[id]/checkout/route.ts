/**
 * POST /pay/api/payment-requests/:id/checkout — issuer or recipient
 * (#2209). Creates (or reuses an already-open) Stripe Checkout session
 * composing the existing `/pay/api/checkout` code path with the
 * payment_request's own `line_items`/`currency`/`fair_manifest`/`issuer_did`.
 * Auth required — anonymous pay-link checkout is deferred to #2210.
 *
 * #2656: the body may carry `paidByDid` — which of the caller's DIDs pays (their
 * own, or an org/business they control as owner/admin). It is validated
 * server-side: a DID the caller can't act for is a 403 and never stored.
 *
 * #2754/#2757: the card is charged on the issuer's own Stripe account when they have a
 * connector, else this is a 400 `SELLER_NO_CARD_RAIL`; a failure creating the session on
 * the issuer's account is a 502 with a `CARD_RAIL_*` `code`. Error bodies carry
 * `{ error, code? }`.
 *
 * See `apps/kernel/src/lib/pay/payment-requests/checkout.ts` for the
 * session-building logic this route delegates to.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { createPaymentRequestCheckoutSession } from '@/src/lib/pay/payment-requests/checkout';
import { payerPersonDidOf } from '@/src/lib/pay/payment-requests/payer-dids';
import { isServiceError } from '@/src/lib/pay/payment-requests/service';

const log = createLogger('kernel');

export function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

interface CheckoutRequestBody {
  customer_email?: unknown;
  paidByDid?: unknown;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const cors = corsHeaders(request);
  const { id } = await params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const callerDid = resolveActingDid(authResult.identity);

  let body: CheckoutRequestBody = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }
  if (body.customer_email !== undefined && typeof body.customer_email !== 'string') {
    return NextResponse.json({ error: 'customer_email must be a string' }, { status: 400, headers: cors });
  }
  if (body.paidByDid !== undefined && body.paidByDid !== null && typeof body.paidByDid !== 'string') {
    return NextResponse.json({ error: 'paidByDid must be a string' }, { status: 400, headers: cors });
  }

  try {
    const result = await createPaymentRequestCheckoutSession({
      id,
      callerDid,
      customerEmail: body.customer_email,
      ...(body.paidByDid ? { paidByDid: body.paidByDid, payerPersonDid: payerPersonDidOf(authResult.identity) } : {}),
    });
    if (isServiceError(result)) {
      // `code` (#2754) is the stable reason the pay page turns into a specific message.
      return NextResponse.json(
        { error: result.error, ...(result.code ? { code: result.code } : {}) },
        { status: result.status, headers: cors },
      );
    }
    return NextResponse.json(result, { headers: cors });
  } catch (error) {
    log.error({ err: String(error), paymentRequestId: id }, 'payment_request checkout error');
    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500, headers: cors });
  }
}
