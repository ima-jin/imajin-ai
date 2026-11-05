import { NextResponse, type NextRequest } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders } from './cors';
import { ExternalMcpError } from './external-mcp-policy';
import { isAgentCapableSubtype } from './connection-principal-policy';
import { externalConnectionBody } from './external-mcp-route';
import { changeOrgConnectionMemberGrant, listOrgConnectionMemberGrants, parseMemberGrantInput } from './org-connection-member-grants';

export async function orgConnectionMemberGrantRoute(request: NextRequest, provider: string) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'private, no-store' };
  try {
    const auth = await requireAuth(request, { sessionOnly: true, service: 'connections' });
    if ('error' in auth) throw new ExternalMcpError(auth.status, 'Organization admin session required');
    const identity = auth.identity;
    if (!identity.actingAs || identity.actingFor || isAgentCapableSubtype(identity.subtype)
      || !['owner', 'admin'].includes(identity.actingAsRole ?? '')) {
      throw new ExternalMcpError(403, 'Organization admin act-as required');
    }
    const actor = { orgDid: identity.actingAs, actorDid: identity.id };
    if (request.method === 'GET') {
      return NextResponse.json(await listOrgConnectionMemberGrants(actor, provider), { headers });
    }
    if (!['POST', 'DELETE'].includes(request.method)) throw new ExternalMcpError(405, 'Method not allowed');
    const input = parseMemberGrantInput(await externalConnectionBody(request));
    const result = await changeOrgConnectionMemberGrant(actor, provider, input, request.method === 'POST' ? 'grant' : 'revoke');
    return NextResponse.json(result, { headers });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof ExternalMcpError ? error.message : 'Organization member grants unavailable',
    }, { status: error instanceof ExternalMcpError ? error.status : 503, headers });
  }
}
