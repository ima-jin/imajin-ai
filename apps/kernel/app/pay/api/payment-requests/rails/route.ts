/**
 * GET /pay/api/payment-requests/rails?issuer_did=… — which ways the issuer can
 * be paid right now: `{ card, emt }` (#2754). Drives the warning on the new
 * payment request form when an invoice would have no way to be paid online.
 *
 * Issuer-only, like the list read: `issuer_did` must be the authenticated
 * principal. Reveals only two booleans — never the key, the connected account
 * or the e-Transfer email itself.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { getIssuerPayRails } from '@/src/lib/pay/payment-requests/issuer-rails';

const log = createLogger('kernel');

export function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const callerDid = resolveActingDid(authResult.identity);

  const issuerDid = new URL(request.url).searchParams.get('issuer_did');
  if (!issuerDid) {
    return NextResponse.json({ error: 'issuer_did query param is required' }, { status: 400, headers: cors });
  }
  if (issuerDid !== callerDid) {
    return NextResponse.json({ error: 'issuer_did must match the authenticated principal' }, { status: 403, headers: cors });
  }

  try {
    return NextResponse.json(await getIssuerPayRails(issuerDid), { headers: cors });
  } catch (error) {
    log.error({ err: String(error), issuerDid }, 'payment_request rails read error');
    return NextResponse.json({ error: 'Failed to read payment rails' }, { status: 500, headers: cors });
  }
}
