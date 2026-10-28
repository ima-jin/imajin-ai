import { NextResponse, type NextRequest } from 'next/server';
import { requireAppAuth, requireAuth } from '@imajin/auth';
import { corsHeaders } from './cors';
import { connectExternalMcp, disconnectExternalMcp, externalMcpStatus, invokeExternalMcp, type ExternalMcpCaller } from './external-mcp';
import { EXTERNAL_MCP_SCOPE, ExternalMcpError, memberDidSchema, parseExternalMcpCall } from './external-mcp-policy';

async function personalMember(request: NextRequest): Promise<ExternalMcpCaller> {
  const auth = await requireAuth(request, { sessionOnly: true, service: 'connections' });
  if ('error' in auth) throw new ExternalMcpError(auth.status, 'Member session required');
  const identity = auth.identity;
  if (identity.actingFor || identity.actingAs || identity.subtype === 'agent' || identity.scope !== 'actor') {
    throw new ExternalMcpError(403, 'Personal member session required');
  }
  return { memberDid: identity.id };
}
async function invocationCaller(request: NextRequest, selected?: string): Promise<ExternalMcpCaller> {
  if (request.headers.has('authorization') || request.headers.has('x-app-did')) {
    const auth = await requireAppAuth(request, { scope: EXTERNAL_MCP_SCOPE });
    if ('error' in auth) throw new ExternalMcpError(auth.status, 'Scoped app authentication required');
    const app = auth.appAuth;
    const memberDid = app.isServiceToken ? selected : app.userDid;
    if (!memberDidSchema.safeParse(memberDid).success || (!app.isServiceToken && selected && selected !== memberDid)) {
      throw new ExternalMcpError(403, 'A consenting member DID is required');
    }
    return { memberDid: memberDid!, appDid: app.appDid, serviceToken: app.isServiceToken };
  }
  const caller = await personalMember(request);
  if (selected && selected !== caller.memberDid) throw new ExternalMcpError(403, 'Member selector does not match caller');
  return caller;
}

/** Bound untrusted input without ever echoing a parser error or submitted value. */
async function body(request: NextRequest): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new ExternalMcpError(400, 'JSON body required');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) throw new ExternalMcpError(413, 'Request too large');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ExternalMcpError(400, 'Invalid JSON body'); }
  } finally { await reader.cancel(); }
}

async function handleInvocation(request: NextRequest, headers: Record<string, string>) {
  const raw = await body(request);
  // Authentication precedes tool-policy errors; the selector alone grants nothing.
  const selected = raw && typeof raw === 'object' && 'memberDid' in raw ? raw.memberDid : undefined;
  if (selected !== undefined && !memberDidSchema.safeParse(selected).success) {
    throw new ExternalMcpError(400, 'Invalid member selector');
  }
  const caller = await invocationCaller(request, selected as string | undefined);
  const call = parseExternalMcpCall(raw);
  const result = await invokeExternalMcp(caller, call);
  return 'value' in result ? NextResponse.json(result.value, { headers })
    : NextResponse.json({ error: result.error }, { status: 502, headers });
}

export async function externalMcpRoute(request: NextRequest, rpc = false) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  try {
    if (rpc) return await handleInvocation(request, headers);
    const { memberDid } = await personalMember(request);
    if (request.method === 'GET') return NextResponse.json(await externalMcpStatus(memberDid), { headers });
    if (request.method === 'DELETE') return NextResponse.json(await disconnectExternalMcp(memberDid), { headers });
    return NextResponse.json(await connectExternalMcp(memberDid, await body(request)), { status: 201, headers });
  } catch (error) {
    // Only our fixed errors leave the kernel; no cause, driver, vault or provider error.
    const status = error instanceof ExternalMcpError ? error.status : 503;
    const message = error instanceof ExternalMcpError ? error.message : 'External MCP unavailable';
    return NextResponse.json({ error: message }, { status, headers });
  }
}
