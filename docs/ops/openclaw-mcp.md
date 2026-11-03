# OpenClaw MCP gateway operations

Repo implementation: #2278. Host configuration, real consent and the seven-day
dogfood window: #3237. This runbook is not permission to change a running host.

## One profile, one agent, one OAuth token

Two profiles use the same mechanism:

- **Jin → Ryan**: token subject is Jin's agent DID; the fixed `acting_for` claim
  is Ryan's DID. Ryan alone approves. Credential access uses Ryan's connections.
- **Artifact-Jin → Artifact**: token subject is Artifact-Jin's agent DID;
  `acting_for` is Artifact's org DID. An active human org owner/admin approves;
  ordinary membership cannot approve. Access uses Artifact's org-held connections.

Assigned bots need no member-key grant (#3182). Human members doing org work
still need the separate member grant on the org connector card (#3181/#3200).
Neither a Telegram allowlist nor a gateway principal supplies authority.
Speaker turns and acting-for-speaker attribution are #3231, not this integration.

The consented assignment must match the agent's fixed configured `actAs`.
The token always signs in as the agent, never Ryan, Artifact, or a gateway
account. The calling client is `azp`, not the agent or payer.
No per-session switching and no `x-acting-as` / `x-acting-for` forwarding.

Use a separate OAuth registration and credential/token cache for each agent.
Never let `main` and `artifact` share a token, even on one gateway. A gateway's
global server registry and shared OAuth cache are **not** agent isolation.
If the installed OpenClaw version cannot isolate MCP credentials per agent,
use separate isolated gateway profiles; do not install one shared server entry.
The plugin rollout (#150/#151 in ima-jin/openclaw-imajin-plugin) is independent.

## Gateway config (operator step after merge)

This is the `mcp.servers.imajin` entry for **one isolated agent profile**, not a
single gateway-wide credential for every agent. The service origin is
`https://mcp.imajin.ai`; the Streamable HTTP resource is `/mcp`.

```json
{
  "mcp": {
    "servers": {
      "imajin": {
        "enabled": true,
        "transport": "streamable-http",
        "url": "https://mcp.imajin.ai/mcp"
      }
    }
  }
}
```

Use the MCP client's OAuth authorization-code flow with PKCE S256. A 401
challenge advertises `/.well-known/oauth-protected-resource`, which identifies
the issuer's `/.well-known/oauth-authorization-server` and `/oauth/register`.
OAuth is negotiated through discovery, not an invented `oauth: true` config flag.
The registered callback must exactly match the callback used for consent and
redemption. Verify the installed OpenClaw release's OAuth support before rollout.

No `headers`, service keys, plugin keypair, or pasted bearer belongs in this
snippet. In particular, never put Anthropic, Warp, or Imajin static keys in gateway
config. The only gateway credential for this MCP path is the consent-issued
OAuth credential; the client's protected per-agent store owns refresh rotation.

## Scope set and existing-flow parity

Register and request this MCP scope set for the existing Jin surface:

```json
[
  "media:read",
  "media:write",
  "media:share",
  "connections:read",
  "discovery:read",
  "warp:dispatch",
  "inference:read",
  "inference:write"
]
```

- **Identity**: `ping` verifies the authenticated agent DID. The existing plugin
  identity operations remain available; `identity:read` is a platform scope,
  not an MCP scope, and must not be advertised as a supported MCP tool.
- **Media**: `media:read`, `media:write`, `media:share`; trust-graph lookup for
  share-by-name uses `connections:read`. Data tools retain the agent subject's
  data namespace; selecting a payer does not silently transfer library ownership.
- **Attest**: inference status/capture and their attestations use
  `inference:read` / `inference:write`. General plugin attestation operations
  remain on the plugin path: `attestations:write` is not an MCP scope.
- **Discover**: `discovery:read` enables `imajin_list_api_specs`,
  `imajin_get_api_spec`, `imajin_list_scopes`, and `imajin_get_scope_manifest`.
- **Warp**: `warp:dispatch` gates dispatch and run observation/control. Keys
  stay in the assigned DID's kernel-held connection; do not call `warp_seal_key`
  through an agent OAuth token. Org-held dispatch implementation is #3203.

Use MCP where an equivalent tool exists; keep the plugin's direct identity,
attestation and inbound-message listener paths otherwise. This PR does not
remove or rewrite those flows. The dogfood log must compare all five families,
including retained direct paths, rather than claiming every verb became MCP.

Scopes are bounded by client registration, the MCP vocabulary and explicit
consent. Agent refresh can narrow scopes but cannot widen past that consent;
new scopes or a different assignment require fresh consent.
Agent-bound consent accepts MCP-native and Warp scopes only. Other connector
adapters have not acquired fixed-assignment handling here; requesting their
scopes returns `agent_scope_unsupported` rather than spending agent or gateway
keys. Keep those existing connector flows on the plugin path.

## Agent consent walk

1. Start OAuth separately from the chosen isolated agent profile. Register its
   own client and exact callback; request the scope set above. An optional
   `agent_did` authorization-query hint pre-fills the DID, but never authorizes
   it or selects its principal.
2. Sign in as the **human approver**, not as the agent: Ryan for Jin, or an active
   Artifact owner/admin for Artifact-Jin. Acting-as cookies do not confer consent
   rights. No keypair is copied into the gateway.
3. On `/auth/authorize`, select **Authorize an agent on its assigned identity’s
   keys**, enter the agent DID and choose **Load assigned identities**.
4. Explicitly select the one assigned DID in **Assigned identity (keys and
   billing)**. Even one available principal is not selected automatically.
   The page shows both DIDs before Authorize becomes available. If `serviceOf`
   is empty, the selection is invalid, or this human lacks approval rights,
   stop on the typed error; never choose an arbitrary first principal.
5. Review scopes and the displayed fixed pair, then Authorize. The kernel signs
   the pair and the approving human into the authorization. The single-use code
   and refresh lineage name that authorization; token `sub` is the agent DID,
   `azp` is this client, and `acting_for` is the selected DID.
6. Let the client redeem with the same PKCE verifier. Keep the access/refresh
   credential in that agent's protected OAuth store only. Repeat the full flow
   for the other agent; never copy a credential between profiles.
7. Verify the pair with the smoke probe and inspect the audit attribution before
   permitting paid work. Re-consenting the same agent/client for another
   assignment supersedes the old authorization, not its token's claims.

Every credential access rechecks assignment, OAuth authorization and connector
custody. Restore assignment/service permission on `/auth/agents`; restore OAuth
authorization via `/jin` → Grants and consent again; restore a loaded, active
connection/custody on `/auth/connectors` as the assigned identity. Do not repair
an error by forwarding an org header, using a gateway key, or borrowing a token.

## Dev verification

Dev issuer: `https://dev-mcp.imajin.ai`; discovery and DCR live on that origin.
Kernel/login: `https://dev-jin.imajin.ai/auth/login`. Ryan signs in himself with
his separate dev identity; secrets do not pass through chat or PR text.
Dev main lacks this branch's new screen until a branch deploy.

For local verification, initialize a disposable local Postgres using
`node scripts/migrate.mjs`, which applies the canonical seed/baseline and later
migrations. Configure the local issuer/resource and kernel origin consistently.
Use generated throwaway human/agent identities and assignment rows, never prod
keys or sessions. Walk the real consent page and keep the screenshot free of
codes, tokens, cookies, developer tools and response bodies.

For consent verification evidence, see the screenshots in the PR #3235 comments.

## Read-only smoke

Load `MCP_ACCESS_TOKEN` securely from the chosen agent's OAuth store into the
environment; do not paste it into shell history. Set the non-secret
`MCP_EXPECTED_DID` and `MCP_EXPECTED_PRINCIPAL` to that profile's consented pair.
`MCP_BASE_URL` defaults to `https://mcp.imajin.ai`; for local verification use
the local HTTP loopback origin. Then run:

```powershell
node scripts/mcp-gateway-smoke.mjs
```

The script lists tools and calls only `ping`. It requires the expected pair,
checks the server-authenticated DID, refuses redirects, and prints one JSON
line containing only `did`, `scopes`, and `result` (`PASS`/`FAIL`). Failure exits
nonzero, without printing errors, tokens, HTTP bodies or tool results. It never
registers a client, refreshes a token, dispatches work, or starts the dogfood week.

## Seven-day dogfood log template (#3237)

Attach the completed log to #3237, not this PR. Leave all dates/results blank
until the operator actually starts the post-merge window. Never attach raw
tool bodies or credentials.

- Deployed commit/version:
- Operator and window (UTC start/end; seven complete days):
- Agent/profile and consented pair (one entry per agent):
- Daily UTC date / calls by agent DID / billed DID / failures / wrong-account count:
- Identity parity (MCP ping + retained plugin identity path), pass/fail and safe evidence:
- Media parity, pass/fail and safe evidence:
- Attestation parity (inference MCP + retained plugin attest path), pass/fail and safe evidence:
- Discovery parity, pass/fail and safe evidence:
- Warp parity, pass/fail and audit reference:
- Chat listener/direct-path fallback, pass/fail:
- Revocation refusal/control-restoration check:
- Regression or chat/actAs delta, parent-linked issue and evidence:
- Final PASS/FAIL, unresolved problems and issue links:

The operator owns rollout, seven days of evidence, and delta filing. Follow the
repo's native sub-issue and duplicate-seam rules before filing any issue.
