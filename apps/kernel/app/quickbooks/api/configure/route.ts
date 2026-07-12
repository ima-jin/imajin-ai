import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { storeConfig, type QuickBooksConfig } from '@/src/lib/quickbooks/connector';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /quickbooks/api/configure — seal the caller's QuickBooks app config
 * (client id/secret/redirect/environment) in the vault, per-DID. Session-gated:
 * the supplier configures their own connection. The client secret is sealed
 * immediately via the vault and never logged or echoed back.
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const ownerDid = resolveActingDid(auth.identity);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const clientId = typeof body.clientId === 'string' ? body.clientId : null;
  const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret : null;
  const redirectUri = typeof body.redirectUri === 'string' ? body.redirectUri : null;
  const environment = body.environment === 'production' ? 'production' : 'sandbox';
  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.json(
      { error: 'clientId, clientSecret and redirectUri are required' },
      { status: 400, headers: cors },
    );
  }

  const config: QuickBooksConfig = { clientId, clientSecret, redirectUri, environment };
  await storeConfig(ownerDid, config);
  return NextResponse.json({ configured: true }, { status: 201, headers: cors });
}
