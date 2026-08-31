import { NextRequest, NextResponse } from 'next/server';
import { verifyAppToken } from '@/src/lib/auth/jwt';
import { getMcpResource, getProtectedResourceMetadataUrl, MCP_SCOPE_SET } from '@/src/lib/mcp/oauth-config';
import { handleMcpRpc } from '@/src/lib/mcp/server';
import { agentCardUrl } from '@/src/lib/http/node-url';
import {
  headerMismatchError,
  httpStatusForModernResponse,
  isModernProtocolVersion,
  readRequestProtocolVersion,
  validateModernRequestHeaders,
} from '@/src/lib/mcp/protocol';

export const dynamic = 'force-dynamic';

/**
 * RFC 9728 §5.3 challenge — points Claude at the protected-resource metadata so
 * it can discover the authorization server and run the OAuth dance. Mirrors the
 * verified DFOS contract (#1166).
 */
function unauthorized(error = 'invalid_token') {
  // `onboarding` (#1899): an unknown key has no way to learn this node speaks
  // the knock flow other than being told so at the point of rejection.
  return NextResponse.json(
    { error, onboarding: agentCardUrl() },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer resource_metadata="${getProtectedResourceMetadataUrl()}"`,
      },
    },
  );
}

type RpcMessage = Parameters<typeof handleMcpRpc>[0];

/** True when this POST is speaking a MODERN revision (2026-07-28+). */
function isModernRequest(request: NextRequest, msg: RpcMessage | null): boolean {
  return (
    isModernProtocolVersion(request.headers.get('mcp-protocol-version')) ||
    (msg !== null && isModernProtocolVersion(readRequestProtocolVersion(msg)))
  );
}

/**
 * POST /mcp — MCP JSON-RPC endpoint (Streamable HTTP).
 *
 * THIS SKETCH ONLY does the auth gate, per the build sequence in #1166:
 *   1. unauthenticated → 401 + WWW-Authenticate pointer (above)
 *   2. bearer present → verify IN-PROCESS via verifyAppToken (EdDSA, no
 *      round-trip), then enforce `aud === getMcpResource()` (RFC 8707 audience
 *      binding) and the read scope.
 *
 * Token-seam note: we deliberately do NOT call requireAuth() here. Its Bearer
 * path round-trips to AUTH_SERVICE_URL/api/validate (the session/opaque-token
 * validator), which does not recognize our app+jwt access token. verifyAppToken
 * is the matching local verifier. The media READ tools (next step) will call the
 * in-process lib (src/lib/media/routes/*) with `payload.sub` as the DID, NOT
 * HTTP self-calls through requireAuth.
 *
 * Dispatch is wired via src/lib/mcp/server.ts and the tool registry
 * (src/lib/mcp/tools); each tool calls the in-process lib with ctx.did. SSE
 * streaming is not offered (JSON responses only) — permitted in every revision,
 * which lets the server answer a request with a single JSON object.
 *
 * Era handling (#1474): this endpoint is dual-era. A request declaring
 * `2026-07-28` (header + `_meta`) gets the modern transport rules — mirrored
 * headers are validated, and JSON-RPC errors map onto 400/404 so a dual-era
 * client can tell us apart from a legacy server. Anything else is served with
 * legacy rules and an unconditional 200. See src/lib/mcp/protocol.ts for why
 * the two eras cannot share one code path.
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
  if (!payload.sub || payload.aud !== getMcpResource()) {
    return unauthorized();
  }

  // Surface gate: the token must carry at least one recognized MCP scope to reach
  // the MCP surface at all. The authoritative read-vs-write decision is per-tool in
  // handleMcpRpc (each McpTool.requiredScope), so a write-only token can reach the
  // write tools and a read-only token cannot call them (#1170).
  const scopes = new Set(payload.scope ? payload.scope.split(' ') : []);
  const tokenScopes = Array.from(scopes);
  const hasRecognizedScope = tokenScopes.some((s) => MCP_SCOPE_SET.has(s));
  if (!hasRecognizedScope) {
    // `onboarding` (#1899): a recognized-but-ungranted key needs the same
    // pointer back to the agent card as a wholly unknown one.
    return NextResponse.json(
      { error: 'insufficient_scope', onboarding: agentCardUrl() },
      { status: 403, headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope"' } },
    );
  }

  // Authenticated + audience-bound + media-scoped. Parse + dispatch JSON-RPC.
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

  // JSON-RPC batch. Batching is gone from the modern transport ("the body of the
  // HTTP POST MUST be a single JSON-RPC request or notification"), so this path
  // exists only for legacy clients and is not header-validated.
  if (Array.isArray(body)) {
    const responses = (
      await Promise.all((body as RpcMessage[]).map((m) => handleMcpRpc(m, ctx)))
    ).filter((r): r is object => r !== null);
    return responses.length === 0
      ? new NextResponse(null, { status: 202, headers })
      : NextResponse.json(responses, { headers });
  }

  const msg = body as RpcMessage;
  const modern = isModernRequest(request, msg);

  // 2026-07-28 §Server Validation: whoever reads the body MUST prove the
  // mirrored headers agree with it, so an intermediary routing on `Mcp-Name`
  // and a server executing `params.name` can never disagree. Applies to modern
  // requests only — earlier revisions define none of these headers.
  if (modern) {
    const mismatch = validateModernRequestHeaders(msg, (name) => request.headers.get(name));
    if (mismatch) {
      return NextResponse.json(headerMismatchError(msg?.id ?? null, mismatch), {
        status: 400,
        headers,
      });
    }
  }

  const response = await handleMcpRpc(msg, ctx);
  if (response === null) {
    return new NextResponse(null, { status: 202, headers });
  }
  return NextResponse.json(response, {
    status: modern ? httpStatusForModernResponse(response) : 200,
    headers,
  });
}

/**
 * GET was the Streamable HTTP server→client SSE stream, which we never offered
 * and which 2026-07-28 removed outright. 405 is what the spec prescribes.
 */
export function GET() {
  return new NextResponse('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
}

/**
 * DELETE terminated a protocol-level session in `2025-03-26`…`2025-11-25`.
 * We were always stateless and 2026-07-28 removed sessions entirely, so the
 * spec's answer for an older client that tries it is 405.
 */
export function DELETE() {
  return new NextResponse('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
}
