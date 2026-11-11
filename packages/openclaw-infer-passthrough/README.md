# @imajin/openclaw-infer-passthrough
**Default: per-calling-agent authentication.** Every call must supply
the agent's own `app+jwt` and its configured `x-acting-as` selector. Missing,
invalid or shared-marker credentials return 401; there is no gateway-principal
mint, re-mint, catalog cache or direct-key fallback for agent calls.
The kernel alone verifies authority and resolves connector policy.
See the canonical [headers, JWT and error contract](../../deploy/infer-passthrough/README.md#calling-agent-contract).

## Purpose and protocol

This local proxy forwards OpenAI-compatible completions/model discovery,
Anthropic Messages/count-tokens and MCP JSON-RPC to the kernel. The
[inference spec](https://jin.imajin.ai/infer/api/spec),
[MCP runbook](../../docs/ops/openclaw-mcp.md) and
[deployment contract](../../deploy/infer-passthrough/README.md) own the full
wire and operational details. This README is not a route inventory or proof of
a live gateway rollout.

A provider path prefix selects a protocol destination, not a principal or grant.
The calling agent remains the signer; selectors never authorize another identity's
key. Use the caller's usable catalog, not a copied provider/model list. The kernel
owns connector resolution, scope, assignment, revocation and billing decisions.

## Agent mode

`INFER_PROXY_AUTH_MODE` defaults to `agent`. The runtime integration supplies
and refreshes each calling agent's own credential. The proxy performs shape and
expiry checks; the kernel verifies cryptography, audience, scopes and authority.

Authorization Bearer takes precedence. Anthropic/MCP-compatible x-api-key input
is accepted only where the handler permits it and Authorization is absent.
A present malformed Authorization header cannot fall back to x-api-key.
`x-acting-as`, when present, must be a DID and is forwarded as a selector; it is
not inferred from a route principal or shared gateway config.

A kernel 401 is returned as `invalid_agent_credential`, telling the runtime to
refresh that agent's own JWT. There is no proxy-side remint/retry under a host
identity. Other upstream responses retain the kernel's status/body. No agent
request can switch to a direct provider key on timeout, 5xx, denial or revocation.
MCP session/protocol headers and Anthropic protocol headers follow their own
forwarding contract. OpenAI-shaped parameter normalization does not confer auth.

Keep each credential server-side and short-lived. A shared `unused-placeholder`
or static OpenClaw bearer is not a valid agent credential. A harness that can
only configure static headers needs a compatible per-agent credential adapter;
pointing its base URL at this proxy alone is insufficient.

## Personal and organization authority

A personal agent uses its human principal's authorized keys. An org bot is an
agent assigned to the org DID, signing as itself with `sub = azp = agentDid`;
its configured org goes in `x-acting-as`, not the JWT subject. The kernel rechecks
assignment and allowed services on each call and records the bot as actor while
billing the authorized org principal.

An assigned org bot does not need a human per-member grant. Human members do.
Membership alone grants no access to an org-held provider key. Removing or
disabling that connection refuses the next call with `connection_not_loaded`;
it must never fall back to a personal, registrant, app or direct credential.
Per-session conversation switching does not create principal authority.

Org-held keys are write-only and stay in the kernel. No provider key, grant id
or service credential belongs in OpenClaw config, a prompt, smoke output or a
committed file. Use the kernel's existing connector controls, preserving the
selected acting identity and the actual agent signer separately.

## Configuration

Common non-secret controls:

- `KERNEL_BASE_URL`: required kernel origin, using its protected public front door
  from another host rather than bypassing TLS/routing through a raw listener port.
- `INFER_PROXY_HOST`: defaults to `127.0.0.1`; keep the host listener private.
- `INFER_PROXY_PORT`: defaults to 8787.
- `KERNEL_TIMEOUT_MS`: defaults to 20000 for the upstream deadline.
- `MCP_PUBLIC_URL`: defaults to `https://mcp.imajin.ai`; resource audience must
  agree with the kernel's own MCP issuer configuration.
- `INFER_PROXY_ROUTES_CONFIG`: optional non-secret route configuration. It never
  grants agent authority. Do not carry grant/attestation ids as routing config.

Run through `node --import tsx packages/openclaw-infer-passthrough/src/server.ts`
under the existing process supervisor. Do not run the tsx CLI as a signal-relaying
wrapper. Use the deployment-owned systemd unit/updater rather than copying a
second unit definition from a README. Never print a secret-bearing EnvironmentFile.

## Explicit host-static mode: non-agent instances only

`INFER_PROXY_AUTH_MODE=host-static` is a separate compatibility deployment for
non-agent host traffic. Never point agent traffic at it or use it to bypass a
failed agent credential integration.

This mode requires `OPENCLAW_APP_DID`, protected `OPENCLAW_APP_PRIVATE_KEY` and
`INFER_PROXY_PRINCIPAL_DID`, unless the optional route config supplies principals.
It mints principal-based app tokens against live consent, caches short-lived
tokens/catalogs and can retry once after a 401. The signed challenge binds
`appDid`, `principalDid`, nonce and timestamp, never a stored grant id. MCP uses
its resource audience and actual permitted tool scopes, not inference authority.

Optional `modelPrefixes`, `directBaseUrl` and `directApiKeyEnvVar` entries permit
route overrides and explicit break-glass. The JSON contains only env-variable
names, never keys. Direct fallback is restricted to kernel 5xx/timeouts, never
4xx; it bypasses kernel metering and is not an authorized agent lane. MCP and
model discovery have no direct-provider fallback. `DIRECT_TIMEOUT_MS` defaults
to 20000. Re-granting uses fresh live consent rather than a config-file grant id.

Health meaning is mode-specific: agent mode does not mint a gateway-principal
token; host-static health checks its configured mint path. Liveness/health alone
proves neither a model completion nor an org billing relationship. Inspect the
mode and contract in the deployment guide before promoting a candidate.

## Host-static routing, errors and metering

These details apply only to an explicitly isolated non-agent host-static instance.
Its default generic OpenAI-compatible, Anthropic and MCP entries use the configured
principal, without a routes file or direct fallback. Catalog routing caches by
principal for sixty seconds and refreshes once on a model miss, even inside that
TTL. `picked: false` does not exclude a servable row. Provider/model ids, including
slashes, remain intact. A failed refresh returns an auth/upstream error, never a
stale catalog or a misleading unknown-model answer.

Explicit route prefixes use their own principal. Prefix overrides may select a
route, but no catalog row borrows another principal's direct key. An optional
inference `actingAs` selector keeps the member as principal; live org authority
and the member grant are checked before unsealing. Such org-selected calls never
fall back to personal/app/direct credentials, even on an outage. Org-held cards
supply keys rather than a picked model; send the requested model on each call.
Legacy `attestationId` config entries are ignored with one value-free startup
warning, not used to grant authority.

A mint refusal is 401; a revoked/no-live grant is 403 with the Grants repair path.
A missing model is 422; a model absent after catalog refresh is 404 naming the
connector control. Kernel 4xx, including 402 spend-cap refusal, is forwarded, not
retried through direct keys. Unavailable/timed-out kernel calls without an allowed
fallback produce 502; genuinely unexpected errors remain 500. Host-static MCP
checks the configured app-DID hint, requests the granted MCP scope set and rejects
an empty surface intersection with 403. Per-tool checks remain in the kernel.

OpenAI-shaped normalization maps `max_tokens` to `max_completion_tokens` only
when the latter is absent, and drops `reasoning_effort` with tools for matching
OpenAI model ids. Other provider bodies are not rewritten by that translation.
Anthropic version/beta headers and MCP session/protocol headers are forwarded
under their respective protocol contract. Model discovery and MCP never have a
direct-provider fallback.

Health reports `kernelOk`, `fallbackCount`, `fallbackRate`, `lastFallbackAt`,
`passthroughOk`, `passthroughErrorCount` and `lastPassthroughError`. A returned 5xx
marks passthrough unhealthy; a subsequent success clears it. A 4xx neither trips
nor clears it. A host-static mint failure is unhealthy even if a direct key works.
Direct fallback traffic is not kernel-metered, so a healthy host alone cannot
prove the inference or accounting path. Agent mode keeps its no-mint contract.

Kernel inference metering records principal, agent, provider/model and token
counts. `X-Imajin-Session`/`X-Imajin-Turn` correlation headers, with supported
legacy aliases, identify the session/turn; `X-Imajin-Run` carries a run id into
usage metadata. Upstream request ids provide external correlation. Anthropic
cache-read/cache-creation tokens remain metadata; count-tokens requests are not
metered as billed model completions. Verify through the authorized connector
spend or usage-audit contract, not by logging prompts, responses or keys.
The Anthropic org-bot smoke's agent token uses `sub = azp = agentDid`, audience
`imajin:apps`, scope `infer:completions`; its independent audit token reads evidence
only. A mismatched org-subject token is refused, never repaired by a self-grant.

## Operator verification

`node scripts/artifact-org-bot-smoke.mjs --dry-run` needs no credentials, network
or billing and proves no live integration. The live Anthropic smoke takes a
protected JSON input stream from the operator's credential loader: agent/org
DIDs, selected model, agent JWT and an independently authorized read-only usage
audit token. Never put that input on a command line or in source/logs.

The smoke checks the usable kind-A route, makes one completion through the local
proxy and requires correlated usage with the expected billed org. Its output is
limited to status, billedOrg and usageIds, not prompts, responses or credentials.
It has no Warp lane implementation; do not present an Anthropic result as proof
of another provider or a compatible external plugin deployment.

For a promotion, verify the exact release SHA has successful production deployment
evidence and the candidate passes the deployment-owned mode-aware health checks.
Then prove a small metered call and a connection-off refusal with no fallback.
The updater can roll back a failed promotion; source tests do not prove a host
installation. NanoClaw's checked-in example still needs credential integration:
see [its readiness guide](../../docs/agents/nanoclaw-first-boot.md).
