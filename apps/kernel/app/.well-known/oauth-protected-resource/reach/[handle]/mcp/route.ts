import { NextResponse } from 'next/server';
import { resolveReachRecipient } from '@/src/lib/access/reach-bearer';
import { REACH_SCOPE, reachResourceUrls } from '@/src/lib/mcp/reach-resource';

export const dynamic = 'force-dynamic';
const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

/** RFC 9728 metadata for this exact resource, not the owner-scoped /mcp. */
export async function GET(_request: Request, props: Readonly<{ params: Promise<{ handle: string }> }>) {
  try {
    const { handle } = await props.params;
    if (!await resolveReachRecipient(handle)) {
      return NextResponse.json({ error: 'Reach recipient not found' }, { status: 404, headers });
    }
    const urls = reachResourceUrls(handle);
    return NextResponse.json({
      resource: urls.resource,
      scopes_supported: [REACH_SCOPE],
      bearer_methods_supported: ['header'],
      resource_documentation: urls.knock,
    }, { headers });
  } catch {
    return NextResponse.json({ error: 'Unable to resolve reach resource' }, { status: 503, headers });
  }
}
