# @imajin/kernel

The kernel — the Next.js application implementing the six primitives (Attestation, Communication, Attribution, Settlement, Discovery, Revocation) and the rails that serve them (auth, pay, registry, connections, chat, media, bus). This is not a third-party app; it's what a node operator runs.

As of 2026-10-21, all six extracted verticals live in their own repositories behind the [registered-app contract](https://github.com/ima-jin/imajin-ai/issues/1981): [coffee](https://github.com/ima-jin/coffee/blob/main/README.md), [dykil](https://github.com/ima-jin/dykil/blob/main/README.md), [events](https://github.com/ima-jin/events/blob/main/README.md), [learn](https://github.com/ima-jin/learn/blob/main/README.md), [links](https://github.com/ima-jin/links/blob/main/README.md) and [market](https://github.com/ima-jin/market/blob/main/README.md). Events' kernel copy was pruned in [#2517](https://github.com/ima-jin/imajin-ai/issues/2517); its cutover closed on 2026-10-20 with buy/QR smoke deferred to [#2989](https://github.com/ima-jin/imajin-ai/issues/2989). Dykil's node-witnessed legacy import remains incomplete in [#2522](https://github.com/ima-jin/imajin-ai/issues/2522). See the [root README](../../README.md) for the generated inventory and dated acceptance status; source extraction alone is not operational acceptance.

## Run it

```bash
pnpm --filter @imajin/kernel dev   # http://localhost:3000
```

Full setup guide: [docs/DEVELOPER.md](../../docs/DEVELOPER.md).

## Operator lanes

Merged-source snapshot **2026-10-22**, since the [#3037 replay](https://github.com/ima-jin/imajin-ai/pull/3037); these changes are pre-cut for v0.8.26, not evidence of deployment:

- **Registered apps:** direct human operators can inspect kind, status, consent/activity and registration provenance, including explicit unknown history. Expired entries remain expandable; failed provisions without a live claim code do not offer Reissue ([#3047](https://github.com/ima-jin/imajin-ai/pull/3047)).
- **Clear:** an active or dormant app opens a confirmation naming its live consent count. Confirmation uses the existing registry revoke route, retains the row and consent history, and exposes the signed `registry.app.revoked` receipt. Non-operators and acting-for identities cannot use it ([#3051](https://github.com/ima-jin/imajin-ai/pull/3051)).
- **DCR expiry:** the ten-minute sweep expires active DCR registrations at least seven days old only when they have never had consent and have no provision, claim or first-party protection. Status and node-signed `registry.app.expired` evidence commit together; no rows are deleted ([#3053](https://github.com/ima-jin/imajin-ai/pull/3053)).
- **Record:** inspect personal history, or act as an organization with the required owner/admin and `jin` service access. Filter people/agents; rows identify who acted and expose exact grant/approval links only when separately authorized. Missing legacy references are not guessed. Switching identity clears the view and in-flight reads ([#3046](https://github.com/ima-jin/imajin-ai/pull/3046), [#3049](https://github.com/ima-jin/imajin-ai/pull/3049), [#3052](https://github.com/ima-jin/imajin-ai/pull/3052)).
- **Inbox / Operator approvals:** default lists and attention counts include only actionable cards, with relative age. **Show history** retrieves retained resolved, expired, superseded or archived cards. The ten-minute sweep records node-signed expiry; `OPERATOR_APPROVAL_EXPIRY_DAYS` defaults to seven days, with source deadlines taking precedence ([#3050](https://github.com/ima-jin/imajin-ai/pull/3050)).
- **Grants:** app last-used evidence includes successful mint/validate activity and historical OAuth refreshes; unknown pre-recording history is labelled, not reported as never. Idle active grants get a 30-day warning, not automatic revocation ([#3044](https://github.com/ima-jin/imajin-ai/pull/3044)). `/auth/agents` Renew offers a lease choice and preview; the default preserves the previous lease, capped at 30 days. Critical approval grants warn within 24 hours of expiry ([#3038](https://github.com/ima-jin/imajin-ai/pull/3038)).
- **Blocked on you:** current linked PR/issue state reconciles stale Warp blockers; merged/closed work stops appearing as an operator block, while ready PRs await review. Provider/authority failures retain the signed blocker ([#3043](https://github.com/ima-jin/imajin-ai/pull/3043)).

Contracts and access limits: [Jin spec](api-spec/jin.yaml) · [auth spec](api-spec/auth.yaml) · [registry spec](api-spec/registry.yaml).
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
As of **2026-10-22**, `GET /infer/v1/models/usable` exposes each usable sealed connector's full picker list in OpenAI list shape; `imajin.picked` marks the current selection, not the only callable model. Non-picked listed models resolve through the same connector and metering path; unsealed/ungranted/modelless cards contribute no models ([#3045](https://github.com/ima-jin/imajin-ai/pull/3045)). See the [inference spec](api-spec/infer.yaml).

Delegated app-token minting can resolve the live consent by `principalDid`, mutually exclusive with the legacy `attestationId` selector ([#3042](https://github.com/ima-jin/imajin-ai/pull/3042)). The [OpenClaw passthrough runbook](../../packages/openclaw-infer-passthrough/README.md) already documents principal-based configuration, catalog routing, consent-failure recovery and operator-only rollout cleanup from [#3048](https://github.com/ima-jin/imajin-ai/pull/3048). Re-granting needs no proxy restart after that rollout; auth/scope failures never trigger direct fallback.

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
