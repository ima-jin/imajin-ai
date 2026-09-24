/**
 * Request orchestration for `POST /mcp` (imajin-ai#2368) — fronts the
 * kernel's native MCP JSON-RPC surface (`apps/kernel/app/mcp/route.ts`)
 * alongside the OpenAI-compatible and Anthropic-format passthroughs, so an
 * OpenClaw-hosted agent that only knows how to mint the SAME kind of kernel
 * app-token this proxy already mints for `/openai/v1`/`/anthropic/v1` can
 * also reach MCP tools, without needing to speak the kernel's OAuth 2.1
 * Dynamic Client Registration dance itself.
 *
 * Reuses `dispatch.ts`'s kernel-then-break-glass flow purely for its
 * 401-retry discipline — MCP itself has no break-glass leg (the kernel is
 * the only MCP server this proxy can reach; see `forwardMcpDirect` in
 * `upstream.ts`), so a kernel 5xx/timeout surfaces the same
 * `502 kernel_unavailable` a route without a `directBaseUrl` already gets
 * on the other two wire formats.
 *
 * ─── Auth model (#2368) ──────────────────────────────────────────────────
 *
 * Single-identity today, by design (the two-agent-identity split — this
 * proxy's `OPENCLAW_APP_DID`-keyed app-token lane vs. a separate plugin
 * agent DID lane, e.g. `packages/nanoclaw-imajin-channel/src/mcp-proxy`'s
 * own independent token provider — is tracked separately, not here):
 *
 *   1. An optional `X-Imajin-App-Did` header, when present, must equal the
 *      proxy's own configured `OPENCLAW_APP_DID` — there is exactly one
 *      app identity configured, so this is a corroboration check, not a
 *      lookup into some multi-tenant attestation store (this proxy has
 *      never had one; see `types.ts`'s `ProviderRouteConfig`, which is
 *      config-time-bound to one `attestationId` per route, not resolved
 *      per-request).
 *   2. The route's app-token is minted with NO `scope` narrowing (`null`,
 *      see `RouteTokenProvider`) — the kernel then returns the
 *      attestation's full granted scope set verbatim, which by
 *      construction can never exceed what the attestation grants ("union
 *      of what's already granted, never widen").
 *   3. Before forwarding, the granted set is intersected against the MCP
 *      capability ceiling (`scopesForSurface('mcp')`, the same source of
 *      truth `apps/kernel/src/lib/mcp/oauth-config.ts`'s `MCP_SCOPE_SET`
 *      derives from). An empty intersection is a typed `403
 *      insufficient_scope` — the same coarse "holds at least one
 *      recognized MCP scope" surface gate the kernel's own `/mcp` route
 *      applies before dispatching JSON-RPC. Per-TOOL scope enforcement
 *      (e.g. `media:write` for a specific tool call) is deliberately left
 *      to the kernel's existing, already-tested `handleMcpRpc`/
 *      `McpTool.requiredScope` gate rather than re-implemented here against
 *      a parsed JSON-RPC body — duplicating that tool→scope map in this
 *      proxy would drift the moment a new MCP tool ships.
 *
 * This proxy's own incoming-request auth is unchanged from every other
 * route here (`/openai/v1`, `/anthropic/v1`): none. It binds `127.0.0.1`
 * and trusts its local caller implicitly (see `server.ts`'s module doc) —
 * there is no OpenClaw-API-key verifier anywhere in this package to check
 * an incoming bearer against, so `/mcp` does not invent one.
 */
import { dispatchWithBreakGlass, jsonError, type ProxyResponse } from './dispatch.js';
import type { HealthTracker } from './health.js';
import type { Logger } from './logger.js';
import { scopesForSurface } from '@imajin/auth/scope-vocabulary';
import type { ScopedTokenSource } from './token-provider.js';
import { forwardMcpDirect, forwardMcpToKernel } from './upstream.js';
import type { ProviderRouteConfig } from './types.js';

export type { ProxyResponse } from './dispatch.js';

/** Response headers the MCP transport needs preserved end to end (#2368). */
const MCP_RESPONSE_HEADERS = ['Mcp-Session-Id', 'Mcp-Protocol-Version'] as const;

/** The capability ceiling a minted token must intersect before this proxy will forward to the kernel's `/mcp`. */
const MCP_SCOPE_CEILING = new Set<string>(scopesForSurface('mcp'));

export interface IncomingMcpRequest {
  bodyText: string;
  /** `X-Imajin-App-Did`, when the caller sent one — see the module doc's auth model. */
  appDidHeader?: string;
  mcpProtocolVersion?: string;
  mcpSessionId?: string;
}

export interface HandleMcpDeps {
  /** The single `id: 'mcp'` route entry from the routes config, or `undefined` when unconfigured. */
  route: ProviderRouteConfig | undefined;
  /** This proxy's own configured app DID (`OPENCLAW_APP_DID`) — the single identity `X-Imajin-App-Did` is checked against. */
  appDid: string;
  kernelBaseUrl: string;
  kernelTimeoutMs: number;
  getTokenProvider(routeId: string): ScopedTokenSource;
  resolveDirectApiKey(route: ProviderRouteConfig): string | undefined;
  health: HealthTracker;
  log: Logger;
}

export async function handleMcpRequest(deps: HandleMcpDeps, req: IncomingMcpRequest): Promise<ProxyResponse> {
  const { route } = deps;
  if (!route) {
    return jsonError(422, 'no_route_configured', "No 'mcp' route configured in INFER_PROXY_ROUTES_CONFIG — see the README's MCP section");
  }

  if (req.appDidHeader && req.appDidHeader !== deps.appDid) {
    return jsonError(
      400,
      'app_did_mismatch',
      "X-Imajin-App-Did does not match this proxy's configured single app identity",
    );
  }

  const tokenProvider = deps.getTokenProvider(route.id);
  const scopeCheck = await ensureMcpScope(tokenProvider, route.id, deps.log);
  if (!scopeCheck.ok) {
    return scopeCheck.response;
  }

  const headers = { mcpProtocolVersion: req.mcpProtocolVersion, mcpSessionId: req.mcpSessionId };

  return dispatchWithBreakGlass(
    { route, getTokenProvider: deps.getTokenProvider, resolveDirectApiKey: deps.resolveDirectApiKey, health: deps.health, log: deps.log },
    (token) => forwardMcpToKernel(deps.kernelBaseUrl, token, req.bodyText, deps.kernelTimeoutMs, headers),
    (_directApiKey) => forwardMcpDirect(route),
    {},
    MCP_RESPONSE_HEADERS,
  );
}

type ScopeCheckResult = { ok: true } | { ok: false; response: ProxyResponse };

/**
 * Mint (or reuse) the route's token and confirm it carries at least one
 * MCP-surface scope before this proxy spends a round trip forwarding a
 * JSON-RPC call the kernel would reject anyway. A mint failure (e.g. the
 * `app.authorized` attestation was revoked, or the app DID is no longer
 * active) is surfaced as the same typed 403 — from the caller's point of
 * view, both are "this proxy is not authorized to speak MCP on your
 * behalf" outcomes.
 */
async function ensureMcpScope(tokenProvider: ScopedTokenSource, routeId: string, log: Logger): Promise<ScopeCheckResult> {
  let scopes: string[];
  try {
    scopes = await tokenProvider.getScopes();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ route: routeId, detail }, 'failed to mint an MCP app token');
    return { ok: false, response: jsonError(403, 'attestation_rejected', `Could not mint an MCP app token: ${detail}`) };
  }

  const hasMcpScope = scopes.some((scope) => MCP_SCOPE_CEILING.has(scope));
  if (!hasMcpScope) {
    return {
      ok: false,
      response: jsonError(
        403,
        'insufficient_scope',
        "This app's app.authorized attestation carries no MCP-surface scope — grant at least one before calling /mcp",
      ),
    };
  }

  return { ok: true };
}
