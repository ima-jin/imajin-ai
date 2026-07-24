# RFC-32: Agent Protocol Interoperability — The Node Speaks Everything

**Status:** Draft
**Authors:** Ryan Veteze, Jin
**Created:** May 14, 2026
**Updated:** July 24, 2026 — KYA-OS (DIF) actor model, corrected AP2 mandate vocabulary, and the credential field-mapping (§4.7)
**Discussion:** TBD
**Related:** RFC-27 (Multi-Agent Coordination), RFC-31 (Agent Execution Sandbox), RFC-23 (Multi-Chain Settlement), RFC-05 (Intent-Bearing Transactions), RFC-01 (.fair Attribution), RFC-39 (Verifiable Skills)
**Tracking:** epic #965 (interop), #971 (AP2 mandate from .fair), #394 (agent sub-identity VC delegation)

---

## Summary

In the last 12 months, eight major agentic protocols have launched across commerce, communication, and coordination. Each solves one piece of the puzzle. None provide the full stack: portable identity, verifiable attribution, transparent settlement, and an auditable chain of agency.

Imajin doesn't compete with these protocols. Imajin is the accountability layer underneath all of them.

The thesis is simple: **Imajin is the source of truth. We speak everything.**

An external agent arrives at an Imajin node and finds a `.well-known/` surface that speaks its native protocol. It pays through HTTP 402 settlement. Every transaction carries a `.fair` manifest. Every action is attributable to a DID. The chain is the proof, regardless of which protocol carried the payload.

This RFC defines how Imajin nodes serve as the canonical source of truth while natively speaking every major agentic protocol.

---

## 1. Problem

Each protocol solves one piece. None solve the whole:

| Protocol | What it solves | What's missing |
|----------|---------------|----------------|
| **MCP** | Agent ↔ tools/data discovery | No portable identity. No settlement. No attribution. |
| **A2A** | Agent discovery, capability negotiation, task lifecycle | No verifiable identity chain. No settlement mechanism. No audit trail. |
| **AP2** | Cryptographic proof of delegation for spending (Cart + Payment Mandates as VDCs) | No attribution of *what* the agent did. No settlement layer. No portable identity beyond the mandate. |
| **KYA-OS** (ex-MCP-I, now DIF) | Agent identity + delegation credential + verifier role (the four KYA questions) | No settlement. No attribution of *what* was done. Verifies the authority chain; doesn't record the outcome. |
| **MPP** | HTTP-native agent billing (402 → pay → retry) | No identity. No proof of work. No audit trail of what was purchased. |
| **x402** | Crypto micropayments via HTTP 402 | No identity. No attribution. No proof of service delivery. |
| **UCP** | Agent checkout flows, merchant feeds | No portable agent identity. No cross-merchant attribution. No settlement transparency. |
| **Visa TAP** | Agent registration, bot-vs-agent distinction | No proof of *what* the agent did. No attribution chain. Settlement is opaque. |
| **Mastercard Agent Pay** | Tokenized agentic payments | No verifiable action log. No attribution of agent behavior. No cross-platform identity. |

The gaps are consistent:

1. **Identity is fragmented.** Every protocol invents its own identity model. None are portable across protocols. An agent registered with Visa TAP is not the same agent in A2A is not the same agent in MCP.

2. **Attribution is absent.** An agent can pay (MPP) but can't prove what it did. An agent can discover tools (MCP) but has no record of which tools it used and why. An agent can negotiate (A2A) but the settlement is a black box.

3. **Settlement is opaque.** Money moves, but the connection between the action and the payment is lost. There is no `.fair` manifest. There is no verifiable distribution of value.

4. **Audit is impossible.** When a regulator asks "did this agent have permission to do that?" — there is no chain to show. When a user asks "what did my agent do last week?" — there is no log. When a merchant asks "was this payment legitimate?" — there is no proof.

The protocols are transport. Imajin is the record.

---

## 2. Position

Imajin implements every major agentic protocol as a transport layer. The node is the source of truth. The `.fair` manifest is the receipt. The DID chain is the proof of agency. The settlement layer is transparent, attributable, and auditable.

**We don't compete. We complete.**

Every external protocol becomes a surface adapter on top of the same canonical infrastructure:
- One identity model (DID) spoken through every protocol
- One attribution model (`.fair`) attached to every transaction
- One settlement layer (HTTP 402 + pluggable wire schemes) handling every payment
- One audit chain (signed actions, delegation proofs, event log) recording everything

The external agent doesn't need to know about Imajin primitives. It speaks A2A, MCP, MPP, or AP2 — and the node translates. The agent gets a native experience. The node gets a canonical record. The `.fair` manifest rides alongside regardless of transport.

---

## 3. Discovery Pattern — `.well-known/` as the Handshake

When an external agent arrives at an Imajin node, it finds a `.well-known/` surface that describes the node's capabilities in every protocol it speaks:

```
/.well-known/agent.json       → A2A Agent Card (capabilities, supported protocols)
/.well-known/mcp.json         → MCP tool surface (available tools, schemas)
/.well-known/fair-policy.json → .fair attribution terms (10% foundation, 10% devs, 80% community)
/.well-known/dfos             → DFOS federation endpoint (existing, 106/106 conformance)
/.well-known/ap2-manifest     → AP2 mandate templates (spending limits, authorization chains)
```

### 3.1 A2A Agent Card (`/.well-known/agent.json`)

The Agent Card describes the node as an A2A agent — not a human-like assistant, but a platform agent with deterministic capabilities:

```json
{
  "name": "imajin-node",
  "description": "Imajin node — sovereign identity, attribution, and settlement",
  "url": "https://imajin.ai",
  "version": "1.0.0",
  "capabilities": {
    "streaming": false,
    "pushNotifications": true,
    "stateTransitionHistory": true
  },
  "authentication": {
    "schemes": ["did-imajin"],
    "credentials": null
  },
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text", "json"],
  "skills": [
    {
      "id": "registry-query",
      "name": "Registry Query",
      "description": "Query the Imajin identity registry for DIDs, handles, and attestations",
      "tags": ["identity", "registry"],
      "examples": ["Find user @ryan", "Get DID for handle baconjay"],
      "inputModes": ["text"],
      "outputModes": ["json"]
    },
    {
      "id": "event-checkout",
      "name": "Event Checkout",
      "description": "Purchase tickets for events with .fair attribution",
      "tags": ["commerce", "events", "settlement"],
      "examples": ["Buy 2 tickets to TechTO"],
      "inputModes": ["text"],
      "outputModes": ["json", "text"]
    },
    {
      "id": "media-upload",
      "name": "Media Upload",
      "description": "Upload media assets with automatic .fair attribution",
      "tags": ["media", "storage", "attribution"],
      "examples": ["Upload my profile photo"],
      "inputModes": ["text", "file"],
      "outputModes": ["json"]
    }
  ]
}
```

The Agent Card is generated dynamically from the node's actual tool surface. As apps register and tools expand (RFC-31), the Agent Card reflects the current capabilities.

### 3.2 MCP Tool Surface (`/.well-known/mcp.json`)

The MCP surface exposes the same capabilities as structured tools:

```json
{
  "tools": [
    {
      "name": "registry_search",
      "description": "Search the Imajin identity registry",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" },
          "type": { "type": "string", "enum": ["person", "business", "event"] }
        },
        "required": ["query"]
      }
    },
    {
      "name": "event_purchase",
      "description": "Purchase event tickets with settlement",
      "inputSchema": {
        "type": "object",
        "properties": {
          "event_id": { "type": "string" },
          "quantity": { "type": "number" },
          "payment_method": { "type": "string", "enum": ["stripe", "mjnx", "usdc"] }
        },
        "required": ["event_id", "quantity"]
      }
    }
  ],
  "resources": [
    {
      "uri": "fair://policy",
      "name": ".fair Policy",
      "description": "Machine-readable attribution and distribution terms",
      "mimeType": "application/json"
    }
  ]
}
```

### 3.3 .fair Policy (`/.well-known/fair-policy.json`)

The `.fair` policy is the node's usage agreement — machine-readable, self-describing, no sales call required:

```json
{
  "version": "1.0.0",
  "policy": {
    "foundation": { "share": 0.10, "recipient": "did:imajin:FOUNDATION" },
    "developers": { "share": 0.10, "recipient": "did:imajin:DEV_POOL" },
    "community": { "share": 0.80, "recipient": "did:imajin:COMMUNITY_POOL" }
  },
  "settlement": {
    "methods": ["stripe", "mjnx", "usdc-base", "usdc-solana"],
    "minimum": { "amount": "0.01", "currency": "USD" }
  },
  "attribution": {
    "required": true,
    "manifest_format": "fair-v1",
    "chain_inclusion": true
  }
}
```

An external agent reads this before transacting. The `.fair` manifest on every subsequent transaction enforces these terms. The chain proves compliance.

### 3.4 AP2 Manifest (`/.well-known/ap2-manifest`)

AP2 uses **Verifiable Digital Credentials (VDCs)** as "Mandates" for spending authorization. As of the current AP2 spec (`ap2-protocol.org`, an open extension of A2A + UCP), there are **two mandate types, each in two stages**:

- **Cart Mandate** (a.k.a. Checkout Mandate) — references the specific items + purchase details negotiated with the merchant. Shared with the merchant.
  - *Open* stage: the user's constraints/goals before a cart is finalized (autonomous execution).
  - *Closed* stage: authorization for a specific, finalized checkout.
- **Payment Mandate** — authorizes payment against a specific instrument. Shared with the credential provider, networks, and merchant PSP.
  - *Open* stage: constraints on payment (budget, allowed instruments).
  - *Closed* stage: authorization for a specific amount bound to a finalized checkout.

The Imajin node generates mandate templates from `.fair` manifests. The node's `.fair` delegation record maps onto the **Open Cart Mandate** (the standing authorization + constraints); a finalized transaction maps onto the **Closed** stages:

```json
{
  "mandate_type": "cart_mandate",
  "stage": "open",
  "issuer": "did:imajin:OWNER",
  "delegation_chain": ["did:imajin:OWNER", "did:imajin:AGENT"],
  "constraints": {
    "per_transaction": "100.00 USD",
    "per_day": "500.00 USD",
    "per_month": "2000.00 USD",
    "authorized_merchants": ["*"]
  },
  "attribution_required": true,
  "fair_policy_url": "https://imajin.ai/.well-known/fair-policy.json"
}
```

The mandate is a VDC signed by the owner's DID. The agent presents it when initiating payment. The `.fair` manifest on the resulting transaction is the receipt — and it is the *richer* record (see §4.7 for the exact field-level mapping and the signature-curve caveat).

> **Note (Jul 2026):** the earlier draft named a single `spending_authorization` mandate. That predates the current AP2 Cart/Payment × Open/Closed model. AP2 also natively supports `x402` as a payment rail, which we already speak (§4.4).

---

## 4. Protocol Mapping to Imajin Primitives

Each external protocol maps to existing Imajin primitives. Nothing new is invented — the node translates:

| Protocol | Imajin Primitive | How It Maps |
|----------|-----------------|-------------|
| **MCP** | Agent DID + tool surface | Agent authenticates via DID. Platform APIs (registry, events, media, pay) exposed as MCP tools. Tool calls are signed actions in the chain. |
| **A2A** | Agent DID + Agent Card | Node capabilities described in A2A Agent Card format. Task lifecycle maps to bus events. Task completion carries `.fair` manifest. |
| **AP2** | `.fair` manifest + DID delegation | `.fair` manifest IS the mandate. Agent DID chain proves delegation. Verifiable Credentials generated from DID keypairs. Settlement enforces spending limits. |
| **MPP** | HTTP 402 settlement (existing) | Imajin already implements 402 → pay → retry. MPP wire scheme becomes another option in the pluggable settlement architecture alongside Stripe Link and MJNx-direct. |
| **x402** | HTTP 402 settlement (existing) | Same 402 pattern, crypto wire scheme. x402 (USDC on Base) becomes another settlement rail. `.fair` manifest attached to every x402 transaction. |
| **UCP** | Events/market checkout (existing) | Merchant feed from registry. Checkout flow already exists. UCP is a surface adapter — same cart, same settlement, same attribution, different entry point. |
| **Visa TAP** | Agent DID registration | Imajin agent DIDs map to Visa's trusted agent registry. Registration attestation = trust signal. Agent DID proves identity; `.fair` manifest proves behavior. |
| **Mastercard Agent Pay** | Agent DID + tokenized settlement | Agent DID is the registered agent. Agentic tokens flow through `.fair` settlement. Dynamic Token Verification Codes linked to DID-attested actions. |

### 4.1 MCP: Tools as Signed Actions

When an external agent calls an MCP tool on an Imajin node:

1. Agent presents its DID (via `Authorization: DID {did}` header or TLS-like DID handshake)
2. Node validates the DID and delegation chain
3. Tool call executes with the agent's scoped permissions (RFC-31)
4. Action is signed and recorded in the chain
5. If the tool call involves value transfer, a `.fair` manifest is generated

The MCP `call_tool` response includes:
```json
{
  "result": { ... },
  "attribution": {
    "fair_manifest_cid": "bafy...",
    "action_signature": "sig...",
    "block_timestamp": "2026-05-14T17:30:00Z"
  }
}
```

### 4.2 A2A: Tasks as Bus Events

A2A's task lifecycle maps directly to Imajin's event bus:

| A2A State | Imajin Event | Description |
|-----------|-------------|-------------|
| `submitted` | `task.requested` | Agent submits task to node |
| `working` | `task.assigned` | Node assigns task to worker/agent |
| `input-required` | `task.pending_input` | Node needs more information |
| `completed` | `task.completed` | Task done, result delivered |
| `failed` | `task.failed` | Task failed, reason recorded |
| `canceled` | `task.canceled` | Task canceled by requester |

The task result includes a `.fair` manifest if value was exchanged. The entire task lifecycle is replayable from the chain.

### 4.3 AP2: .fair as the Mandate

AP2's "Mandate" — a Verifiable Credential authorizing an agent to spend — is semantically identical to a `.fair` manifest with delegation:

```
AP2 Mandate:
  - Who can spend (agent DID)
  - How much (spending limits)
  - Who authorized it (owner DID)
  - Cryptographic proof (VC signature)

Imajin .fair + delegation:
  - Who acted (agent DID)
  - What was paid (settlement record)
  - Who authorized it (owner DID in delegation chain)
  - Cryptographic proof (action signatures)
```

The `.fair` manifest is the richer record — it includes not just *that* spending was authorized, but *what* was purchased, *who* gets attributed, and *how* value is distributed.

### 4.3a KYA-OS (DIF): the Verifier reads our chain

**KYA-OS** ("Know Your Agent Operating System," formerly MCP-I) was donated by Vouched to the **Decentralized Identity Foundation** and is now developed under DIF's Trusted AI Agents Working Group. It extends MCP with a full identity + delegation layer and answers the **four KYA questions**:

1. **Who is the agent?** — a cryptographically anchored identifier (a DID), not a session token or API key.
2. **Who authorized the agent?** — the human principal, ideally with direct-interaction confidence.
3. **What is the agent permitted to do?** — scope of delegation (not binary).
4. **Can the agent be trusted?** — reputation / track record.

KYA-OS defines four actors: **User (Principal)**, **Agent**, **Service**, and a **Verifier** — typically an edge proxy that checks credentials against policy *at runtime* before a request reaches the Service.

This is our kernel described from the outside. The mapping is one-to-one:

| KYA-OS question | Imajin primitive that answers it |
|-----------------|----------------------------------|
| Who is the agent? | Agent `did:imajin:...` (resolvable DID Document) |
| Who authorized it? | Principal DID in the delegation record + `actingFor` signed field |
| What may it do? | `identity_members.allowedServices` scope → serialized as a scoped delegation credential |
| Can it be trusted? | Attestations + `.fair` track record on the chain (proof-of-history) |

**The one thing KYA-OS leaves open, we already have.** KYA-OS verifies the *authority chain* up to the moment of action; it does not record *what the agent did* afterward. The `.fair` manifest + signed action log is exactly that missing outcome record. So Imajin is not a competitor to KYA-OS — it is the **Service + record** side that makes a KYA-OS verification *auditable after the fact*. An Imajin node can present as a KYA-OS-conformant Service, and the Verifier (edge proxy) resolves `did:imajin` and validates our delegation credential without any prior relationship — which is the whole point of the `has-a` (portable credential) model.

> This is the same boundary community reviewer **0xbrainkid** drew on #394: row-based `identity_members` is enough when the verifier lives *inside* Imajin services, but a **portable delegation credential** is required the moment the verifier sits across a service/org boundary. KYA-OS *is* that cross-boundary case. See §4.7 for the credential we emit.

### 4.4 MPP / x402: 402 as the Universal Settlement Surface

Imajin already implements HTTP 402 settlement (RFC-05). Adding MPP and x402 is adding wire schemes, not new infrastructure:

```
Client request → 402 Payment Required
                ↓
         Settlement negotiation
                ↓
    ┌───────────┼───────────┐
    ↓           ↓           ↓
 Stripe Link  MJNx-direct   USDC (x402)
    ↓           ↓           ↓
  .fair manifest attached to all
```

The 402 response includes:
```json
{
  "status": "payment_required",
  "amount": "25.00",
  "currency": "USD",
  "methods": ["stripe", "mjnx", "usdc-base"],
  "fair_manifest_preview": { ... }
}
```

After payment, the `.fair` manifest is finalized and signed by all parties.

### 4.5 UCP: Checkout as Event/Market Adapter

UCP's merchant feed and checkout flow map to Imajin's existing registry and events system:

| UCP Concept | Imajin Primitive |
|-------------|-----------------|
| Merchant feed | Registry listings with `market` type |
| Product catalog | Event tickets, market items |
| Agent checkout | Existing `/checkout` flow |
| Payment confirmation | `.fair` manifest + settlement record |
| Order tracking | Chain-replayable action log |

UCP becomes an alternative entry point to the same checkout infrastructure.

### 4.6 Visa TAP / Mastercard Agent Pay: Registration as Attestation

Visa and Mastercard require agent registration. Imajin's DID system provides the foundation:

```
Imajin agent DID → register with Visa TAP → trusted agent status
                → register with Mastercard → agentic token eligible
```

The registration is an attestation on the Imajin chain:
```json
{
  "type": "agent_registration",
  "agent_did": "did:imajin:AGENT",
  "registry": "visa_tap",
  "registration_id": "visa-...",
  "timestamp": "2026-05-14T17:30:00Z",
  "signature": "sig..."
}
```

When the agent transacts through Visa or Mastercard, the `.fair` manifest links back to the Imajin chain for full attribution.

---

### 4.7 Field-Level Mapping: Imajin Primitives ↔ KYA-OS / AP2

This is the concrete adapter contract. It is what makes "speak everything" real at the wire, and it is the artifact intended to be shareable in the DIF Trusted AI Agents WG. **We are not adopting KYA-OS or AP2 as our internal model — we already implement the substance (DID + scoped, revocable delegation + signed record). What we lack is (a) a W3C-VC/VDC serialization and (b) a public `did:imajin` resolver.** Those are an adapter, not a rebuild.

#### 4.7.1 The delegation credential (KYA-OS `has-a` model)

When an Imajin node must be verified by an outside party (edge-proxy Verifier), we emit a portable delegation credential. Field mapping:

| W3C VC / KYA-OS field | Imajin source | Notes |
|-----------------------|---------------|-------|
| `issuer` | Principal (human) `did:imajin` | The authorizing self |
| `credentialSubject.id` | Agent `did:imajin` | The acting agent (e.g. Jin) |
| `credentialSubject.allowedServices` | `identity_members.allowedServices` | Existing row-based scope, serialized |
| `credentialSubject.actions` / `excludes` | delegation constraints | Positive + negative scope |
| `expirationDate` | delegation expiry | Must be present for cross-boundary use |
| `credentialStatus` (revocation pointer) | revocation list endpoint | The gap: needs a public status endpoint |
| `type: ["VerifiableCredential", "AgentDelegation"]` | — | New serialization wrapper |
| `proof` | signature over the above | **See §4.7.3 (curve caveat)** |
| signed message `type: "agent"` | `SignedMessage.type` | Already a signed field |

This is exactly the field set **0xbrainkid** enumerated on #394 (parent human DID, agent DID, allowed service/action set, expiry/revocation pointer, `type: agent`, issuer/countersignature chain). The row model stays for first-party services; the VC is emitted only when the verifier is external.

#### 4.7.2 The AP2 mandate (from a `.fair` manifest) — issue #971

| AP2 VDC field | Imajin source | Notes |
|---------------|---------------|-------|
| Cart Mandate — *open* (constraints) | `.fair` delegation record + spending constraints | The standing authorization |
| Cart Mandate — *closed* (finalized cart) | finalized transaction items | What was actually purchased |
| Payment Mandate — *open* (budget/instruments) | settlement method policy (`fair-policy.json`) | Allowed rails: stripe / mjnx / usdc |
| Payment Mandate — *closed* (amount bound to cart) | settlement record | The receipt |
| VDC `proof` | DID keypair signature | **See §4.7.3** |
| audit trail | `.fair` manifest + signed action log | Our record is *richer*: adds attribution + distribution |

The `.fair` manifest carries everything AP2's four-VDC chain carries **plus** *what was purchased, who is attributed, and how value distributes.* AP2 proves the spend was authorized; `.fair` proves the spend was authorized **and** where the money went.

#### 4.7.3 The one real snag: signature curve (Ed25519 vs P-256)

Imajin's identity spine is **Ed25519** (the DFOS federation contract — we cannot unilaterally swap it). AP2 VDCs are specified as **ECDSA P-256 / SHA-256**. KYA-OS is curve-agnostic (any DID method / VC proof suite), so **KYA-OS interop needs no curve change** — our Ed25519 `did:imajin` + Ed25519-signed VC is conformant.

**AP2 is the only surface with a curve requirement, and it lives on the money leg only.** The resolution is the same pattern as the EternaX/PQ decision: the identity/proof spine stays Ed25519; a VDC emitted *specifically for AP2 payment interop* can carry a P-256 signature on the money leg, bridged by an Imajin attestation that binds the P-256 payment key to the Ed25519 principal DID. `.fair` = the record (Ed25519); the AP2 VDC = the wire format for one counterparty (P-256). The spine never moves.

#### 4.7.4 The missing pieces (honest gap list)

1. **Public `did:imajin` resolver** — a `did:imajin` DID method + resolver endpoint so any external Verifier resolves our DIDs "without prior coordination." Today resolution is internal. *(This is the single biggest unlock — it's what turns every mapping above from theory into something an outside proxy can actually check.)*
2. **W3C-VC serialization layer** — emit attestations/delegations as JSON-LD Verifiable Credentials (candidate `@imajin/vc` package, already floated in #394). Precedent: closed issue #562 (EUDI Wallet W3C VC + OpenID4VP layer) explored the same serialization for a different consumer.
3. **Public revocation/status endpoint** — `credentialStatus` needs to resolve for cross-boundary verifiers.
4. **P-256 money-leg signing + attestation bridge** — for AP2 only (§4.7.3).

---

## 5. Dogfooding

Imajin's own agents use the same protocol surface. When Jin (the workspace agent, `veteze_openclaw_jin`) transacts on the platform:

1. **Identity:** Jin's DID is `did:imajin:6JSKE52ySFid2x7ejUEw6VV1NyJA1idfVKpg3We9b5Nc` (dev) / `did:imajin:88kPYWwv5YFrQwAteEmSndbbHWvzePJ1zNSxpBCCNWXU` (prod)
2. **Tools:** Jin calls MCP tools exposed by the node — registry queries, media uploads, chat messages
3. **Delegation:** Jin acts on behalf of Ryan via `X-Acting-As` with a valid delegation chain (RFC-27)
4. **Settlement:** When Jin purchases event tickets or market items, it goes through the same HTTP 402 flow
5. **Attribution:** Every transaction generates a `.fair` manifest. Jin's agent DID appears in the attribution chain
6. **Audit:** Ryan can replay Jin's entire action history from the chain

The patterns are proven internally before external agents arrive. If Jin can't use it, neither can anyone else.

---

## 6. The .fair Policy as Usage Agreement

`/.well-known/fair-policy.json` is not a suggestion. It is the node's binding usage agreement:

- **Foundation: 10%** — Funds core protocol development, security, infrastructure
- **Developers: 10%** — Distributed to contributors whose code, tools, or apps enabled the transaction
- **Community: 80%** — Returns to the ecosystem: node operators, content creators, referrers, liquidity providers

The policy is machine-readable. An agent reads it before transacting. The `.fair` manifest on every transaction enforces it. The chain proves compliance. There is no sales call. There is no Terms of Service PDF. There is only the policy, the manifest, and the proof.

When a regulator asks "what percentage went to the foundation?" — the `.fair` manifest answers. When a contributor asks "did I get attributed for enabling that purchase?" — the chain answers. When a user asks "where did my money go?" — the manifest answers.

---

## 7. Implementation Phases

### Phase 1: MVP — Speak the Core Protocols

**Goal:** External agents can discover and transact with Imajin nodes using A2A, MCP, and existing 402 settlement.

- [ ] `/.well-known/agent.json` — Dynamic A2A Agent Card from node tool surface
- [ ] `/.well-known/mcp.json` — MCP tool surface exposing registry, events, media, pay APIs
- [ ] `/.well-known/fair-policy.json` — Machine-readable `.fair` terms
- [ ] MCP server implementation — JSON-RPC endpoint, tool registration, DID authentication
- [ ] A2A task endpoint — Task submission, lifecycle mapping to bus events
- [ ] Existing HTTP 402 settlement — Already built; verify `.fair` manifest attachment
- [ ] Documentation — Protocol mapping reference, example agent integrations

### Phase 2: Expand to Financial Protocols

**Goal:** Agents can pay and be paid through MPP, x402, and AP2.

- [ ] MPP wire scheme adapter — 402 response includes MPP payment options
- [ ] x402 wire scheme adapter — USDC on Base settlement via Coinbase pattern
- [ ] AP2 mandate generation — `.fair` manifest → Verifiable Credential mandate
- [ ] A2A task lifecycle → bus event mapping — Full state transition logging
- [ ] UCP checkout adapter — Merchant feed from registry, UCP entry point to existing checkout
- [ ] Cross-protocol session persistence — Agent authenticated in one protocol stays authenticated in others

### Phase 3: Full Financial Network Integration

**Goal:** Imajin agents are first-class citizens in Visa and Mastercard agent networks.

- [ ] Visa TAP agent registration — Imajin DID → Visa trusted agent registry
- [ ] Mastercard Agent Pay integration — Agent DID → agentic token eligibility
- [ ] Cross-node agent delegation via DFOS — Agent on node A delegates to agent on node B
- [ ] Full protocol conformance test suite — Automated verification that every protocol surface behaves correctly
- [ ] Protocol version negotiation — Node and agent agree on protocol versions at handshake time

---

## 8. Design Principles

### 8.1 Speak everything, own nothing

Imajin implements protocols. It doesn't invent competing ones. When A2A defines how agents discover each other, Imajin speaks A2A. When MCP defines how agents use tools, Imajin speaks MCP. When MPP defines how agents pay, Imajin speaks MPP.

The node is polyglot by design. Adding a new protocol means adding a surface adapter, not changing the core.

### 8.2 The node is the source of truth

External protocols are transport. The `.fair` manifest and DID chain are the canonical record. If A2A says the task completed but the chain says it failed — the chain wins. If MPP says payment succeeded but the `.fair` manifest wasn't generated — the payment is incomplete.

Transport can lie. The chain cannot.

### 8.3 Dogfood first

Every external protocol surface is used internally first. Jin uses the MCP tools. Jin goes through the A2A task flow. Jin's transactions generate `.fair` manifests. If the surface doesn't work for our own agents, it doesn't ship for external ones.

### 8.4 Attribution survives the wire

No matter which protocol carries the transaction, the `.fair` manifest rides alongside. MCP tool call → `.fair`. A2A task completion → `.fair`. MPP payment → `.fair`. x402 settlement → `.fair`. Visa TAP transaction → `.fair`. Mastercard Agent Pay → `.fair`.

The protocol is the envelope. The `.fair` manifest is the letter. The letter always arrives.

### 8.5 Identity is portable

One DID. Every protocol. The same `did:imajin:...` that authenticates an MCP tool call is the same DID that signs an A2A task is the same DID that registers with Visa TAP is the same DID that receives attribution in a `.fair` manifest.

No protocol-specific identities. No fragmentation. One self-sovereign identity, spoken everywhere.

---

## 9. Security Considerations

### 9.1 Protocol Impersonation

A malicious node could claim to speak A2A but implement it incorrectly, or claim to honor `.fair` terms but distribute differently. Mitigation:

- Node DID is attested in the chain. Rogue nodes can be identified and distrusted.
- `.fair` manifest is signed by the node operator. Violations are cryptographically provable.
- DFOS gossip replicates node reputation. Bad actors are ostracized.

### 9.2 Man-in-the-Middle

Agent-to-node communication must be over TLS. DID-based authentication provides an additional layer: the agent signs a challenge from the node, proving possession of the private key.

### 9.3 Delegation Abuse

An agent with a valid delegation could exceed its mandate. Mitigation:
- Spending limits enforced at settlement time, not just mandate issuance time
- `.fair` manifest includes delegation chain; node validates every link
- Revocation: owner can revoke delegation; node checks revocation list before executing

### 9.4 Protocol Version Mismatch

Protocols evolve. A node speaking A2A v1.0 and an agent speaking A2A v1.1 might miscommunicate. Mitigation:
- Version negotiation at `.well-known/` discovery time
- Graceful degradation: if versions mismatch, fall back to the common subset
- Node advertises supported protocol versions in Agent Card

---

## 10. Open Questions

1. **Router integration:** Should the Multi-Agent Coordination router (RFC-27) speak A2A natively, or translate? A native A2A router could participate in cross-platform agent networks, but adds complexity.

2. **MCP auth standard:** MCP doesn't yet have a standard authentication mechanism. Should Imajin propose DID-based auth as a standard, or wait for the MCP community to converge?

3. **Cross-protocol session sharing:** If an agent authenticates via MCP, should that session be valid for A2A tasks on the same node? Probably yes — shared DID-based session — but needs careful scope management.

4. **AP2 mandate lifecycle:** AP2 mandates can expire, be revoked, or have spending limits. How does this interact with long-running A2A tasks that span multiple payment events? *(Partially framed in §4.7.2: the Cart Mandate open/closed split maps a standing `.fair` delegation to per-cart finalizations — a long task holds one open mandate and finalizes closed mandates per payment event. The revocation-pointer gap in §4.7.4(3) is the missing piece.)*

8. **`did:imajin` DID method registration:** to be resolvable by external KYA-OS Verifiers we need a published DID method. Do we register `did:imajin` formally (W3C DID method registry) or expose resolution via the existing `.well-known` + DFOS federation surface first? (§4.7.4(1).)

9. **DIF WG posture:** RFC-32 §4.7 is drop-in-shareable in DIF's Trusted AI Agents / KYA-OS task force. Do we enter as an implementer presenting a conformant Service + portable-credential adapter, or stay heads-down until the resolver ships? (Prove-the-net-first discipline suggests: ship the resolver + VC layer against the spec, *then* present.)

5. **Visa/Mastercard sandbox:** Do we build against their sandbox environments first, or wait for production APIs? Sandbox integration is lower risk but may not reflect production behavior.

6. **Protocol conformance testing:** Should conformance tests be run in CI against live protocol endpoints, or against mock implementations? Live tests catch real drift but are flaky. Mock tests are reliable but may miss real-world quirks.

7. **Protocol popularity:** If one protocol dominates (e.g., A2A becomes the standard), do we deprecate others or maintain them all? The "speak everything" principle says maintain, but practical resource constraints may force prioritization.

---

## 11. Related Work

- **RFC-01** — `.fair` Attribution: The foundation of attribution that rides alongside every protocol
- **RFC-05** — Intent-Bearing Transactions: HTTP 402 settlement pattern
- **RFC-23** — Multi-Chain Settlement: Pluggable wire schemes (Stripe, MJNx, USDC)
- **RFC-27** — Multi-Agent Coordination: Agent identity, delegation, task routing
- **RFC-31** — Agent Execution Sandbox: Tool surface, permissions, scoped execution
- **RFC-39** — Verifiable Skills & the Invokable Agent: the verification layer pointed at the agent's own capabilities; §4.7's credential-emission discipline is the same prove-against-the-signed-record model applied to delegation
- **DFOS Specification** — Federation protocol, existing `.well-known/dfos` endpoint

### External specifications referenced (Jul 2026)

- **KYA-OS** (ex-MCP-I) — DIF Trusted AI Agents Working Group. Four KYA questions, four-actor model (Principal / Agent / Service / Verifier), DID + VC delegation, curve-agnostic. Donated by Vouched.
- **AP2** (Agent Payments Protocol, `ap2-protocol.org`) — open extension of A2A + UCP. Cart + Payment Mandates as VDCs, each Open/Closed. ECDSA P-256 / SHA-256. Native x402 support.
- **W3C Verifiable Credentials / DIDs** — the underlying serialization both of the above build on, and our target wire format (§4.7.4(2)).

---

*"You don't build a bridge by telling rivers to flow together. You build a bridge so everything can cross."*

*"Imajin doesn't choose protocols. Imajin makes every protocol accountable."*
