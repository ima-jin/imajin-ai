# MJN Protocol
## A Cryptographic Operating System for Sovereign Commerce
### v0.4 · March 2026 · DRAFT

*Ryan Veteze · ryan@imajin.ai · [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)*

**Building on MJN?** → [Developer Guide](./developer-guide)
**Machine-readable spec** → [llms-full.txt](https://imajin.ai/llms-full.txt)

---

## Overview

MJN is a cryptographic operating system that runs as Just a Bunch Of Services — **JBOS**.

15 independent HTTP services, each doing one thing, each with its own database schema, each independently deployable. No service mesh. No orchestration framework. No API gateway. Just applications behind a reverse proxy.

The services are commodity — swap them, rewrite them, add more. The value is in the cryptographic substrate underneath: signed identity chains that make every action verifiable and every relationship bilateral.

Without the chains, each service is a dumb CRUD app. With the chains, they form a sovereign operating system where identity, attribution, trust, and settlement are structural properties — not features bolted on after the fact.

**Identity substrate:** [DFOS](https://protocol.dfos.com) by Brandon/Metalabel. Every `did:imajin` is anchored to a DFOS proof chain. The chain is canonical; `did:imajin` is a stable alias. MJN is Layer 6 — settlement, trust graph, attribution — on a cryptographic substrate.

**Reference implementation:** 15 services at `*.imajin.ai`. ~120 registered identities. First demonstration: April 1, 2026.

---

## Architecture

```
                    JBOS (Just a Bunch Of Services)
┌──────────────────────────────────────────────────────────┐
│  www · events · chat · learn · market · coffee · links   │  ← Userspace
│  dykil · input · media                                   │     (disposable)
├──────────────────────────────────────────────────────────┤
│  connections · profile · registry                        │  ← Trust + Discovery
├──────────────────────────────────────────────────────────┤
│  auth · pay                                              │  ← Kernel
│  attestations · .fair manifests · settlement             │     (signed chains)
├──────────────────────────────────────────────────────────┤
│  DFOS Proof Chains (L0–L5)                               │  ← Substrate
│  Ed25519 · CID · dag-cbor · countersignatures            │     (cryptographic)
└──────────────────────────────────────────────────────────┘
```

The **kernel** is auth + pay + the attestation/settlement layer. Services above the kernel can't do anything meaningful without it. The kernel doesn't care which services exist above it.

**Userspace** services are disposable. Any service can be replaced without affecting others. New services inherit the full trust graph and identity system by importing `@imajin/auth`. The complexity lives in the chain layer, not the orchestration layer.

**Why JBOS:**
- No inter-service trust assumptions — services verify chains, not each other
- Runs on a single server with pm2 — no Kubernetes, no Docker in production
- New services get identity, trust, and settlement for free
- The reference implementation cost $76K to build; industry estimate for equivalent: $2.3M

---

## Identity

### DIDs

Format: `did:imajin:xxx` — generated from an Ed25519 public key. Stable from creation. Never changes.

The same keypair produces both `did:imajin:xxx` and `did:dfos:xxx` — byte-compatible, same curve, no derivation. Your DID is also a valid Solana wallet address.

DFOS relay: `registry.imajin.ai/relay/`

### Three Standing Tiers

Standing is computed from attestation history — not assigned by an administrator.

| Tier | Entry | Capabilities |
|------|-------|-------------|
| **Soft** | Email verification | Tickets, courses, chat, read-only |
| **Preliminary** | Ed25519 keypair + invite | Create events, full trust graph access |
| **Established** | Earned through history | Vouch for others, issue attestations, invite |

Tiers upgrade seamlessly. All history carries over.

### Four Identity Scopes

| Scope | Description | Entry |
|-------|-------------|-------|
| **Actor** | One DID, one keypair. Humans, agents, devices. | Keypair generation |
| **Family** | Shared trust, delegated authority. | Mutual attestation |
| **Community** | Shared practice, quorum-governed. | Quorum + participation |
| **Business** | Roles, delegation chains. | Declaration + covenant |

All subtypes — `HumanActor`, `AgentActor`, `DeviceActor` — share the same keypair structure and trust graph. Every interaction is typed so you always know what you're talking to.

### DFOS Chain Properties

- **Self-certifying** — identity verifiable without Imajin's server
- **Key rotation** — signed handoff via chain update
- **Multifactor key roles** — auth / assert / controller keys with independent compromise boundaries
- **Bilateral attestations** — both parties sign the onboarding root record via DFOS countersignatures

---

## The Five Primitives

Everything in MJN reduces to five primitives. They compose. Each is independently useful. Together they form the operating system.

### 1. Attestation

Every trust-relevant act emits a cryptographically signed record. Unsigned attestations are rejected at write.

On onboarding, both node and Actor sign a bilateral root record. Every subsequent attestation references this root. DFOS countersignatures anchor it to chain.

**Live attestation types:**

| Type | Emitted By | Records |
|------|-----------|---------|
| `transaction.settled` | pay | Payment with verified .fair chain |
| `customer` | pay | First transaction with a service |
| `connection.invited` | connections | Invite extended |
| `connection.accepted` | connections | Invite accepted |
| `vouch` | connections | Inviter sponsors acceptee |
| `session.created` | auth | Login with auth method metadata |

**Standing** is computed from attestation history: positive/negative attestations weighted by type, issuer standing, and time decay. Two modes: community standing (local) and cross-node standing (portable).

### 2. Communication

DID-based messaging. Every conversation is itself a DID:

- `did:imajin:dm:<hash>` — direct message (deterministic)
- `did:imajin:group:<uuid>` — group channel (random)
- `did:imajin:event:<id>` — event conversation

Messages signed by sender DID. Auth service is the single access control authority. Real-time via WebSocket.

Communication rules follow identity scope: Actors get private channels. Families get shared interior channels. Communities are tiered by membership. Businesses can't initiate outreach — all commercial messaging is consent-gated and gas-priced.

### 3. Attribution (.fair)

Every asset carries a `.fair` manifest: who contributed, in what proportion, under what terms.

```json
{
  "id": "asset-123",
  "version": "0.3.0",
  "type": "track",
  "contributors": [
    { "id": "did:imajin:5Qn8...", "role": "artist", "weight": 0.6 },
    { "id": "did:imajin:8Xk2...", "role": "producer", "weight": 0.4 }
  ],
  "terms": { "train": { "consent": "explicit", "price": 0.50 } },
  "signature": "...",
  "platformSignature": "..."
}
```

`.fair` is a kernel primitive in the JBOS model. Settlement won't process without a valid, signed manifest. With DFOS chain backing, creator proof is portable and verifiable independent of the originating server.

Manifests travel with the content. You can use `.fair` without MJN — it's a standalone JSON format. MJN uses `.fair` for all attribution.

### 4. Settlement

Every transaction verifies `.fair` signatures before processing. Splits follow the manifest. Completion emits a `transaction.settled` attestation.

**Current:** Stripe (Connect for multi-seller payouts, EMT for bank transfer).

**Planned:** MJN token on Solana. Dual-currency — fiat or MJN. Atomic `.fair` splits in one transaction.

**Gas model for declared-intent marketplace:**

| Tier | Reach | Cost |
|------|-------|------|
| Tier 1 | Trust graph connections | Free / near-free |
| Tier 2 | Declared interest pool | Medium gas |
| Tier 3 | Extended reach, opted-in | High gas |

Frequency-scaled depth gating prevents spam: costs escalate with repetition (1× → 1.5× → 3× → 7× → 15× → 40×). Matching is local — user's interests never leave their node. k-anonymity enforced.

### 5. Discovery

Federated registry at `registry.imajin.ai`. Nodes announce presence, operators, and served scopes. Node DIDs are chain-verified on registration.

**Exit credentials:** On departure, Actors receive a signed portable credential — public summary (aggregate stats) and encrypted context (full attestation history under departing Actor's key). Integrity is provable because signing started at onboarding, not at departure.

---

## Services

15 services. All Next.js. All Postgres. All behind Caddy. All managed by pm2.

| Service | URL | Role |
|---------|-----|------|
| auth | auth.imajin.ai | Kernel — DIDs, sessions, attestations, DFOS bridge |
| pay | pay.imajin.ai | Kernel — Stripe, settlement, .fair verification |
| connections | connections.imajin.ai | Trust — pods, invites, groups, vouches |
| profile | profile.imajin.ai | Discovery — public profiles, handles |
| registry | registry.imajin.ai | Federation — node discovery, DFOS relay |
| events | events.imajin.ai | Userspace — events, tickets, .fair splits |
| chat | chat.imajin.ai | Userspace — DID messaging, WebSocket |
| media | media.imajin.ai | Userspace — assets, .fair sidecars |
| input | input.imajin.ai | Userspace — voice (Whisper), uploads |
| learn | learn.imajin.ai | Userspace — courses, enrollment |
| market | market.imajin.ai | Userspace — local commerce |
| coffee | coffee.imajin.ai | Userspace — tipping pages |
| links | links.imajin.ai | Userspace — link-in-bio |
| dykil | dykil.imajin.ai | Userspace — spending surveys |
| www | imajin.ai | Userspace — landing, app launcher |

Every service exposes OpenAPI at `/api/spec`.

Shared packages: `@imajin/auth` · `@imajin/db` · `@imajin/fair` · `@imajin/chat` · `@imajin/ui` · `@imajin/config` · `@imajin/llm` · `@imajin/media`

---

## Cryptographic Stack

| Primitive | Purpose |
|-----------|---------|
| Ed25519 | DID keypairs, attestation signing, .fair signing, sessions |
| SHA-256 | Content hashing, DID derivation |
| dag-cbor + CID | DFOS content addressing |
| JWS | DFOS signature format |
| DFOS chain | Identity anchoring, key rotation, countersignatures |

All persistence: Postgres. Per-service schemas in a shared database.

---

## The Sovereignty Property

Imajin rejects:

- **Subscriptions** — you own it forever
- **Cloud dependency** — self-hosted on owned hardware
- **Vendor lock-in** — open source, every service replaceable
- **Surveillance capitalism** — your data stays on your node
- **Orchestration theater** — no Kubernetes, no service mesh, JBOS

A node doesn't need the registry to exist — only to be discoverable. If the registry disappears, you keep your keypair, your chain proofs, your attestation history. The exit door is always open.

Federation is the honest architecture: central registry now (ships fast), on-chain registry next (Solana), mesh trust eventually (no central authority).

---

## What's Live

| Status | Item |
|--------|------|
| ✅ | 15-service JBOS on single server |
| ✅ | Three-tier DID identity |
| ✅ | DFOS chain-backed identity across all services |
| ✅ | DFOS relay at registry.imajin.ai/relay/ |
| ✅ | Bilateral attestations via countersignatures |
| ✅ | 6 attestation types with Ed25519 signing |
| ✅ | .fair signing at settlement |
| ✅ | Stripe Connect multi-seller payouts |
| ✅ | Trust graph (pods, invites, groups, vouches) |
| ✅ | DID-based real-time chat |
| ✅ | Federation registry |
| ✅ | MJN token reserved on Solana |
| ✅ | Auth test suite (43 tests) |
| ⏳ | Standing computation |
| ⏳ | Portable exit credentials |
| ⏳ | MJN token settlement (dual-currency) |
| ⏳ | Declared-intent marketplace |
| ⏳ | Family / Community / Business scopes |
| ⏳ | Encrypted chat (key epoch model) |
| ⏳ | Node registration via DFOS relay |

---

## Build Stats

| Metric | Value |
|--------|-------|
| Services | 15 |
| Lines of code | 122,721 |
| Identities | ~120 |
| Issues closed | 235 |
| Days | 50 |
| Team | 1 human + AI |
| Traditional estimate | $2.3M / 14.4 months / 9.2 people |
| Actual cost | $76,445 / 50 days / 1 person |

---

*[Developer Guide](./developer-guide.md) · [llms-full.txt](https://imajin.ai/llms-full.txt) · [.fair spec](https://github.com/ima-jin/.fair) · [DFOS](https://protocol.dfos.com) · [Source](https://github.com/ima-jin/imajin-ai)*

*First demonstration: April 1, 2026.*
