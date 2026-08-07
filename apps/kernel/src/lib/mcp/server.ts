/**
 * MCP JSON-RPC dispatch (#1166), dual-era since #1474.
 *
 * Transport-agnostic: the /mcp route handles auth + HTTP; this module turns a
 * decoded JSON-RPC message + tool context into a response object (or null for
 * notifications). Tools come from the registry — adding tools never touches this.
 *
 * The version/era rules, result envelopes and MCP error codes live in
 * `./protocol` (dependency-free so the route can share them). Read that file's
 * header for WHY `2026-07-28` needed two dispatch paths rather than one more
 * entry in a supported-versions set.
 */
import {
  discoverResult,
  isModernProtocolVersion,
  isSupportedProtocolVersion,
  negotiateProtocol,
  ok,
  readRequestProtocolVersion,
  rpcError,
  unsupportedProtocolVersionError,
  JsonRpcMessage,
  LIST_CACHE_SCOPE,
  LIST_CACHE_TTL_MS,
  MCP_ERROR_INVALID_PARAMS,
  MCP_ERROR_INVALID_REQUEST,
  MCP_ERROR_METHOD_NOT_FOUND,
  SERVER_CAPABILITIES,
  SERVER_INFO,
} from './protocol';
import { resolveActiveMcpGrant } from './mcp-grant';
import { ALL_TOOLS, toolByName } from './tools';
import type { McpToolContext } from './types';

/** `ListToolsResult` — a `CacheableResult` as of 2026-07-28 (SEP-2549). */
function listToolsResult() {
  return {
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    ttlMs: LIST_CACHE_TTL_MS,
    cacheScope: LIST_CACHE_SCOPE,
  };
}

/**
 * Build the in-band denial for a tool whose required scope is absent from the
 * caller's token (Gate 1).
 *
 * Gate 1 reads the JWT, which is frozen at issuance; Gate 2 (`channel_links`,
 * written by the scope-manifest projection) is live. Toggling a scope on in the
 * dashboard therefore satisfies Gate 2 immediately while Gate 1 keeps failing
 * until the token is refreshed. Cross-checking the live grant here lets the
 * client tell those two states apart (#1647):
 *   - grant active  → `scope_token_stale`: refresh the access token.
 *   - no grant      → `insufficient_scope`: enable the scope in the manifest.
 */
async function denyForMissingScope(
  id: JsonRpcMessage['id'],
  toolName: string,
  requiredScope: string,
  ownerDid: string,
) {
  const text = (await resolveActiveMcpGrant(ownerDid, requiredScope))
    ? `Error: scope_token_stale — '${toolName}' requires '${requiredScope}'; the grant is active in your scope-manifest but your access token is stale — refresh your token to pick it up`
    : `Error: insufficient_scope — '${toolName}' requires the '${requiredScope}' grant — enable it in your MCP scope-manifest`;

  return ok(id, { content: [{ type: 'text', text }], isError: true });
}

/** `tools/call` — identical in both eras. */
async function callTool(msg: JsonRpcMessage, ctx: McpToolContext) {
  const name = msg.params?.name;
  const tool = typeof name === 'string' ? toolByName(name) : undefined;
  if (!tool) return rpcError(msg.id, MCP_ERROR_INVALID_PARAMS, `Unknown tool: ${String(name)}`);
  // Per-tool scope gate (#1170): the /mcp route only checks that SOME media
  // scope is present; the authoritative read-vs-write decision is here. A
  // read-only token cannot reach a write tool, and vice versa. Returned
  // in-band (isError) per MCP convention so the model sees why it was denied.
  if (tool.requiredScope && !ctx.scopes.has(tool.requiredScope)) {
    return denyForMissingScope(msg.id, tool.name, tool.requiredScope, ctx.did);
  }
  try {
    const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
    const content = await tool.handler(args, ctx);
    return ok(msg.id, { content, isError: false });
  } catch (e) {
    // MCP convention: tool failures are returned in-band (isError), not as
    // protocol-level JSON-RPC errors, so the model can see what went wrong.
    return ok(msg.id, { content: [{ type: 'text', text: `Error: ${String(e)}` }], isError: true });
  }
}

/**
 * MODERN dispatch (2026-07-28).
 *
 * `initialize`, `notifications/initialized` and `ping` are absent on purpose:
 * the revision removed all three, so they fall through to "method not found"
 * (which the route reports as HTTP 404). `server/discover` is handled by the
 * caller because it answers in both eras.
 */
async function dispatchModern(msg: JsonRpcMessage, ctx: McpToolContext): Promise<object | null> {
  switch (msg.method) {
    case 'tools/list':
      return ok(msg.id, listToolsResult());
    case 'tools/call':
      return callTool(msg, ctx);
    default:
      return rpcError(msg.id, MCP_ERROR_METHOD_NOT_FOUND, `Method not found: ${String(msg.method)}`);
  }
}

/** LEGACY dispatch (`2025-06-18` / `2025-03-26`): the `initialize` handshake era. */
async function dispatchLegacy(
  msg: JsonRpcMessage,
  ctx: McpToolContext,
  isNotification: boolean,
): Promise<object | null> {
  switch (msg.method) {
    case 'initialize':
      return ok(msg.id, {
        protocolVersion: negotiateProtocol(msg.params?.protocolVersion),
        capabilities: SERVER_CAPABILITIES,
        serverInfo: SERVER_INFO,
      });

    // Client → server notifications: acknowledge with no body.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return ok(msg.id, {});

    case 'tools/list':
      return ok(msg.id, listToolsResult());

    case 'tools/call':
      return callTool(msg, ctx);

    default:
      return isNotification
        ? null
        : rpcError(msg.id, MCP_ERROR_METHOD_NOT_FOUND, `Method not found: ${String(msg.method)}`);
  }
}

/**
 * Handle one JSON-RPC message. Returns the response object, or `null` for
 * notifications (no `id`), which yield no HTTP body.
 *
 * Era selection is per-message and driven purely by the request body: a request
 * declaring `_meta['io.modelcontextprotocol/protocolVersion']` as a modern
 * revision is served as modern, anything else as legacy. Nothing is remembered
 * between calls — which is what makes the 2026-07-28 statelessness requirement
 * a no-op for us.
 */
export async function handleMcpRpc(
  msg: JsonRpcMessage,
  ctx: McpToolContext,
): Promise<object | null> {
  const isNotification = msg.id === undefined || msg.id === null;

  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return isNotification ? null : rpcError(msg.id ?? null, MCP_ERROR_INVALID_REQUEST, 'Invalid Request');
  }

  // A declared version we cannot serve is rejected before any dispatch, so the
  // client learns what to retry with instead of getting a method-shaped answer
  // in a protocol it does not speak.
  const declared = readRequestProtocolVersion(msg);
  if (declared !== undefined && !isSupportedProtocolVersion(declared)) {
    return isNotification ? null : unsupportedProtocolVersionError(msg.id ?? null, declared);
  }

  // Answered in both eras: it is the modern replacement for `initialize`, and
  // it is also the probe a dual-era client uses to detect our era.
  if (msg.method === 'server/discover') {
    return isNotification ? null : ok(msg.id, discoverResult());
  }

  return isModernProtocolVersion(declared)
    ? dispatchModern(msg, ctx)
    : dispatchLegacy(msg, ctx, isNotification);
}
