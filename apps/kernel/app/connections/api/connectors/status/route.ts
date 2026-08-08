/**
 * GET /connections/api/connectors/status (#1540)
 *
 * App-auth-gated, registry-generic connector status for the delegating user.
 * Apps can witness `{ id, connected, scopes }` for profile-owned connector
 * grants, but credentials/config stay entirely server-side.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAppAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { readConnectorConnectionStatus } from '@/src/lib/kernel/connector-status';

const log = createLogger('kernel');

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

function responseHeaders(request: NextRequest): Record<string, string> {
  return {
    ...corsHeaders(request),
    'Cache-Control': 'no-store',
  };
}

export async function GET(request: NextRequest) {
  const headers = responseHeaders(request);

  const appResult = await requireAppAuth(request);
  if ('error' in appResult) {
    return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers });
  }

  const userDid = appResult.appAuth.userDid;
  if (!userDid) {
    return NextResponse.json(
      { error: 'App token has no delegating user' },
      { status: 403, headers },
    );
  }

  try {
    const statuses = await readConnectorConnectionStatus(userDid);
    return NextResponse.json(statuses, { headers });
  } catch (err) {
    log.error(
      { err: String(err), appDid: appResult.appAuth.appDid, userDid },
      'Connector status query failed',
    );
    return NextResponse.json(
      { error: 'Connector status unavailable' },
      { status: 500, headers },
    );
  }
}
