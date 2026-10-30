import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders } from './cors';
import { externalConnectionBody } from './external-mcp-route';
import { ExternalMcpError } from './external-mcp-policy';
import { loadOrgHeldConnection, readOrgHeldConnections, revokeOrgHeldConnection } from './org-held-connection';

export async function orgHeldConnectionRoute(request: NextRequest, provider?: string) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  try {
    const auth = await requireAuth(request, { sessionOnly: true, service: 'connections' });
    if ('error' in auth) throw new ExternalMcpError(auth.status, 'Organization admin session required');
    const identity = auth.identity;
    if (!identity.actingAs || identity.actingFor || identity.subtype === 'agent'
      || !['owner', 'admin'].includes(identity.actingAsRole ?? '')) {
      throw new ExternalMcpError(403, 'Organization admin act-as required');
    }
    const actor = { actorDid: identity.id, orgDid: identity.actingAs };
    if (request.method === 'GET') {
      return NextResponse.json(await readOrgHeldConnections(actor, provider), { headers });
    }
    if (!provider) throw new ExternalMcpError(400, 'Provider required');
    if (request.method === 'DELETE') {
      return NextResponse.json(await revokeOrgHeldConnection(actor, provider), { headers });
    }
    const result = await loadOrgHeldConnection(actor, provider, await externalConnectionBody(request));
    return NextResponse.json(result, { status: 201, headers });
  } catch (error) {
    // Never echo parser, vault, signing or driver errors, even to the loading admin.
    return NextResponse.json({
      error: error instanceof ExternalMcpError ? error.message : 'Organization connection unavailable',
    }, { status: error instanceof ExternalMcpError ? error.status : 503, headers });
  }
}
