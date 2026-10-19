# @imajin/kernel

The kernel — the Next.js application implementing the six primitives (Attestation, Communication, Attribution, Settlement, Discovery, Revocation) and the rails that serve them (auth, pay, registry, connections, chat, media, bus). This is not a third-party app; it's what a node operator runs.

Events currently runs inside this same monorepo as separate services pending extraction behind the registered-app contract ([#1981](https://github.com/ima-jin/imajin-ai/issues/1981)) — see the [root README](../../README.md) for the kernel/app boundary. `links` was the first app to leave: `apps/links` was pruned on 2026-09-28 and it now lives at [ima-jin/links](https://github.com/ima-jin/links). `learn` was pruned in [#2503](https://github.com/ima-jin/imajin-ai/issues/2503) and now lives at [ima-jin/learn](https://github.com/ima-jin/learn). `coffee` was pruned in [#2500](https://github.com/ima-jin/imajin-ai/issues/2500) and now lives at [ima-jin/coffee](https://github.com/ima-jin/coffee). `market` was pruned in [#2512](https://github.com/ima-jin/imajin-ai/issues/2512) and now lives at [ima-jin/market](https://github.com/ima-jin/market). `dykil` was pruned in [#2523](https://github.com/ima-jin/imajin-ai/issues/2523) and now lives at [ima-jin/dykil](https://github.com/ima-jin/dykil).

## Run it

```bash
pnpm --filter @imajin/kernel dev   # http://localhost:3000
```

Full setup guide: [docs/DEVELOPER.md](../../docs/DEVELOPER.md).
## Static-header reach clients
Share `/<handle>/reach` for per-platform setup. Agents resolve a DID, handle or
`@handle` at `/.well-known/agent/<id>` to discover live MCP, OpenAPI and signed
reach transports, credential tiers and the reach-only knock flow document.
The additive card retains `schemaVersion: "0.1"` and `imajin-agent-reach/0.1`.
Disabled reach exposes no card, setup page or `AgentReach` DID service.

Both hosted `did:imajin` document endpoints advertise an `AgentReach` service
whose endpoint is that unified card. This node does not host per-principal
`did:web` documents: external domain owners must publish the same service in
their own document, with its own DID as the service ID, for example:

```json
{
  "id": "did:web:example.org#agent-reach",
  "type": "AgentReach",
  "serviceEndpoint": "https://YOUR_NODE/.well-known/agent/YOUR_URL_ENCODED_IMAJIN_DID"
}
```

`buildAgentReachServices(did, cardUrl)` in `src/lib/auth/did-document.ts` builds
this method-neutral entry for document publishers. It is a transport hint, not
a proof of domain ownership or reach authority. Only publish it while reach is
enabled. A2A remains an unadvertised extension point until #2594 ships; OAuth
stranger sign-in is separate (#2592).

Clients that cannot sign requests or complete OAuth can obtain **their own agent's**
reach credential with `POST /reach/ryan/knock` (replace `ryan` with the recipient's
handle or DID). No login, owner approval, or manually issued token is required:

```json
{
  "agentLabel": "My Muse agent",
  "onBehalfOf": {
    "platform": "muse",
    "externalRef": "opaque-platform-reference",
    "selfDescription": "Who I claim to act for"
  },
  "slidingWindowDays": 30
}
```

`onBehalfOf` is **UNVERIFIED**, never an authentication or delegation claim.
The recipient must already have a front-door gate admitting the `soft` tier.
The `201` response contains `bearer` **exactly once**, `requesterDid` (the
foreign-agent stub), `audience` (the recipient DID), `requestId`, `bearerId`,
`scopes`, `surfaces`, `claimVerified: false`, `expiresAt`, and `hardCapAt`.
Save the bearer directly in the client's static `Authorization: Bearer` header
setting; do not log it. There is no retrieval endpoint. A lost response requires
a new knock, which creates a distinct agent credential.

Use that header on `POST /reach/ryan` or
`POST /auth/api/agents/<recipient-DID>/reach` with:

```json
{
  "topic": "collaboration",
  "message": "Would you like to discuss a collaboration?",
  "replyHandle": "opaque-client-thread-reference"
}
```

For a boolean-only gate ask, send `{ "arg": "collaboration" }`. Topic publication,
delivery mode, broker consent, sender blocks and delivery quotas are the same as
for signed agents. The bearer cannot reach another recipient, authenticate a
session, or access the general MCP/REST surfaces. MCP adapters remain separate
follow-ups; this credential is not accepted on the MCP surface.

After delivery, poll
`POST /auth/api/agents/<recipient-DID>/reach/<reachId>/status` using the same
static Authorization header. No body or requester signature is needed. The
response contains `reachId`, `state` (`delivered`, `replied`, or `blocked`), and
`reply` (the recipient's original signed reply event, or `null`). Only envelopes
belonging to that bearer’s agent stub are visible; another stub's receipt returns
404, and another recipient's audience or a revoked/expired bearer returns 401.
An otherwise-valid bearer whose sender is blocked can learn `blocked`, but
receives no reply content and cannot send. Polling retains sliding expiry and
the hard cap. Signed status polling remains supported unchanged.

Expiry slides on valid uses (30/90/180/365-day windows), but never beyond the
unconditional 90-day hard cap. Only hashes are stored. The recipient sees an
information-only Reach inbox card: **No action needed**, with the
**UNVERIFIED onBehalfOf claim**. Blocking the card or a delivered sender
revokes the stub and erases its bearer hashes immediately.

## Inference connectors

Brain connectors (`BRAIN_CONNECTORS` in `src/lib/inference/brain.ts`, `CONNECTOR_REGISTRY` in `src/lib/kernel/connector-registry.ts`) let a DID seal its own provider API key for the completions passthrough (`POST /infer/v1/chat/completions`) instead of a shared env var — see the [inference connectors epic](https://github.com/ima-jin/imajin-ai/issues/1922). In resolution order:

| Connector | Provider adapter | Notes |
|---|---|---|
| Gemini | `openai` (compatible) | No hardcoded default model (#1769) |
| Anthropic | `anthropic` | Main-session brain; migrates last (#1922) |
| xAI | `openai` (compatible) | |
| OpenAI | `openai` | |
| Moonshot AI (Kimi) | `openai` (compatible) | |
| Z.ai (GLM) | `openai` (compatible) | |
| Local Inference | `openai` (compatible) | Owner-supplied `baseUrl`; no sealed key required (#1957) |
| OpenRouter | `openai` (compatible) | Router, not a single provider — one sealed key reaches every model it fronts; `provider/model` ids (e.g. `typesafe/jev-1.13`) forward untouched (#2188) |
