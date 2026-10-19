import { NextRequest, NextResponse } from 'next/server';
import { resolveReachBearer, resolveReachRecipient } from '@/src/lib/access/reach-bearer';
import { handleMcpRpc } from '@/src/lib/mcp/server';
import { createReachSurface } from '@/src/lib/mcp/reach';
import { resolveReachDiscovery } from '@/src/lib/auth/reach-discovery';
import { REACH_GATED_TOOLS, REACH_SCOPE, reachResourceUrls } from '@/src/lib/mcp/reach-resource';
import {
  headerMismatchError, httpStatusForModernResponse, isModernProtocolVersion,
  isSupportedProtocolVersion, readRequestProtocolVersion, rpcError,
  validateModernRequestHeaders, type JsonRpcMessage,
} from '@/src/lib/mcp/protocol';

export const dynamic = 'force-dynamic';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Method, Mcp-Name',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, MCP-Protocol-Version',
  'Cache-Control': 'no-store',
};
type Props = Readonly<{ params: Promise<{ handle: string }> }>;

function unauthorized(handle: string) {
  const urls = reachResourceUrls(handle);
  return NextResponse.json({ error: 'invalid_token', onboarding: urls.knock }, {
    status: 401,
    headers: { ...headers, 'WWW-Authenticate': `Bearer resource_metadata="${urls.metadata}", scope="${REACH_SCOPE}"` },
  });
}
async function credentialFor(request: NextRequest, body: JsonRpcMessage, principalDid: string) {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  return resolveReachBearer(authorization.slice(7), principalDid,
    body.params?.name === 'reach_status' ? 'status' : 'send');
}
function needsCredential(body: JsonRpcMessage, declared: string | undefined) {
  return body.method === 'tools/call' && REACH_GATED_TOOLS.has(String(body.params?.name))
    && (declared === undefined || isSupportedProtocolVersion(declared));
}

function isMessage(body: unknown): body is JsonRpcMessage {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const msg = body as JsonRpcMessage;
  return msg.jsonrpc === '2.0' && typeof msg.method === 'string'
    && (msg.params === undefined || (msg.params !== null && typeof msg.params === 'object' && !Array.isArray(msg.params)));
}

export async function POST(request: NextRequest, props: Props) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, 'Parse error'), { status: 400, headers });
  }
  // Single requests only; never execute a partially authenticated batch.
  if (!isMessage(body)) {
    return NextResponse.json(rpcError(null, -32600, 'Invalid Request'), { status: 400, headers });
  }
  const declared = readRequestProtocolVersion(body);
  const modern = isModernProtocolVersion(declared) || isModernProtocolVersion(request.headers.get('mcp-protocol-version'));
  const responseHeaders = {
    ...headers,
    ...(modern ? { 'MCP-Protocol-Version': declared ?? '2026-07-28' } : {}),
  };
  const mismatch = validateModernRequestHeaders(body, (name) => request.headers.get(name));
  if (mismatch) {
    return NextResponse.json(headerMismatchError(body.id, mismatch), { status: 400, headers: responseHeaders });
  }
  try {
    const { handle } = await props.params;
    // Opt-out hides discovery, not requester-private receipts or existing reach authority.
    const gatedCall = body.method === 'tools/call' && REACH_GATED_TOOLS.has(String(body.params?.name));
    const card = gatedCall ? null : await resolveReachDiscovery(handle);
    if (!card && !gatedCall) return NextResponse.json({ error: 'Reach recipient not found' }, { status: 404, headers });
    const principal = await resolveReachRecipient(card?.principalDid ?? handle);
    if (!principal) return NextResponse.json({ error: 'Reach recipient not found' }, { status: 404, headers });
    const canonical = card?.handle ?? card?.principalDid ?? handle;
    let credential = null;
    if (needsCredential(body, declared)) {
      credential = await credentialFor(request, body, principal.id);
      if (!credential) return unauthorized(canonical);
    }
    const outcome = { status: 200 };
    const surface = createReachSurface({
      ...principal, handle: card?.handle ?? null, name: card?.name ?? null,
    }, canonical, credential, outcome);
    const response = await handleMcpRpc(body, {
      did: credential?.requesterDid ?? '', appDid: '', scopes: new Set(),
    }, surface);
    if (outcome.status === 401) return unauthorized(canonical);
    if (response === null) return new NextResponse(null, { status: 202, headers: responseHeaders });
    return NextResponse.json(response, {
      status: outcome.status === 200 ? httpStatusForModernResponse(response) : outcome.status,
      headers: responseHeaders,
    });
  } catch {
    // Never expose infrastructure errors: they may include bound bearer values.
    return NextResponse.json({ error: 'Unable to reach recipient' }, { status: 503, headers });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers });
}

export function GET() {
  return new NextResponse(null, { status: 405, headers: { ...headers, Allow: 'POST, OPTIONS' } });
}

export const DELETE = GET;
