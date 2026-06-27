import { NextRequest, NextResponse } from 'next/server';
import { verifyAppToken } from '@/src/lib/auth/jwt';
import { MCP_RESOURCE, PROTECTED_RESOURCE_METADATA_URL } from '@/src/lib/mcp/oauth-config';
import { handleMcpRpc } from '@/src/lib/mcp/server';

export const dynamic = 'force-dynamic';

/**
 * RFC 9728 §5.3 challenge — points Claude at the protected-resource metadata so
 * it can discover the authorization server and run the OAuth dance. Mirrors the
 * verified DFOS contract (#1166).
 */
function unauthorized(error = 'invalid_token') {
  return NextResponse.json(
    { error },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`,
      },
    },
  );
}

/**
 * POST /mcp — MCP JSON-RPC endpoint (Streamable HTTP).
 *
 * THIS SKETCH ONLY does the auth gate, per the build sequence in #1166:
 *   1. unauthenticated → 401 + WWW-Authenticate pointer (above)
 *   2. bearer present → verify IN-PROCESS via verifyAppToken (EdDSA, no
 *      round-trip), then enforce `aud === MCP_RESOURCE` (RFC 8707 audience
 *      binding) and the read scope.
 *
 * Token-seam note: we deliberately do NOT call requireAuth() here. Its Bearer
 * path round-trips to AUTH_SERVICE_URL/api/validate (the session/opaque-token
 * validator), which does not recognize our app+jwt access token. verifyAppToken
 * is the matching local verifier. The media READ tools (next step) will call the
 * in-process lib (src/lib/media/routes/*) with `payload.sub` as the DID, NOT
 * HTTP self-calls through requireAuth.
 *
 * Dispatch + a `ping` tool are wired via src/lib/mcp/server.ts and the tool
 * registry (src/lib/mcp/tools). Media READ tools come next, each calling the
 * in-process media lib (src/lib/media/routes/*) with ctx.did. SSE streaming is
 * not offered (JSON responses only).
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) {
    return unauthorized();
  }

  const payload = await verifyAppToken(auth.slice(7));
  // verifyAppToken checks signature/issuer/typ but NOT a specific audience —
  // enforce the resource binding here so a token minted for another audience
  // (e.g. 'imajin:apps') cannot be replayed against the MCP surface.
  if (!payload) {
    return unauthorized();
  }
  if (!payload.sub || payload.aud !== MCP_RESOURCE) {
    return unauthorized();
  }

  // Read-only gate. (Set is the existence-check idiom here.)
  const scopes = new Set(payload.scope ? payload.scope.split(' ') : []);
  if (!scopes.has('media:read')) {
    return NextResponse.json(
      { error: 'insufficient_scope' },
      { status: 403, headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope"' } },
    );
  }

  // Authenticated + audience-bound + read-scoped. Parse + dispatch JSON-RPC.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400 },
    );
  }

  const ctx = { did: payload.sub, appDid: payload.azp, scopes };

  // Echo the protocol version header back when the client sends one.
  const protocolHeader = request.headers.get('mcp-protocol-version');
  const headers: Record<string, string> = protocolHeader
    ? { 'MCP-Protocol-Version': protocolHeader }
    : {};

  type RpcMessage = Parameters<typeof handleMcpRpc>[0];

  // JSON-RPC batch or single message.
  if (Array.isArray(body)) {
    const responses = (
      await Promise.all((body as RpcMessage[]).map((m) => handleMcpRpc(m, ctx)))
    ).filter((r): r is object => r !== null);
    return responses.length === 0
      ? new NextResponse(null, { status: 202, headers })
      : NextResponse.json(responses, { headers });
  }

  const response = await handleMcpRpc(body as RpcMessage, ctx);
  return response === null
    ? new NextResponse(null, { status: 202, headers })
    : NextResponse.json(response, { headers });
}

/** GET is only used by Streamable HTTP for server→client SSE, which we don't offer. */
export function GET() {
  return new NextResponse('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
}
