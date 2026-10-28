import { NextResponse, type NextRequest } from 'next/server';
import { requireAppAuth } from '@imajin/auth';
import { corsHeaders } from './cors';
import { externalConnectionBody, personalMember } from './external-mcp-route';
import { connectExternalMcp, disconnectExternalMcp, externalMcpStatus } from './external-mcp';
import { ExternalMcpError } from './external-mcp-policy';
import { appConnectionTarget, declareAppUpstreams, invokeAppUpstream, resolveAppUpstream } from './app-upstream';
import {
  parseUpstream, upstreamCallInput, upstreamConnectionInput, upstreamProvider, upstreamSelector,
  UPSTREAM_READ_SCOPE,
} from './app-upstream-policy';

async function service(request: NextRequest) {
  const auth = await requireAppAuth(request, { scope: UPSTREAM_READ_SCOPE });
  if ('error' in auth) throw new ExternalMcpError(auth.status, 'Scoped app service authentication required');
  if (!auth.appAuth.isServiceToken) throw new ExternalMcpError(403, 'App service token required');
  return auth.appAuth;
}
async function personalConnection(request: NextRequest) {
  const { memberDid } = await personalMember(request);
  const raw = request.method === 'GET' ? Object.fromEntries(request.nextUrl.searchParams)
    : await externalConnectionBody(request);
  if (request.method === 'POST') {
    const input = parseUpstream(upstreamConnectionInput, raw);
    const target = await resolveAppUpstream(input.appDid, input.upstreamId);
    if (input.origin !== target.origin) throw new ExternalMcpError(409, 'Upstream destination changed; review before connecting');
    return connectExternalMcp(memberDid, {
      secret: input.secret, ...(input.orgContextDid ? { orgContextDid: input.orgContextDid } : {}),
    }, appConnectionTarget(input.appDid, target), input.appDid);
  }
  const input = parseUpstream(upstreamSelector, raw);
  // Personal revoke must work even after the app or its declaration was removed.
  if (request.method === 'DELETE') {
    return disconnectExternalMcp(memberDid, {
      provider: upstreamProvider(input.appDid, input.upstreamId), scope: UPSTREAM_READ_SCOPE,
    }, input.appDid);
  }
  const target = await resolveAppUpstream(input.appDid, input.upstreamId);
  return externalMcpStatus(memberDid, appConnectionTarget(input.appDid, target));
}
export async function appUpstreamRoute(request: NextRequest, kind: 'declarations' | 'connection' | 'call') {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  try {
    if (kind === 'connection') {
      return NextResponse.json(await personalConnection(request), { status: request.method === 'POST' ? 201 : 200, headers });
    }
    if (kind === 'declarations' && request.method === 'GET') {
      await personalMember(request);
      const input = parseUpstream(upstreamSelector, Object.fromEntries(request.nextUrl.searchParams));
      return NextResponse.json(await resolveAppUpstream(input.appDid, input.upstreamId), { headers });
    }
    const app = await service(request);
    const raw = await externalConnectionBody(request);
    if (kind === 'declarations') return NextResponse.json(await declareAppUpstreams(app.appDid, raw), { headers });
    const call = parseUpstream(upstreamCallInput, raw);
    return NextResponse.json(await invokeAppUpstream({
      appDid: app.appDid, serviceToken: true, memberDid: call.memberDid, scopes: app.scopes,
    }, call), { headers });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof ExternalMcpError ? error.message : 'External connection unavailable',
    }, { status: error instanceof ExternalMcpError ? error.status : 503, headers });
  }
}
