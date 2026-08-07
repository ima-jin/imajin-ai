/**
 * MCP protocol rules — versions, eras, envelopes, error codes (#1474).
 *
 * Deliberately dependency-free (no tool registry, no db, no Next), because both
 * sides of the seam need it: `server.ts` dispatches JSON-RPC with it, and
 * `app/mcp/route.ts` enforces the transport rules with it. Keeping it separate
 * also means these rules can be unit-tested without mocking the tool registry.
 *
 * ─── Why there are two eras ────────────────────────────────────────────────
 *
 * MCP `2026-07-28` is NOT a version-string bump on the protocol we already
 * spoke. It splits the ecosystem in two
 * (https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle):
 *
 *   - LEGACY (`2025-11-25` and earlier): the client opens with an `initialize`
 *     handshake, the server echoes a negotiated `protocolVersion`, and that
 *     version governs the rest of the session.
 *   - MODERN (`2026-07-28`+): there is NO handshake. `initialize` and
 *     `notifications/initialized` are REMOVED. Every request carries its own
 *     protocol version and client capabilities in `params._meta`, and the
 *     server accepts or rejects each request independently.
 *
 * So the obvious change — adding `'2026-07-28'` to the set `negotiateProtocol`
 * echoes, and defaulting to it — would have been actively wrong: we would
 * answer an `initialize` (a method 2026-07-28 deleted) by claiming to speak
 * 2026-07-28, while implementing none of that revision's MUSTs. Instead we
 * serve both eras on the same endpoint, which the spec explicitly sanctions
 * ("A dual-era server MAY serve both eras concurrently on the same endpoint").
 * Era is selected per message by how the client opens: a request carrying
 * modern per-request `_meta` is modern; an `initialize` selects legacy.
 *
 * What 2026-07-28 requires, and where it is satisfied:
 *   1. `server/discover` MUST be implemented ............... `discoverResult()`
 *      (dispatched in server.ts)
 *   2. Unsupported version MUST yield -32022 ... `unsupportedProtocolVersionError()`
 *   3. Every result MUST carry `resultType` .......................... `ok()`
 *   4. List results MUST carry `ttlMs` + `cacheScope` .. LIST_CACHE_* + server.ts
 *   5. `ping` / `initialize` are gone from core ..... `dispatchModern()` (server.ts)
 *   6. Header/body agreement MUST be validated ... `validateModernRequestHeaders()`
 *
 * Statelessness — the one thing we already satisfied. Nothing here or in
 * `server.ts` holds per-connection state: dispatch is a pure function of
 * (message, token context), and the route is a plain POST → JSON-RPC → JSON
 * with no session id, no SSE, and no cross-request memory. That is exactly what
 * 2026-07-28's "Statelessness" section demands, so nothing had to change for it.
 */

/** Bumped to 0.2.0 for the 2026-07-28 protocol support (#1474). */
export const SERVER_INFO = { name: 'imajin-media-mcp', version: '0.2.0' };

/** Newest revision we speak. Modern era: per-request `_meta`, no handshake. */
export const LATEST_PROTOCOL_VERSION = '2026-07-28';

/** Revisions served with modern (per-request metadata) semantics. */
const MODERN_PROTOCOL_VERSIONS = new Set([LATEST_PROTOCOL_VERSION]);

/** Revisions served with legacy (`initialize` handshake) semantics. */
const LEGACY_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26']);

/**
 * Every revision we speak, newest first.
 *
 * This is the list surfaced by `server/discover` and by the `supported` array
 * of an `UnsupportedProtocolVersionError`, so ordering is meaningful: clients
 * pick the first mutually supported entry.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  LATEST_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
];

/**
 * Version echoed by a LEGACY `initialize` that omits (or asks for) a version we
 * cannot serve with handshake semantics.
 *
 * Deliberately NOT `2026-07-28`: that revision has no `initialize`, so echoing
 * it from a handshake would tell a legacy client we speak a protocol in which
 * the message it just sent does not exist.
 */
export const DEFAULT_LEGACY_PROTOCOL_VERSION = '2025-06-18';

/** MCP-reserved error codes (2026-07-28 §Error Codes). */
export const MCP_ERROR_HEADER_MISMATCH = -32020;
export const MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32022;
/** JSON-RPC standard codes we map onto HTTP status in the modern transport. */
export const MCP_ERROR_INVALID_REQUEST = -32600;
export const MCP_ERROR_METHOD_NOT_FOUND = -32601;
export const MCP_ERROR_INVALID_PARAMS = -32602;

/** Reserved `_meta` keys carrying per-request / per-result protocol metadata. */
export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/**
 * Capabilities we offer. Identical in both eras — 2026-07-28 moved capability
 * negotiation from per-session to per-request, but our capability set is
 * static, so a per-request answer is the same answer every time.
 *
 * `listChanged: false` because we offer no `subscriptions/listen` stream.
 */
export const SERVER_CAPABILITIES = { tools: { listChanged: false } };

/**
 * Cache hints for list results (2026-07-28 `CacheableResult`, SEP-2549).
 *
 * `public`: `tools/list` is derived from the static registry and is identical
 * for every caller — the per-tool scope gate runs at `tools/call`, not here —
 * so a shared intermediary may serve one cached copy across authorization
 * contexts. If tool visibility ever becomes per-DID this MUST become `private`.
 */
export const LIST_CACHE_TTL_MS = 3_600_000; // 1h
export const LIST_CACHE_SCOPE = 'public' as const;

export interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: Record<string, unknown>;
}

export function isSupportedProtocolVersion(version: unknown): version is string {
  return typeof version === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(version);
}

/** True for revisions served with modern (stateless, per-request `_meta`) semantics. */
export function isModernProtocolVersion(version: unknown): version is string {
  return typeof version === 'string' && MODERN_PROTOCOL_VERSIONS.has(version);
}

/**
 * LEGACY `initialize` negotiation: echo the client's version when we can serve
 * it with handshake semantics, else fall back to our default legacy revision.
 *
 * Modern revisions are excluded on purpose — see DEFAULT_LEGACY_PROTOCOL_VERSION.
 */
export function negotiateProtocol(requested: unknown): string {
  return typeof requested === 'string' && LEGACY_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : DEFAULT_LEGACY_PROTOCOL_VERSION;
}

/**
 * The protocol version a request declares in `params._meta`, or `undefined`
 * when it declares none (i.e. a legacy client).
 */
export function readRequestProtocolVersion(msg: JsonRpcMessage): string | undefined {
  const meta = msg.params?._meta as Record<string, unknown> | undefined;
  const version = meta?.[META_PROTOCOL_VERSION];
  return typeof version === 'string' ? version : undefined;
}

/**
 * Wrap a successful result.
 *
 * `resultType` is REQUIRED by 2026-07-28 and `_meta['…/serverInfo']` is a
 * SHOULD. Both are emitted unconditionally: earlier revisions model a result as
 * an open object, so the extra members are inert for legacy clients and this
 * keeps one code path instead of two divergent result builders.
 */
export function ok(id: JsonRpcMessage['id'], result: Record<string, unknown>) {
  return {
    jsonrpc: '2.0' as const,
    id: id ?? null,
    result: {
      resultType: 'complete' as const,
      ...result,
      _meta: { [META_SERVER_INFO]: SERVER_INFO },
    },
  };
}

export function rpcError(
  id: JsonRpcMessage['id'],
  code: number,
  message: string,
  data?: unknown,
) {
  return {
    jsonrpc: '2.0' as const,
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/**
 * 2026-07-28 §Protocol Version Negotiation: a server that cannot serve the
 * requested revision MUST answer with -32022 and list what it does support, so
 * the client can pick a mutually supported version and retry instead of
 * guessing.
 */
export function unsupportedProtocolVersionError(id: JsonRpcMessage['id'], requested: string) {
  return rpcError(id, MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
    supported: [...SUPPORTED_PROTOCOL_VERSIONS],
    requested,
  });
}

/** Build the `HeaderMismatch` (-32020) response for a failed header check. */
export function headerMismatchError(id: JsonRpcMessage['id'], reason: string) {
  return rpcError(id, MCP_ERROR_HEADER_MISMATCH, `Header mismatch: ${reason}`);
}

/**
 * `DiscoverResult` — 2026-07-28 §Discovery. Servers MUST implement
 * `server/discover`; it replaces `initialize` as the way a client learns our
 * supported versions, capabilities, and identity in one round trip, and it is
 * the probe a dual-era client uses to work out which era we are.
 */
export function discoverResult() {
  return {
    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: SERVER_CAPABILITIES,
    instructions:
      "Imajin's MCP surface. Tools read and write the caller's own media, connections, " +
      'messages, GitHub and Warp resources; each tool is gated on the OAuth scope named ' +
      'in its denial message. Call tools/list for the current registry.',
    ttlMs: LIST_CACHE_TTL_MS,
    cacheScope: LIST_CACHE_SCOPE,
  };
}

/* ─── Transport-level header validation (2026-07-28 §Server Validation) ───── */

const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';

/** Decode the `=?base64?…?=` sentinel a client uses for header-unsafe values. */
function decodeHeaderValue(value: string): string {
  if (!value.startsWith(BASE64_SENTINEL_PREFIX) || !value.endsWith(BASE64_SENTINEL_SUFFIX)) {
    return value;
  }
  const encoded = value.slice(BASE64_SENTINEL_PREFIX.length, -BASE64_SENTINEL_SUFFIX.length);
  return Buffer.from(encoded, 'base64').toString('utf8');
}

/** Methods that mirror an identifier into the `Mcp-Name` header. */
const MCP_NAME_METHODS = new Set(['tools/call', 'resources/read', 'prompts/get']);

function mcpNameSourceValue(msg: JsonRpcMessage): string | undefined {
  const name = msg.params?.name;
  if (typeof name === 'string') return name;
  const uri = msg.params?.uri;
  return typeof uri === 'string' ? uri : undefined;
}

/** `Mcp-Name` check, split out to keep the validator flat. */
function validateMcpNameHeader(
  msg: JsonRpcMessage,
  getHeader: (name: string) => string | null | undefined,
): string | null {
  if (!MCP_NAME_METHODS.has(String(msg.method))) return null;

  const bodyName = mcpNameSourceValue(msg);
  if (bodyName === undefined) return null; // nothing to mirror

  const headerName = getHeader('mcp-name');
  if (!headerName) return 'Missing required header: Mcp-Name';

  const decoded = decodeHeaderValue(headerName);
  return decoded === bodyName
    ? null
    : `Mcp-Name header '${decoded}' does not match body value '${bodyName}'`;
}

/**
 * Validate the standard request headers a MODERN request must mirror from its
 * body, per 2026-07-28 §Request Metadata / §Server Validation.
 *
 * Returns `null` when the request is fine — including EVERY legacy request,
 * because those revisions define none of these headers and validating them
 * would break clients behaving correctly for the version they declared — or a
 * human-readable reason the caller turns into a `HeaderMismatch` (-32020).
 *
 * The point is not pedantry: a load balancer that routes on `Mcp-Name` while
 * the server executes `params.name` is a confused deputy waiting to happen, so
 * the spec requires whoever reads the body to prove the two agree.
 */
export function validateModernRequestHeaders(
  msg: JsonRpcMessage,
  getHeader: (name: string) => string | null | undefined,
): string | null {
  const headerVersion = getHeader('mcp-protocol-version') ?? null;
  const bodyVersion = readRequestProtocolVersion(msg);

  // Legacy request → these headers are not part of its revision.
  if (!isModernProtocolVersion(headerVersion) && !isModernProtocolVersion(bodyVersion)) {
    return null;
  }

  if (!headerVersion) return 'Missing required header: MCP-Protocol-Version';
  if (bodyVersion === undefined) {
    return `Missing required body field: params._meta['${META_PROTOCOL_VERSION}']`;
  }
  if (headerVersion !== bodyVersion) {
    return `MCP-Protocol-Version header '${headerVersion}' does not match body value '${bodyVersion}'`;
  }

  const headerMethod = getHeader('mcp-method');
  if (!headerMethod) return 'Missing required header: Mcp-Method';
  if (headerMethod !== msg.method) {
    return `Mcp-Method header '${headerMethod}' does not match body value '${String(msg.method)}'`;
  }

  return validateMcpNameHeader(msg, getHeader);
}

/**
 * HTTP status for a MODERN JSON-RPC response (2026-07-28 §Protocol Version
 * Header / §Server Validation).
 *
 * The modern transport does NOT return 200 for every JSON-RPC error: a client
 * tells a modern server from a legacy one by inspecting the body of a 4xx, so
 * answering 200 would make us look legacy to a dual-era client and send it down
 * the `initialize` fallback path.
 *
 * Legacy responses keep 200 unconditionally — that is what their revisions say.
 */
export function httpStatusForModernResponse(response: object): number {
  const code = (response as { error?: { code?: number } }).error?.code;
  if (code === MCP_ERROR_UNSUPPORTED_PROTOCOL_VERSION || code === MCP_ERROR_HEADER_MISMATCH) {
    return 400;
  }
  return code === MCP_ERROR_METHOD_NOT_FOUND ? 404 : 200;
}
