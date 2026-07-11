import { NextResponse, type NextRequest } from 'next/server';
import { requireAppAuth } from '@imajin/auth';
import { corsHeaders } from '@/src/lib/kernel/cors';

type QuickBooksScope = 'quickbooks:read' | 'quickbooks:write';
type Cors = ReturnType<typeof corsHeaders>;

/**
 * Shared CORS preflight for the app-auth-gated QuickBooks routes.
 */
export function quickbooksPreflight(request: NextRequest): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * Resolve CORS headers + the delegating user DID for an app-auth-gated
 * QuickBooks route. On success returns `{ userDid, cors }`; on failure returns
 * `{ response }` — a ready-to-return error — so callers collapse the shared
 * auth boilerplate to `if ('response' in r) return r.response;`.
 */
export async function requireQuickBooksUser(
  request: NextRequest,
  scope: QuickBooksScope,
): Promise<{ userDid: string; cors: Cors } | { response: NextResponse }> {
  const cors = corsHeaders(request);

  const appResult = await requireAppAuth(request, { scope });
  if ('error' in appResult) {
    return { response: NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors }) };
  }

  const userDid = appResult.appAuth.userDid;
  if (!userDid) {
    return {
      response: NextResponse.json({ error: 'App token has no delegating user' }, { status: 403, headers: cors }),
    };
  }

  return { userDid, cors };
}
