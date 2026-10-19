import { NextResponse } from 'next/server';
import { resolveReachDiscovery } from '@/src/lib/auth/reach-discovery';
import { REACH_SCOPE } from '@/src/lib/mcp/reach-resource';

export const dynamic = 'force-dynamic';
const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

/** RFC 9728 metadata for this exact resource, not the owner-scoped /mcp. */
export async function GET(_request: Request, props: Readonly<{ params: Promise<{ handle: string }> }>) {
  try {
    const { handle } = await props.params;
    const card = await resolveReachDiscovery(handle);
    if (!card) {
      return NextResponse.json({ error: 'Reach recipient not found' }, { status: 404, headers });
    }
    return NextResponse.json({
      resource: card.transports.find((transport) => transport.id === 'mcp')!.endpoint,
      scopes_supported: [REACH_SCOPE],
      bearer_methods_supported: ['header'],
      resource_documentation: card.onboarding.endpoint,
    }, { headers });
  } catch {
    return NextResponse.json({ error: 'Unable to resolve reach resource' }, { status: 503, headers });
  }
}
