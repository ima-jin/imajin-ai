# MJN Protocol
## A Cryptographic Operating System for Sovereign Commerce
### v0.5 · May 2026

*Ryan Veteze · ryan@imajin.ai · [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)*

**Building on MJN?** → [Developer Guide](./developer-guide)
**Machine-readable spec** → [llms-full.txt](https://imajin.ai/llms-full.txt)

---

## Overview

MJN is a cryptographic operating system. One kernel, a federated userspace, and four
infrastructure layers that make every action verifiable and every relationship bilateral.

Without the chains, each service is a dumb CRUD app. With the chains, they form a sovereign
operating system where identity, attribution, trust, and settlement are structural properties —
not features bolted on after the fact.

The **kernel** consolidates auth, payments, messaging, media, trust graph, and registry into
one application. One domain, one cookie, one build. Userspace apps are independent, replaceable,
and disposable — they inherit the full trust graph by importing `@imajin/auth`. The value is
never in the app layer. It's in the substrate underneath.

No service mesh. No orchestration framework. No API gateway. No Kubernetes. No Docker.
Just Next.js apps behind Caddy on a single server with pm2.

**Identity substrate:** [DFOS](https://protocol.dfos.com) by Brandon/Metalabel. Every
`did:imajin` is anchored to a DFOS proof chain. The chain is canonical; `did:imajin` is a
stable alias. MJN is Layer 6 — settlement, trust graph, attribution — on a cryptographic
substrate.

**Reference implementation:** 1 kernel + 6 federated apps at `jin.imajin.ai`. ~150
registered identities. First demonstration: April 1, 2026.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Userspace (disposable, replaceable)                        │
│  events · market · learn · coffee · links · dykil           │
├─────────────────────────────────────────────────────────────┤
│  Kernel                                                     │
│  auth · pay · chat · media · profile · connections · registry│
├─────────────────────────────────────────────────────────────┤
│  Bus — reactor chains (side effects are composable)         │
│  Vault — encrypted store (data encrypted at rest, always)   │
│  Broker — consent gate (data released only with permission) │
├─────────────────────────────────────────────────────────────┤
│  Cryptographic Substrate                                    │
│  Ed25519 · CID · dag-cbor · DFOS chains · .fair manifests   │
└─────────────────────────────────────────────────────────────┘
```

The **kernel** is auth + pay + chat + media + profile + connections + registry. One cookie,
one session, no CORS between services. We started with 15 separate services. CORS, cookie
forwarding, and deploy coordination made it worse than a monolith without any of the benefits.
Consolidation was the honest move.

The **bus** (`@imajin/bus`) moves events through reactor chains. Services publish events;
reactors handle side effects (attestation, token emission, settlement, notification). The
bus is why adding new behaviour is composable — you configure a reactor chain, not write
imperative webhook handlers.

The **vault** encrypts data at rest with recipient-bound encryption. Same crypto primitive
as selective disclosure — encrypt to a recipient's public key, decrypt only with their
private key. CID-addressed for integrity verification without decryption.

The **broker** mediates access to encrypted data based on consent grants. Field-level
selective disclosure with purpose-binding and audit trail. Specced (#786, #1003), building
on production bus + vault infrastructure.

**Userspace** services are disposable. Any service can be replaced without affecting others.
New services inherit the full trust graph and identity system by importing `@imajin/auth`.
The complexity lives in the chain layer, not the orchestration layer.

---

## Identity

### DIDs

Format: `did:imajin:xxx` — generated from an Ed25519 public key. Stable from creation.
Never changes. The same keypair produces both `did:imajin:xxx` and `did:dfos:xxx` —
byte-compatible, same curve, no derivation. Your DID is also a valid Solana wallet address.

DIDs are minted lazily — on first use, not through batch registration. A traveler books
a trip, a DID is created. A restaurant is referenced, a DID is minted. The entity can
later claim/upgrade their identity, or never. The audit trail is valid either way.

DFOS relay: `jin.imajin.ai/registry/relay/`

### Five Standing Tiers

Standing is computed from attestation history — not assigned by an administrator.

| Tier | Entry | Capabilities |
|------|-------|-------------|
| **Soft** | Email verification | Tickets, courses, read-only |
| **Preliminary** | Ed25519 keypair + invite | Create events, full trust graph |
| **Established** | Earned through history | Vouch, invite, issue attestations |
| **Steward** | Community trust | Elevated governance rights |
| **Operator** | Platform operator | Full access |

Tiers upgrade seamlessly. All history carries over. You start with nothing and earn
standing through real actions — not KYC gates, not admin grants.

### Four Identity Scopes

| Scope | Description | Governance |
|-------|-------------|------------|
| **Actor** | One DID, one keypair. Humans, agents, devices. | Individual sovereignty |
| **Family** | Shared trust, delegated authority. | Mutual attestation |
| **Community** | Shared practice, contribution-weighted. | Quorum governance |
| **Business** | Roles, delegation chains. | Role hierarchy |

Governance is structural — it's the scope type, the role hierarchy, the reactor chains.
You can't separate "the governance question" from "the identity question" because they're
the same thing. The scope defines the governance. The membership enforces delegation. The
bus executes policy. The attestations provide accountability.

All subtypes — `human`, `agent`, `device`, `presence`, `org`, `service` — share the same
keypair structure and trust graph. Agents are first-class identities, not API keys. The
system doesn't care if you're carbon or silicon — it cares if you can sign.

### DFOS Chain Properties

- **Self-certifying** — identity verifiable without Imajin's server
- **Key rotation** — signed handoff via chain update
- **Multifactor key roles** — auth / assert / controller keys with independent compromise boundaries
- **Bilateral attestations** — both parties sign the onboarding root record via DFOS countersignatures

---

## The Five Primitives

Everything in MJN reduces to five primitives. They compose. Each is independently useful.
Together they form the operating system.

### 1. Attestation

Every trust-relevant act emits a cryptographically signed record. Unsigned attestations
are rejected at write — a 4xx, not a null signature. If you can't sign it, it didn't happen.

On onboarding, both node and Actor sign a bilateral root record. Every subsequent attestation
references this root. DFOS countersignatures anchor it to chain.

**Live attestation types:**

| Type | Emitted By | Records |
|------|-----------|---------|
| `transaction.settled` | pay | Payment with verified .fair chain |
| `customer` | pay | First transaction with a service |
| `connection.invited` | connections | Invite extended |
| `connection.accepted` | connections | Invite accepted |
| `vouch` | connections | Inviter sponsors acceptee |
| `session.created` | auth | Login with auth method metadata |
| `identity.created` | auth | New DID registered |
| `ticket.purchased` | events | Event ticket purchased |
| `listing.purchased` | market | Market listing purchased |
| `app.authorized` | auth | User authorized a federated app |
| `document.signed` | auth | Multi-party document signature |
| `document.executed` | auth | All parties signed |

**Standing** is computed from attestation history: positive/negative attestations weighted
by type, issuer standing, and time decay. Two modes: community standing (local) and
cross-node standing (portable).

### 2. Communication

DID-based messaging. Every conversation is itself a DID:

- `did:imajin:dm:<hash>` — direct message (deterministic from participants)
- `did:imajin:group:<hash>` — group channel (deterministic from members)
- `did:imajin:event:<id>` — event conversation

Messages signed by sender DID. Real-time via WebSocket. E2EE via X25519 key agreement +
XChaCha20-Poly1305.

Communication rules follow identity scope: Actors get private channels. Families get shared
interior channels. Communities are tiered by membership. Businesses can't initiate outreach —
all commercial messaging is consent-gated and gas-priced.

### 3. Attribution (.fair)

Every asset carries a `.fair` manifest: who contributed, in what proportion, under what terms.
The manifest travels WITH the content. Not stored separately. Not in a different system. When
money moves, the manifest says where it goes.

Fee cascade — deducted in order, seller gets the remainder:
1. **Protocol fee**: 1.0% (fixed — this is how the network sustains itself)
2. **Node fee**: 0.5% default, operator-configurable [0.25%, 2.0%]
3. **Buyer credit**: 0.25% default — the buyer earns MJN for transacting
4. **Scope fee**: optional — only when a community/business takes a cut
5. **Seller share**: everything else

Default total overhead: 2%. The seller gets 98%. Compare to Stripe's 2.9% + $0.30 where
the platform keeps everything. Here, the 2% is split across four stakeholders who all
contributed to the transaction happening.

Settlement won't process without a valid, signed manifest. With DFOS chain backing, creator
proof is portable and verifiable independent of the originating server.

`.fair` is a standalone JSON format. You can use it without MJN. MJN uses it for all attribution.

### 4. Settlement

Every transaction verifies `.fair` signatures before processing. The bus `settle` reactor
reads the manifest, resolves placeholder DIDs, deducts processing fees, splits the payment,
and emits a `transaction.settled` attestation. No human intervention. No invoice. No accounts
receivable.

**Live:** Stripe (Connect for multi-seller payouts). Interac e-Transfer for CAD on-ramp.

**MJNx ledger:** Internal credit token. 1 MJN = $0.01 (1¢). 100 MJN = 1 MJNx. The protocol
doesn't require the token. The token requires the protocol. MJNx is to Imajin as USD is to
SWIFT — an accounting unit for the node's internal ledger, not a speculative asset.

**Planned settlement schemes:** MJNx-direct, Solana Pay, Lightning, x402.

**Gas model for declared-intent marketplace:**

| Tier | Reach | Cost |
|------|-------|------|
| Tier 1 | Trust graph connections | Free / near-free |
| Tier 2 | Declared interest pool | Medium gas |
| Tier 3 | Extended reach, opted-in | High gas |

Frequency-scaled depth gating prevents spam: costs escalate with repetition
(1× → 1.5× → 3× → 7× → 15× → 40×). Matching is local — user's interests never leave
their node. k-anonymity enforced.

### 5. Discovery

Federated registry at `jin.imajin.ai/registry`. Nodes announce presence, operators, and
served scopes. Node DIDs are chain-verified on registration.

**Selective disclosure:** The broker layer mediates access to personal data with consent
grants. A traveler shares dietary preferences with a restaurant but not their budget.
A sizing service gets measurements but not identity. Each field, each purpose, each release
mode is explicit. Every release is audited. Shadow mode validates the model without gating
the user experience; enforcement mode makes it binding.

**Exit credentials:** On departure, Actors receive a signed portable credential — public
summary (aggregate stats) and encrypted context (full attestation history under departing
Actor's key). Integrity is provable because signing started at onboarding, not at departure.

---

## Infrastructure Layers

### Event Bus (`@imajin/bus`)

Side effects are the hard part. "After payment succeeds, create an attestation, credit MJN,
settle the .fair manifest, and notify the seller." Without the bus, that's a fragile
imperative sequence in a webhook handler. With the bus, it's a composable reactor chain.

```
bus.publish('listing.purchased', { issuer, subject, scope, payload })
→ attestation reactor (sign + store)
→ mjn reactor (emit tokens)
→ settle reactor (resolve .fair, split payment) [blocking]
→ notify reactor (send notifications)
```

Built-in reactors: `attestation`, `mjn`, `settle`, `notify`, `emit`, `webhook`.
Custom reactors via `registerReactor()`.

Chain configuration: hardcoded defaults (Phase 1, live) → DB-backed (Phase 2, specced) →
scope-level overrides (Phase 3) → admin UI (Phase 4, "IFTTT for events"). Each phase earned
by actual demand, not speculative architecture.

### Vault

Encrypted key-value store. Encrypt a secret to the node's public key from anywhere (phone,
laptop, agent), store as a CID-addressed blob, decrypt only on the node. No plaintext at
rest. No SSH required.

Crypto: Ed25519 → X25519 key derivation, XSalsa20-Poly1305 authenticated encryption, CID
addressing. Same primitives as Signal and age. No novel cryptography.

Same primitive as selective disclosure — both are "signed, scoped, encrypted data with
controlled release."

### Federated App Authentication

Userspace apps authenticate via `requireAppAuth()` using attestation-based consent. A user
authorizes an app (creates an `app.authorized` attestation with approved scopes). The app
presents this attestation on each request. The kernel validates it. No OAuth. No token
exchange. Just a signed attestation that says "this user authorized this app for these scopes."

---

## Cryptographic Stack

| Primitive | Purpose |
|-----------|---------|
| Ed25519 | DID keypairs, attestation signing, .fair signing, sessions |
| SHA-256 | Content hashing, DID derivation |
| X25519 | Key agreement for E2EE chat and vault encryption |
| XChaCha20-Poly1305 | Chat message encryption |
| XSalsa20-Poly1305 | Vault encryption (NaCl box) |
| dag-cbor + CID | DFOS content addressing, attestation CIDs |
| JWS | DFOS signature format |
| JWT | Session cookies (HS256) |

All persistence: Postgres. Per-service schemas in a shared database. Drizzle ORM.

---

## The Sovereignty Property

Imajin rejects:

- **Subscriptions** — you own it forever
- **Cloud dependency** — self-hosted on owned hardware
- **Vendor lock-in** — open source, every service replaceable
- **Surveillance capitalism** — your data stays on your node
- **Orchestration theater** — no Kubernetes, no service mesh

A node doesn't need the registry to exist — only to be discoverable. If the registry
disappears, you keep your keypair, your chain proofs, your attestation history. The exit
door is always open.

Federation is the honest architecture: central registry now (ships fast), on-chain registry
next (Solana), mesh trust eventually (no central authority).

---

## What's Live

| Status | Item |
|--------|------|
| ✅ | Kernel + 6 federated userspace apps |
| ✅ | Five-tier DID identity with lazy minting |
| ✅ | DFOS chain-backed identity across all services |
| ✅ | DFOS relay (106/106 conformance, four-node mesh) |
| ✅ | Bilateral attestations via countersignatures |
| ✅ | 25+ attestation types with Ed25519 signing |
| ✅ | Event bus with reactor chains |
| ✅ | .fair settlement via bus reactor |
| ✅ | Stripe Connect multi-seller payouts |
| ✅ | MJNx internal credit ledger |
| ✅ | Trust graph (pods, invites, groups, vouches) |
| ✅ | DID-based real-time chat with E2EE |
| ✅ | Vault — encrypted config with CID addressing |
| ✅ | Agent DIDs with scoped delegation |
| ✅ | Federated app authentication (requireAppAuth) |
| ✅ | Multi-party document signing |
| ✅ | Federation registry |
| ✅ | MJN token reserved on Solana |
| ⏳ | Selective disclosure / data broker |
| ⏳ | Standing computation |
| ⏳ | Portable exit credentials |
| ⏳ | MJN token settlement (dual-currency) |
| ⏳ | Declared-intent marketplace |
| ⏳ | Node registration via DFOS relay |

---

## Build Stats

| Metric | Value |
|--------|-------|
| Architecture | 1 kernel + 6 federated apps |
| Shared packages | 20 |
| Lines of code | ~134,000 |
| Commits | 2,467 |
| Identities | ~150 |
| Days | 110 |
| Team | 1 human + AI agents |
| Traditional estimate | $2.3M / 14.4 months / 9.2 people |
| Actual cost | ~$108K / 110 days / 1 person |

---

*[Developer Guide](./developer-guide.md) · [llms-full.txt](https://imajin.ai/llms-full.txt) · [.fair spec](https://github.com/ima-jin/.fair) · [DFOS](https://protocol.dfos.com) · [Source](https://github.com/ima-jin/imajin-ai)*

*First demonstration: April 1, 2026.*
