/**
 * GET /consent/api/requests/:requestId — read a single consent request card (#1817).
 *
 * Session-authenticated: the caller must be a party to the request (either
 * the approver it was addressed to, or the requester's own DID when the
 * requester happens to be a human session rather than an app). Resolves
 * expiry lazily on read, same as the list endpoint, so polling this route
 * always reflects the true state without a cron sweep.
 *
 * Response: { request: ConsentRequestCard }
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { getConsentRequestCard } from '@/src/lib/consent-requests/consent-requests';

const log = createLogger('kernel:consent:request');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ requestId: string }> },
) {
  const params = await props.params;
  const cors = corsHeaders(request);
  const { requestId } = params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const did = resolveActingDid(authResult.identity);

  try {
    const card = await getConsentRequestCard(requestId);
    if (!card) {
      return NextResponse.json({ error: 'Consent request not found' }, { status: 404, headers: cors });
    }
    if (card.approverDid !== did && card.requesterDid !== did) {
      return NextResponse.json({ error: 'You are not a party to this consent request' }, { status: 403, headers: cors });
    }
    return NextResponse.json({ request: card }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err), requestId, did }, '[consent/requests/:id] read failed');
    return NextResponse.json({ error: 'Failed to read consent request' }, { status: 500, headers: cors });
  }
}
