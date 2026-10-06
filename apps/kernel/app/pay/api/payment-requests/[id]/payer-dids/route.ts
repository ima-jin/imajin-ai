/**
 * GET /pay/api/payment-requests/:handle/payer-dids — authenticated (#2656).
 *
 * The "Pay as" picker's data: the caller's own DID plus every org/business DID
 * where they hold owner/admin in `identity_members`. Plain members of an org
 * are never offered it, and `checkout` / the e-Transfer route reject any DID
 * not on this list server-side regardless of what a client sends.
 *
 * The path segment is the opaque pay-link handle (what `/pay/r/:handle` has),
 * exactly as the pay page already passes it to `:id/checkout`; Next.js allows
 * one dynamic name per level, hence the folder is `[id]`. 404 for an unknown or
 * void handle. The response carries only the caller's own identities — nothing
 * about the request — so any signed-in person may ask.
 *
 *   200 { dids: [{ did, kind: 'personal' | 'organization', displayName }], defaultDid }
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { getPayerDidChoices } from '@/src/lib/pay/payment-requests/payer-dids';
import { isServiceError } from '@/src/lib/pay/payment-requests/service';

const log = createLogger('kernel');

export function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const cors = corsHeaders(request);
  const { id: handle } = await params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  try {
    const result = await getPayerDidChoices(handle, authResult.identity);
    if (isServiceError(result)) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: cors });
    }
    return NextResponse.json(result, { headers: cors });
  } catch (error) {
    log.error({ err: String(error), handle }, 'payment_request payer-dids error');
    return NextResponse.json({ error: 'Failed to load payer identities' }, { status: 500, headers: cors });
  }
}
