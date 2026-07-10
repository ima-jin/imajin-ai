import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { buildAuthorizeUrl } from '@/src/lib/quickbooks/connector';
import { signState } from '@/src/lib/quickbooks/oauth-state';

/**
 * GET /quickbooks/api/connect — begin the Intuit OAuth2 flow for the logged-in
 * supplier. Redirects to Intuit's authorize page with a signed state binding
 * the caller's DID (verified on the callback).
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const ownerDid = resolveActingDid(auth.identity);
  return NextResponse.redirect(await buildAuthorizeUrl(ownerDid, signState(ownerDid)));
}
