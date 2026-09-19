/**
 * GET /pay/api/payment-requests/by-handle/:handle — unauthenticated,
 * minimum-necessary read for a payer who only has the opaque pay-link
 * handle (#2210).
 *
 * Both the pay-first ordering (pay via this handle before any account/
 * connection exists) and the claim-first ordering (pay after claiming, at
 * which point the payer could also use the authenticated `GET
 * /pay/api/payment-requests/:id`) resolve against this same route — it
 * never varies based on `recipient_did` / `recipient_stub_id` state.
 *
 * See `getPaymentRequestByHandle` (`src/lib/pay/payment-requests/service.ts`)
 * for exactly what's excluded from the response: no issuer DID, no
 * recipient PII, no fair_manifest/settlement_ref/content_hash — nothing
 * beyond what's needed to pay.
 */
import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { getPaymentRequestByHandle } from '@/src/lib/pay/payment-requests/service';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ handle: string }> }) {
  const cors = corsHeaders(request);
  const { handle } = await params;

  try {
    const view = await getPaymentRequestByHandle(handle);
    if (!view) {
      return NextResponse.json({ error: 'payment_request not found' }, { status: 404, headers: cors });
    }
    return NextResponse.json(view, { headers: cors });
  } catch (error) {
    log.error({ err: String(error), handle }, 'payment_request by-handle error');
    return NextResponse.json({ error: 'Failed to load payment_request' }, { status: 500, headers: cors });
  }
}
