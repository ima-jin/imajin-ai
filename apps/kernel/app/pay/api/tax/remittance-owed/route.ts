/**
 * GET /pay/api/tax/remittance-owed?collector_did=...
 *
 * Read-only trust-liability tax remittance-owed query (#2419). Returns one
 * row per jurisdiction + kind (split further only by the registration number
 * the tax was collected under, #2439), each with the summed `amount` still
 * owed and that `registrationNumber`. Business-scoped: a caller may only
 * see remittance owed for their OWN `collector_did` — same "caller must match the queried DID" convention as
 * `GET /pay/api/payment-requests` (issuer_did/recipient_did) and
 * `GET /api/transactions/[did]/summary`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { getTaxRemittanceOwed } from '@/src/lib/pay/tax-remittance';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const callerDid = resolveActingDid(authResult.identity);

  const { searchParams } = new URL(request.url);
  const collectorDid = searchParams.get('collector_did');
  if (!collectorDid) {
    return NextResponse.json({ error: 'collector_did query param is required' }, { status: 400, headers: cors });
  }
  if (collectorDid !== callerDid) {
    return NextResponse.json(
      { error: 'collector_did must match the authenticated principal' },
      { status: 403, headers: cors },
    );
  }

  try {
    const owed = await getTaxRemittanceOwed(collectorDid);
    return NextResponse.json({ owed }, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'tax remittance-owed query error');
    return NextResponse.json({ error: 'Failed to fetch remittance owed' }, { status: 500, headers: cors });
  }
}
