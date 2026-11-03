import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { SESSION_COOKIE_NAME } from '@imajin/config';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { ExternalMcpError, memberDidSchema } from '@/src/lib/kernel/external-mcp-policy';
import { readOrgHeldStatus } from '@/src/lib/kernel/org-held-status';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'private, no-store' };
  try {
    // Authenticate the personal session only, not an act-as capability. The org
    // query is a selector; the live DB membership check below is the authority.
    // Do not carry act-as cookies/headers or bearer/app tokens into this read.
    const session = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    const auth = await requireAuth(new Request(request.url, {
      headers: session ? { cookie: `${SESSION_COOKIE_NAME}=${session}` } : {},
    }), { sessionOnly: true });
    if ('error' in auth) throw new ExternalMcpError(auth.status, 'Organization member session required');
    const orgDid = memberDidSchema.safeParse(request.nextUrl.searchParams.get('orgDid'));
    if (!orgDid.success) throw new ExternalMcpError(400, 'Valid orgDid required');
    if (auth.identity.subtype === 'agent' || request.headers.has('x-acting-for')) {
      throw new ExternalMcpError(403, 'Organization member session required');
    }
    return NextResponse.json(await readOrgHeldStatus({ actorDid: auth.identity.id, orgDid: orgDid.data }), { headers });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof ExternalMcpError ? error.message : 'Organization key status unavailable',
    }, { status: error instanceof ExternalMcpError ? error.status : 503, headers });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
