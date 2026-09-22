# Spike: Meta Muse as first foreign agent (#2250)

**Date:** 2026-09-22
**Verify criterion (from the issue):** a Muse custom connector completes DCR + OAuth PKCE against `mcp.imajin.ai`, lists tools, executes one scoped read tool `onBehalfOf` the human, and the call appears as a signed kernel event.

## Headline finding — the issue's premise doesn't hold as of 2026-09-20

The issue assumed Muse's custom-connector flow "consumes a public MCP server URL with OAuth — the same shape as Claude Desktop's connector flow." That is **not what Meta shipped**:

- **Muse (the consumer app)** has no "add MCP server" setting. Per Meta's own Help Center (`meta.com/help/artificial-intelligence/1687253048996149`) and independent hands-on testing (Parallel, 2026-09-14, corroborated by multiple second-party write-ups as of 2026-09-20), a Muse "custom connector" is code Muse itself writes on its Secure VM from a public **OpenAPI/REST spec**, authenticated with a **static bearer token or API key** the human pastes once into Muse's "Secure Credentials Store." There is no browser-redirect OAuth ceremony in this flow at all.
- **Muse Code** (Meta's separate, developer-focused terminal coding agent — same branding, different product) *does* speak MCP, over `streamable_http`. But per `dev.meta.ai/docs/muse-code/extending`, its `mcp_servers` config takes only `url` + static `headers` — no OAuth flow for remote MCP servers is documented or implied.

So **neither Muse surface can drive our OAuth 2.1 + PKCE + DCR authorization-code flow**, which is built (correctly — see below) for a Claude-Desktop-shaped client that opens a browser and follows redirects. This is the single fact that reframes the rest of the spike: the blocker is not a server bug, it's a client-shape mismatch, and the fix is not "make DCR work better," it's "give a static-credential client something to hold." See follow-up #2252.

**Availability correction:** Muse is **not** US-only. It launched in the US 2026-09-08 and expanded to Canada 2026-09-18/19 (`iphoneincanada.ca`, confirmed by Meta's own "Made it to Canada" post). The issue's "Blocker: Muse is US-only" is stale.

## What was actually exercised, live, against `mcp.imajin.ai`

All of the following were run with `curl` from outside the kernel, exactly as an external OAuth client would see them (see command transcript below for exact requests):

1. **RFC 8414 AS metadata** — `GET /.well-known/oauth-authorization-server` → 200, correct `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `code_challenge_methods_supported: ["S256"]`, `authorization_response_iss_parameter_supported: true`.
2. **RFC 9728 protected-resource metadata** — `GET /.well-known/oauth-protected-resource` → 200, correct `resource`, `authorization_servers`, `scopes_supported`, `bearer_methods_supported: ["header"]`.
3. **RFC 7591 DCR** — `POST /oauth/register` with a `redirect_uris` array and no pre-registration → 201, real `client_id`, no `client_secret` (public client), full scope ceiling when `scope` omitted (RFC 6749 §3.3 default behavior — correct).
4. **PKCE authorization request** — built a real S256 `code_verifier`/`code_challenge` pair, hit `GET /oauth/authorize` with the DCR `client_id` unauthenticated → 307 to `.../auth/login?next=...`. This is correct AS behavior (RFC 6749 §4.1.1: redirect to obtain resource-owner authorization); a human must complete this step in a real browser, which this run could not do. **This is the one tap the owner needs to do** (see "Where a human must click" below).
5. **`/mcp` unauthenticated** — `POST /mcp` with no bearer → 401 + `WWW-Authenticate: Bearer resource_metadata="https://mcp.imajin.ai/.well-known/oauth-protected-resource"`, exactly per RFC 9728 §5.3, plus an `onboarding` pointer to `agent.json` (#1899).
6. **CORS preflight** — `OPTIONS /mcp` → 204 with only an `Allow` header, **no** `Access-Control-Allow-*` headers. Fixed (see Divergences).
7. **OpenAPI path** — `GET /media/api/spec` → 200, OpenAPI 3.1.0, `bearerAuth: http bearer` security scheme (structurally compatible with the "paste a bearer token" model Muse's OpenAPI custom-connector actually uses). `GET /registry/api/specs` → confirmed ~15+ independent per-service specs exist, no aggregate. See follow-up #2253.

### Where a human must click (cannot be automated in this run)

The one step this run could not complete is the resource-owner authorization itself:

1. Open the `GET /oauth/authorize?...` URL (built with the DCR `client_id` + PKCE challenge above) in a real browser.
2. The AS bounces you to `https://jin.imajin.ai/auth/login?next=...` — **not** `mcp.imajin.ai` — because `/oauth/authorize` deliberately anchors browser-facing redirects to the node's own configured public origin (`APP_URL`/`NEXT_PUBLIC_BASE_URL`) ahead of the MCP-specific issuer, a documented and tested behavior from #1797/#1185 (see `apps/kernel/src/lib/http/public-origin.ts`). This is correct, not a divergence — the browser just needs to keep following redirects.
3. Log in (or you already have a session), and you land on `/auth/authorize`, Imajin's own consent screen — you'll see the connector's name, the requested scopes (`media:read`, etc.), and a Grant/Deny choice.
4. Approving POSTs to `/oauth/authorize`, which returns `{ redirect: "<client-redirect-uri>?code=...&state=...&iss=..." }`; the consent page then navigates the browser there.
5. The client (Muse, or `curl` standing in for it) exchanges `code` + `code_verifier` at `POST /oauth/token` for an access + refresh token pair.

This redirect chain was traced code-side (not click-tested) because there is no logged-in human browser session in this run's environment.

## Divergences

| # | What Muse/MCP-conformance expects | What `mcp.imajin.ai` served (before this PR) | Severity | Fix |
|---|---|---|---|---|
| 1 | Muse's real custom-connector auth is a **static, long-lived bearer/API-key** credential (OpenAPI+bearer, or Muse Code's static MCP headers) | Only a 10-minute OAuth access token (`ACCESS_TOKEN_TTL_SECONDS = 600`), minted only via the interactive authorize+PKCE dance — no static/PAT-style credential exists | **High** — this is the actual blocker to a first-try Muse connection | Filed as follow-up #2252 (architectural; not fixed in this PR) |
| 2 | A cold client calling `/mcp` (or any browser-based MCP client, not only Muse) needs CORS headers to get past a preflight | `OPTIONS /mcp` returned 204 with no `Access-Control-Allow-*` headers; the POST responses carried none either | Medium | **Fixed in this PR** — `/mcp` now answers a `permissive Access-Control-Allow-Origin: *` (safe: the endpoint is Bearer-authenticated, never cookie-authenticated) on both the `OPTIONS` preflight and every `POST` response |
| 3 | `agent.json`'s `protocols.mcp.version` should reflect the newest protocol revision actually served | Hardcoded to the stale `2025-03-26` launch value even after #1474 added `2026-07-28` dual-era support | Low | **Fixed in this PR** — now sourced from `LATEST_PROTOCOL_VERSION` in `protocol.ts` |
| 4 | One OpenAPI URL to point a connector at for the whole platform | `/registry/api/specs` lists 15+ independent per-service specs (`/media/api/spec`, `/chat/api/spec`, …); no aggregate | Low (workable for the media-only MVP) | Filed as follow-up #2253 (design decision needed; not fixed in this PR) |
| 5 | Muse is US-only (issue's stated blocker) | Muse expanded to Canada 2026-09-18/19 | N/A (informational) | Runbook updated accordingly; no code change |

No Sentinel-specific behavior could be observed — Muse's Sentinel egress-approval layer only activates once a real Muse session is driving a live browser, which this run could not do (see "Where a human must click").

## What was NOT changed and why

- **No Muse-specific code path was added anywhere.** Both fixes above are generic MCP/OAuth conformance corrections that help any client, not just Muse.
- The `publicOrigin` cross-host redirect (mcp.imajin.ai → jin.imajin.ai mid-flow) was investigated and found to be intentional, tested behavior (#1797), not a bug.
- The personal-access-token / static-credential gap (#2252) and the aggregate-spec question (#2253) are architectural — filed as sub-issues of #2250 rather than built in this run, per the task's bound.

## Command transcript (abridged)

```
$ curl -sS -i https://mcp.imajin.ai/.well-known/oauth-authorization-server
HTTP/2 200
{"issuer":"https://mcp.imajin.ai","authorization_endpoint":"https://mcp.imajin.ai/oauth/authorize", ...}

$ curl -sS -i https://mcp.imajin.ai/oauth/register -H "Content-Type: application/json" \
    -d '{"redirect_uris":["https://example.com/oauth/callback"],"client_name":"Muse Spike Test Client"}'
HTTP/2 201
{"client_id":"app_DBjsiN0W-5P2Tq8c","client_id_issued_at":...,"token_endpoint_auth_method":"none", ...}

$ curl -sS -i "https://mcp.imajin.ai/oauth/authorize?response_type=code&client_id=app_DBjsiN0W-5P2Tq8c&redirect_uri=...&code_challenge=...&code_challenge_method=S256"
HTTP/2 307
location: https://jin.imajin.ai/auth/login?next=https%3A%2F%2Fjin.imajin.ai%2Foauth%2Fauthorize%3F...

$ curl -sS -i https://mcp.imajin.ai/mcp -X POST -d '{"jsonrpc":"2.0","id":1,"method":"initialize", ...}'
HTTP/2 401
www-authenticate: Bearer resource_metadata="https://mcp.imajin.ai/.well-known/oauth-protected-resource"
{"error":"invalid_token","onboarding":"https://jin.imajin.ai/.well-known/agent.json"}
```

## Sources for the Muse product-shape claims

- Meta Help Center, "How Muse works with Connectors" (`meta.com/help/artificial-intelligence/1687253048996149`)
- Meta developer docs, Muse Code "Extending and automating" (`dev.meta.ai/docs/muse-code/extending`) — the only place MCP is documented for any Muse product
- Third-party hands-on reporting dated 2026-09-14 through 2026-09-20 (Parallel's test, and independent corroboration) that consumer Muse has no MCP-server field
- `iphoneincanada.ca` coverage of the 2026-09-08 US launch and 2026-09-18/19 Canada expansion

## Related

- Runbook: [`docs/interop/muse-connector.md`](../../docs/interop/muse-connector.md)
- Follow-ups: #2252 (personal-access-token credential), #2253 (aggregate OpenAPI spec)
- Findings comment: posted on #2250
