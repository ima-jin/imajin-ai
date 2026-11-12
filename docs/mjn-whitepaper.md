# MJN Protocol
## A Cryptographic Operating System for Sovereign Commerce

*Ryan Veteze · ryan@imajin.ai · [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)*

**Building on MJN?** → [Developer Guide](https://github.com/ima-jin/imajin-ai/blob/main/docs/developer-guide.md)
**Machine-readable spec** → [llms-full.txt](https://jin.imajin.ai/llms-full.txt)

---

## Overview

MJN is a cryptographic operating system: a kernel, independently owned apps, and
infrastructure for signed records, consent, attribution, and settlement. User-signed,
platform-signed, and logged-only actions have different proof strength; soft identities
cannot countersign. See the [proof model](https://github.com/ima-jin/imajin-ai/blob/main/docs/guide/proof-model.md).

Without the chains, each service is a dumb CRUD app. With the chains, they form a sovereign
operating system where identity, attribution, trust, and settlement are structural properties —
not features bolted on after the fact.

The **kernel** consolidates identity and service rails into one application. Apps built on
Imajin are independently owned services under a registered-app contract, not kernel modules.
They compose through scoped tokens, published `@ima-jin/*` SDKs, and public APIs — not
kernel-internal workspace imports. Cookie scope is configurable; token-based app access
does not require sharing the kernel session cookie.

The reference deployment uses Next.js, Caddy, and pm2. It is not a universal single-server
topology: the [recorded deployment configuration](https://github.com/ima-jin/imajin-ai/blob/main/deploy/ecosystem.prod.config.js)
places production corpus outside the kernel host. Configuration is not live-host evidence.

**Identity substrate:** [DFOS](https://protocol.dfos.com) by Brandon/Metalabel provides
chain proofs for linked identities. DFOS linking during key-based registration is optional
and nonfatal; not every `did:imajin` has a DFOS chain. A chain proves its signed contents,
not every activity associated with the identity.

**Reference implementation:** the kernel at `jin.imajin.ai`, with independently owned apps
and internal services. Repository inventory and generated build metrics live in the
[README](https://github.com/ima-jin/imajin-ai/blob/main/README.md); they are not a deployment inventory.

---

## Architecture

The userspace row below is a conceptual layer, not a monorepo file inventory.
Events, market, learn, coffee, links and dykil are independently owned apps.
They compose through scoped tokens, published `@ima-jin/*` SDKs and public kernel
APIs, not kernel-internal workspace imports. Pruning a source copy is not proof
of production acceptance. See [the registration contract](REGISTRATION.md).

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Userspace (disposable, replaceable)                                       │
│  events · market · learn · coffee · links · dykil                         │
│  Internal services: broker-agent · corpus (not public vertical apps)       │
├────────────────────────────────────────────────────────────────────────────┤
│  Kernel                                                                    │
│  auth · pay · chat · media · profile · connections · registry              │
│  MCP / OAuth · calendar · usage · inference · connector APIs               │
├────────────────────────────────────────────────────────────────────────────┤
│  Bus — reactor chains (side effects are composable)                        │
│  Vault — encrypted store (data encrypted at rest, always)                  │
│  Broker — consent gate (data released only with permission)                │
├────────────────────────────────────────────────────────────────────────────┤
│  Cryptographic Substrate                                                   │
│  Ed25519 · CID · dag-cbor · optional DFOS chains · .fair manifests         │
└────────────────────────────────────────────────────────────────────────────┘
```

The **kernel** supplies the six primitives plus the rails serving them. The diagram names
capability families, not a fixed service count. Consolidation removes internal cross-origin
boundaries; external apps still have explicit authentication and API boundaries.

The **bus** (`@imajin/bus`) moves events through reactor chains. Services publish events;
reactors handle side effects (attestation, token emission, settlement, notification). The
bus is why adding new behaviour is composable — you configure a reactor chain, not write
imperative webhook handlers.

The **vault** seals data with AES-256-GCM and uses CID addressing for integrity.
It supports v1 node-sealed entries and v2 delegation-grant field keys. Tier 0 self-grants
remain node-controlled; an external owner agent is an optional Tier 1 configuration,
not a universal recipient-only or zero-custody guarantee.

The **broker** mediates access to encrypted data based on consent grants. Field-level
selective disclosure with purpose-binding and audit trail is implemented through HTTP
request/consent/audit surfaces and a bus pipeline. Preview skips release and audit;
shadow runs the pipeline with advisory decisions; enforce makes the decision binding.
Implementation does not establish production-wide adoption or completeness.

**Userspace** services are disposable. Any service can be replaced without affecting others.
New services integrate through the [registered-app contract](https://github.com/ima-jin/imajin-ai/blob/main/docs/REGISTRATION.md).
The complexity lives in the chain layer, not the orchestration layer.

---

## Identity

### DIDs

Key-based registration uses `did:imajin:<base58(public-key bytes)>`. Email-backed soft
identities and claimable stubs also exist; not all identities hold an actor keypair.
DFOS DIDs and proofs are linked separately. A DID is not itself a Solana wallet address.

DIDs are minted lazily — on first use, not through batch registration. A traveler books
a trip, a DID is created. A restaurant is referenced, a DID is minted. The entity can
later claim/upgrade their identity, or never. The audit trail is valid either way.

DFOS relay: `jin.imajin.ai/registry/relay/`

### Five Standing Tiers

The shared model names five tiers; this is not evidence of a generalized reputation score.
Current eligibility checks use connections, attendance, and handle age. Steward/operator
roles are not a claim of automatically earned or portable governance authority.

| Tier | Entry | Capabilities |
|------|-------|-------------|
| **Soft** | Email-backed identity; verification is a separate step | Low-assurance participation; cannot send chat messages |
| **Preliminary** | Key-based registration or eligibility upgrade | Basic verified-tier access, subject to route policy |
| **Established** | Connection, attendance, and handle-age eligibility | Established-tier access, subject to route policy |
| **Steward** | Trusted community role | Steward-gated capabilities |
| **Operator** | Operator role | Operator-gated capabilities |

These [tier definitions](https://github.com/ima-jin/imajin-ai/blob/main/packages/auth/src/tiers.ts) and
[eligibility checks](https://github.com/ima-jin/imajin-ai/blob/main/apps/kernel/src/lib/kernel/verification.ts) describe the current
implementation. Weighted, decaying, cross-node standing remains planned.

### Four Identity Scopes

| Scope | Description | Governance |
|-------|-------------|------------|
| **Actor** | Humans, agents, devices; soft and key-based identities. | Individual sovereignty |
| **Family** | Shared trust, delegated authority. | Mutual attestation |
| **Community** | Shared practice, contribution-weighted. | Quorum governance |
| **Business** | Roles, delegation chains. | Role hierarchy |

Governance is structural — it's the scope type, the role hierarchy, the reactor chains.
You can't separate "the governance question" from "the identity question" because they're
the same thing. The scope defines the governance. The membership enforces delegation. The
bus executes policy. The attestations provide accountability.

Subtypes include `human`, `agent`, `device`, `presence`, `org`, and `service`.
Agents can hold first-class identities and scoped delegation. Proof strength depends on
the actual signer; soft identity records do not acquire actor signatures by having a DID.

### DFOS Chain Properties (for linked chains)

- **Self-certifying** — identity verifiable without Imajin's server
- **Key rotation** — signed handoff via chain update
- **Multifactor key roles** — auth / assert / controller keys with independent compromise boundaries
- **Countersignatures** — available for bilateral claims when both parties actually sign;
  not a universal onboarding root or a property of mechanical system records

---

## The Six Primitives

Everything in MJN reduces to six primitives. They compose. Each is independently useful.
Together they form the operating system.

### 1. Attestation

Attestations bind a signer to a recorded claim. User-authored signatures, node assertions,
and unilateral mechanical records must not be conflated. Soft participation has no actor
countersignature; there is no universal bilateral onboarding root for all subsequent records.

**Attestation vocabulary:** [shared type declarations](https://github.com/ima-jin/imajin-ai/blob/main/packages/auth/src/types/attestation.ts),
including usage, recovery, app registry, payment requests, and vault lifecycle records.
Declarations are a shared vocabulary, not a count of types observed emitting in production.

**Standing:** current eligibility checks are narrower than the planned weighted,
time-decaying local and portable reputation model.

### 2. Communication

DID-based messaging. Every conversation is itself a DID:

- `did:imajin:dm:<hash>` — direct message (deterministic from participants)
- `did:imajin:group:<hash>` — group channel (deterministic from members)
- `did:imajin:event:<id>` — event conversation

Real-time delivery uses WebSocket on the kernel HTTP server. Message signing is best-effort
with the platform key for chain-verified identities, not a mandatory sender-DID signature.
Chat uses TLS in transit, with plaintext at rest on the hosting node in
`chat.messages_v2.content`. Push notifications carry the first 200 characters of the
message preview. End-to-end encryption (MLS with mandatory hybrid post-quantum encryption)
is planned, not implemented.
There is no forward-secrecy or post-compromise-security guarantee;
see [SECURITY.md](https://github.com/ima-jin/imajin-ai/blob/main/SECURITY.md).

The intended communication grammar follows identity scope: Actors get private channels. Families get shared
interior channels. Communities are tiered by membership. Businesses can't initiate outreach —
all commercial messaging is consent-gated and gas-priced.

This scope/gas grammar is design intent, not a claim that every messaging policy or gas
mechanism is implemented.

### 3. Attribution (.fair)

Every asset carries a `.fair` manifest: who contributed, in what proportion, under what terms.
The manifest travels WITH the content. Not stored separately. Not in a different system. When
money moves, the manifest says where it goes.

The economic proposal allocates fees among protocol, node, buyer and optional
scope, with the seller receiving the remainder:
1. **Protocol fee**: 1.0% (fixed — this is how the network sustains itself)
2. **Node fee**: 0.5% default, operator-configurable [0.25%, 2.0%]
3. **Buyer credit**: 0.25% default — the buyer earns MJN for transacting
4. **Scope fee**: optional — only when a community/business takes a cut
5. **Seller share**: everything else

The proposal's 2% overhead/98% seller-share target is not the current calculator.
The [constants](../packages/fair/src/constants.ts) and
[builder](../packages/fair/src/buildManifest.ts) also deduct a 1% platform fee:
1% protocol + 1% platform + 0.5% node + 0.25% buyer = 2.75%, before optional
scope, tax and processor handling. Buyer-credit units and the proposed target
remain an economic-model question, not a promise made by the implementation.

This allocation argument is about recognizing stakeholders who contributed to a
transaction, not a universal checkout fee. Seller-owned BYO Stripe settlement
does not distribute a platform-held `.fair` chain or collect that platform fee.
Consult the [pay spec](https://jin.imajin.ai/pay/api/spec) for the chosen flow.

Settlement validates the manifest's chain and totals. Non-funded settlement verifies a
signature when supplied but currently allows a missing signature with a warning; funded
settlement skips that verification. Signed creator proofs can be verified independently,
but a settlement is not a guarantee that every manifest was signed or DFOS-backed.

`.fair` is a standalone JSON format. You can use it without MJN. MJN uses it for all attribution.

### 4. Settlement

The shared `@imajin/money` Money primitive preserves currency identity and signed
FX snapshots. `usage.incurred` metering and `usage.billed` reconciliation remain
separate records, not proof that every vendor invoice has been imported.

The bus `settle` reactor reads the manifest, resolves placeholder DIDs, deducts processing
fees, splits the payment,
and emits a `transaction.settled` attestation. No human intervention. No invoice. No accounts
receivable in that automated path. Signature exceptions above still apply.

**Implemented rails (not deployment verification):** Stripe checkout uses the
seller's own BYO connector account, not Stripe Connect or a platform-held
fallback. CAD Interac e-Transfer pay-in for payment requests supplies instructions
and requires manual receiver confirmation, not an automatic bank feed.

**MJN / MJNx ledger:** Two units, one ledger, retained provenance. **MJN** is receipt-backed money — minted only against a rail
receipt (Stripe receipts in supported flows; additional rails require their own receipt contract), burned against
a payout receipt, withdrawable. **MJNx** is the emitted platform unit — earned by activity
per a configured emission schedule, spendable in-platform, **not withdrawable**, and never
silently converted to MJN. Any future MJNx → MJN relationship is a reserved Stiftung seat
(RFC-12) — an invariant, not a conversion promise or a rate.

**Settlement boundaries:** single-unit ledger settlement already checks accepted
units. A future on-chain bridge, Solana Pay, Lightning and x402 remain distinct
planned work, not guarantees attached to an existing balance.

**Gas model for declared-intent marketplace:**

| Tier | Reach | Cost |
|------|-------|------|
| Tier 1 | Trust graph connections | Free / near-free |
| Tier 2 | Declared interest pool | Medium gas |
| Tier 3 | Extended reach, opted-in | High gas |

The proposed frequency-scaled depth gating would prevent spam: costs escalate with repetition
(1× → 1.5× → 3× → 7× → 15× → 40×). The proposed matching stays local to the user's node and calls for k-anonymity;
these are design requirements, not implemented guarantees.

The dual-unit ledger distinction is implemented; the proposed gas/reach market
and k-anonymity are not established by it. [RFC-12](canon/rfcs/RFC-12-mjn-token-economics.md)
contains the economic model. Current activity emissions come from
[configured schedules](../packages/bus/src/emissions.ts) and credit MJNx; the
public emission route is disabled. The cent-based MJNx calculation and the
model's no-fiat-relationship language still require reconciliation. There is
no implicit MJNx-to-MJN conversion or bridge promise.

### 5. Discovery

Federated registry at `jin.imajin.ai/registry`. Nodes announce presence, operators, and
served scopes. Registration verifies the node attestation signature and an approved build.
Chain lookup is optional and best-effort; it is not full cryptographic chain replay.

**Selective disclosure:** The broker layer mediates access to personal data with consent
grants. A traveler shares dietary preferences with a restaurant but not their budget.
A sizing service gets measurements but not identity. Each field, each purpose, each release
mode is explicit. The implemented release pipeline includes audit; preview intentionally
skips release and audit. Shadow decisions are advisory; enforcement decisions are binding.

**Exit credentials (planned):** the proposed departure flow would provide a signed portable credential — public
summary (aggregate stats) and encrypted context (full attestation history under departing
Actor's key). A complete automatic export/departure flow is not established by current
source; signature coverage would still follow the proof-model limitations above.

### 6. Revocation

The option to leave. Attestation, Communication, Attribution, Settlement, and Discovery each
assert into the record; Revocation is the only primitive whose force is directed at *other*
sentences in the record — it acts on validity, not on the world.

**Tiered destruction:**
1. **Withdraw** — stop future participation. The past stands.
2. **Soft (tombstone)** — the record is marked invalid; the shape stays visible, the content doesn't speak for itself anymore.
3. **Hard** — destroy the underlying hash/key. The tombstone remains; what it protected doesn't. The record remembers *that* something was revoked. Destruction erases *what*.

**Propagation is part of the primitive.** A revocation that doesn't reach every node holding
a copy of the attestation is theater, not revocation.

Revocation is a first-class primitive, not a sub-case of Attestation. Specific
grant/record revocations are implemented. A universal tombstone propagation
transport and hard-destroy key lifecycle are not established by that fact; the
three levels above express the protocol's required grammar.

---

## Infrastructure Layers

### Event Bus (`@imajin/bus`)

Side effects are the hard part. "After payment succeeds, create an attestation, credit MJNx,
settle the .fair manifest, and notify the seller." Without the bus, that's a fragile
imperative sequence in a webhook handler. With the bus, it's a composable reactor chain.

```
bus.publish('listing.purchased', { issuer, subject, scope, payload })
→ attestation reactor (sign + store)
→ mjn reactor (emit tokens)
→ settle reactor (resolve .fair, split payment) [blocking]
→ notify reactor (send notifications)
```

This illustrates a kernel-owned chain, not the public app-event ingestion path.
An external app's emitted event can notify and audit only; it cannot invoke
settlement, token emission or attestation issuance through this example.

Built-in reactors: `attestation`, `mjn`, `settle`, `notify`, `emit`, `webhook`.
Custom reactors via `registerReactor()`.

Chain configuration supports exact-scope DB rows, node-default DB rows, and code defaults
through [getChainConfig](https://github.com/ima-jin/imajin-ai/blob/main/packages/bus/src/config.ts). Emission schedules use versioned
DB configuration. These are implemented lookups, not proof of any live operator's configuration.

### Vault

Encrypted key-value storage with signed, CID-addressed entries. Data sealing uses
AES-256-GCM. V1 derives a node seal key; v2 uses per-field keys wrapped through
X25519 delegation grants. Tier 0 self-grants do not separate custody from the node.
Tier 1 can require an external owner agent, while an active grant still enables node access.
Both entry formats remain supported; source support does not certify a completed production
migration. See the [custody migration runbook](https://github.com/ima-jin/imajin-ai/blob/main/docs/vault-custody-migration-runbook.md).

The vault supports purpose-scoped SSH CA lifecycle and bounded user-certificate
issuance, with no private CA export. Live grants bind principals, forced command,
hosts and expiry; revocation stops new signing, not already-issued certificates.
GitHub jobs authenticate with verified OIDC for the granted repository/environment.
Hosts must separately deploy public trust and enforce principal policy.
The [deploy contract](https://github.com/ima-jin/imajin-ai/blob/main/docs/deploy/vault-ssh-deploy.md)
requires per-job keys on non-swappable tmpfs and pinned host keys.

Sealed `bank-details:v1` records are individually sealed fields with immutable
private documents and retained signed replacement/revocation history, not plaintext
profile metadata. The API requires human-session auth-scoped owner/admin access;
Tier 0 remains node-controlled and Tier 1 saves fail closed. The separate legal-entity
document releases name/address fields independently. Neither implementation claims
a complete invoice/PDF flow or a bank settings UI.

### Federated App Authentication

The legacy `requireAppAuth()` attestation-validation path remains, alongside short-lived
EdDSA JWTs: user-delegated app tokens, app-service tokens, and session-app tokens.
User-delegated token issuance validates consent and app proof-of-possession; token
verification can be local. Short TTLs bound revocation lag unless a route rechecks live
consent/registry state. OAuth/MCP are separate kernel surfaces, so "no OAuth, no token
exchange" is not the integration contract. See [registration](https://github.com/ima-jin/imajin-ai/blob/main/docs/REGISTRATION.md).

---

## Cryptographic Stack

| Primitive | Purpose |
|-----------|---------|
| Ed25519 | DID keypairs, attestation signing, .fair signing, sessions |
| SHA-256 | Content hashing and key derivation; key-based DIDs encode public-key bytes |
| X25519 | Vault delegation-key wrapping; unused legacy chat encryption utility |
| XChaCha20-Poly1305 | Unused legacy chat encryption utility, not current message protection |
| AES-256-GCM | Vault data sealing |
| dag-cbor + CID | DFOS content addressing, attestation CIDs |
| JWS | DFOS signature format |
| JWT | Sessions and scoped app tokens (EdDSA) |

Relational state uses Postgres and Drizzle. Vault content is file-backed, with grant
metadata in the database; not all persistence is Postgres.

---

## The Sovereignty Property

Imajin rejects:

- **Subscriptions** — you own it forever
- **Cloud dependency** — self-hosted on owned hardware
- **Vendor lock-in** — source-available under INL, with independently replaceable apps
- **Surveillance capitalism** — your data stays on your node
- **Orchestration theater** — no Kubernetes, no service mesh

A node doesn't need the registry to exist — only to be discoverable. If the registry
disappears, independently held keys and exported chain proofs do not depend on its
availability. That is not a claim of automatic portable history export: exit credentials
remain planned.

Federation is the honest architecture: central registry now (ships fast), on-chain registry
next (Solana), mesh trust eventually (no central authority).

---

## Current implementation and limits

Source implements the separate MJN/MJNx ledger, consent-based selective disclosure
with preview/shadow/enforce modes, registered apps, scoped connector operations,
operator approvals, incurred usage and separate billed reconciliation. Approval
countersignature requirements are per-node policy; source existence is not proof
that a host requires a human signature.

The vault supplies purpose-scoped SSH CAs, bounded certificate signing and a
GitHub OIDC deploy action; hosts separately install trust and principal policy.
Sealed bank details and legal-entity records have distinct custody/disclosure
rules. Corpus uses registry-resolved owner partitions, live explicit grants and
the source owner's OAuth connector, never a node-token fallback. Connector metadata
discovery is not credential release. Inference promotion requires exact-SHA
production evidence and mode-appropriate health; installation remains operator-managed.

Generalized weighted/decaying portable standing, portable exit credentials, a
complete token bridge and the declared-intent gas marketplace remain planned.
Read [the concise guide](../apps/kernel/public/llms.txt) and each service's live
spec for integration contracts. These are implementation boundaries, not a claim
that every standalone app or production node has adopted them.

---

Build metrics (lines of code, commits, live-since date) are generated, not hand-typed —
see the README's [Project Status](https://github.com/ima-jin/imajin-ai/blob/main/README.md#project-status)
for the replayable stats table and how each figure is derived.

---

Licensed under the [Imajin Network License (INL)](https://github.com/ima-jin/imajin-ai/blob/main/LICENSE.md).
This repository is the Imajin Inc. reference implementation of the MJN protocol, not the
protocol spec itself — the spec is scoped to move toward an independent protocol entity
over time.

*[Developer Guide](https://github.com/ima-jin/imajin-ai/blob/main/docs/developer-guide.md) · [llms-full.txt](https://jin.imajin.ai/llms-full.txt) · [.fair spec](https://github.com/ima-jin/.fair) · [DFOS](https://protocol.dfos.com) · [Source](https://github.com/ima-jin/imajin-ai)*
