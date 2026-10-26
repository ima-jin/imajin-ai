# MJN Protocol
## A Cryptographic Operating System for Sovereign Commerce
### v0.8 · October 2026

*Ryan Veteze · ryan@imajin.ai · [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)*

**Building on MJN?** → [Developer Guide](https://github.com/ima-jin/imajin-ai/blob/main/docs/developer-guide.md)
**Machine-readable spec** → [llms-full.txt](https://imajin.ai/llms-full.txt)

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
Events is owned by [ima-jin/events](https://github.com/ima-jin/events). Its kernel copy
was pruned under [#2517](https://github.com/ima-jin/imajin-ai/issues/2517)
(closed 2026-10-17); production acceptance
[#2516](https://github.com/ima-jin/imajin-ai/issues/2516) closed under the
2026-10-20 ruling, with future-event buy/QR smoke deferred to #2989.
Pruning is not proof of completed production acceptance. External apps
compose through scoped tokens, published `@ima-jin/*` SDKs and public kernel
APIs, not kernel-internal workspace imports. See [the registration contract](https://github.com/ima-jin/imajin-ai/blob/main/docs/REGISTRATION.md).

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

**Attestation vocabulary:** [80+ and growing](https://github.com/ima-jin/imajin-ai/blob/main/packages/auth/src/types/attestation.ts),
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
is planned under [#1070](https://github.com/ima-jin/imajin-ai/issues/1070), not implemented.
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

Fee cascade — deducted in order, seller gets the remainder:
1. **Protocol fee**: 1.0% (fixed — this is how the network sustains itself)
2. **Node fee**: 0.5% default, operator-configurable [0.25%, 2.0%]
3. **Buyer credit**: 0.25% default — the buyer earns MJN for transacting
4. **Scope fee**: optional — only when a community/business takes a cut
5. **Seller share**: everything else

Default total overhead: 2%. The seller gets 98%. Compare to Stripe's 2.9% + $0.30 where
the platform keeps everything. Here, the 2% is split across four stakeholders who all
contributed to the transaction happening.

> **Economic-model discrepancy (October review):** the fee narrative above is retained
> pending a separate ruling/rewrite, not endorsed as the current calculator. The
> [constants](https://github.com/ima-jin/imajin-ai/blob/main/packages/fair/src/constants.ts) and
> [builder](https://github.com/ima-jin/imajin-ai/blob/main/packages/fair/src/buildManifest.ts) also deduct a 1% platform fee:
> 1% protocol + 1% platform + 0.5% node + 0.25% buyer = 2.75%, before optional scope and
> processor fees. The stated 2%/98% and buyer-credit unit need explicit reconciliation.
> This is the manifest-builder path, not a universal checkout fee: seller-owned BYO Stripe
> settlement does not distribute a platform-held `.fair` chain or collect that platform fee.

Settlement validates the manifest's chain and totals. Non-funded settlement verifies a
signature when supplied but currently allows a missing signature with a warning; funded
settlement skips that verification. Signed creator proofs can be verified independently,
but a settlement is not a guarantee that every manifest was signed or DFOS-backed.

`.fair` is a standalone JSON format. You can use it without MJN. MJN uses it for all attribution.

### 4. Settlement

The bus `settle` reactor reads the manifest, resolves placeholder DIDs, deducts processing
fees, splits the payment,
and emits a `transaction.settled` attestation. No human intervention. No invoice. No accounts
receivable in that automated path. Signature exceptions above still apply.

**Implemented rails (not deployment verification):** Stripe checkout uses the seller's
own BYO connector account; Stripe Connect and its platform-held fallback were removed
([#2766](https://github.com/ima-jin/imajin-ai/pull/2766), merged 2026-10-09).
CAD Interac e-Transfer pay-in for payment requests provides instructions and requires
manual receiver confirmation, not an automatic bank feed
([#2667](https://github.com/ima-jin/imajin-ai/pull/2667), merged 2026-10-06).

**MJN / MJNx ledger:** Two units, one ledger, provenance forever (ruled 2026-09-04, shipped
in the #2016 ledger split). **MJN** is receipt-backed money — minted only against a rail
receipt (Stripe today; e-Transfer, Lightning, Solana Pay/x402 as they land), burned against
a payout receipt, withdrawable. **MJNx** is the emitted platform unit — earned by activity
per a configured emission schedule, spendable in-platform, **not withdrawable**, and never
silently converted to MJN. Any future MJNx → MJN relationship is a reserved Stiftung seat
(RFC-12) — an invariant, not a conversion promise or a rate.

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

> **Model review boundary:** the dual-unit ledger distinction agrees with current code,
> but this section is not a delivery claim for future rails, a bridge, or the gas marketplace.
> [RFC-12](https://github.com/ima-jin/imajin-ai/blob/main/docs/rfcs/RFC-12-mjn-token-economics.md) retains stale emission-route and schedule
> wording: the [current schedule](https://github.com/ima-jin/imajin-ai/blob/main/packages/bus/src/emissions.ts) is versioned DB
> configuration emitting MJNx, and the public emission route is disabled. Its percentage
> calculation also uses a cent-based MJNx scale, which needs reconciliation with RFC-12's
> no-fiat-relationship language. The gas/reach and k-anonymity claims above remain
> unverified design language pending a separate model pass.
>
> The retained "MJNx-direct" planned label and "MJN token settlement (dual-currency)"
> pending row also need a model pass: single-unit ledger settlement with an accepted-unit
> check already exists, while an on-chain token bridge remains a separate reserved seat.

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

Ruled a first-class primitive on 2026-08-14 — not a sub-case of Attestation. Named ahead of
the lived experience: the canonical seat in the grammar is set now; the concrete
implementation (tombstone schema, propagation transport, hard-destroy key handling) waits
for the use case that forces it.

---

## Infrastructure Layers

### Event Bus (`@imajin/bus`)

Side effects are the hard part. "After payment succeeds, create an attestation, credit MJN,
settle the .fair manifest, and notify the seller." Without the bus, that's a fragile
imperative sequence in a webhook handler. With the bus, it's a composable reactor chain.

The retained example's MJN wording is part of the model discrepancy above: activity
emissions currently credit MJNx, not MJN.

```
bus.publish('listing.purchased', { issuer, subject, scope, payload })
→ attestation reactor (sign + store)
→ mjn reactor (emit tokens)
→ settle reactor (resolve .fair, split payment) [blocking]
→ notify reactor (send notifications)
```

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
Both entry versions remain supported; this review does not certify a completed production
migration. See the [custody migration runbook](https://github.com/ima-jin/imajin-ai/blob/main/docs/vault-custody-migration-runbook.md).

The release adds purpose-scoped SSH CA lifecycle and bounded user-certificate
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

## What's Live
Implementation evidence checked against source `6f16236e` on 2026-10-17. Here ✅ means
merged implementation with a backing PR, not verified deployment or production acceptance.
Unbacked prior ✅ rows are removed rather than carried forward as assumptions.

Release-diff additions checked at `4d7b2dc1` on 2026-10-25 follow below.
They are source evidence, not claims of host deployment or production data migration.

| Status | Item |
|--------|------|
| ✅ | MJN/MJNx dual-unit ledger — receipt-backed withdrawable MJN vs. emitted non-withdrawable MJNx ([#2159](https://github.com/ima-jin/imajin-ai/pull/2159)) |
| ✅ | Selective disclosure / data broker — consent, scoped release, HTTP API and audit ([#1192](https://github.com/ima-jin/imajin-ai/pull/1192)); advisory shadow mode ([#1237](https://github.com/ima-jin/imajin-ai/pull/1237)); not a production-complete claim |
| ✅ | Google Workspace connector — OAuth2 Gmail, Calendar, Drive integration and reactive provider-side revocation ([#2151](https://github.com/ima-jin/imajin-ai/pull/2151), [#2153](https://github.com/ima-jin/imajin-ai/pull/2153)) |
| ✅ | App registry — first-class registered-app table ([#2160](https://github.com/ima-jin/imajin-ai/pull/2160)) |
| ✅ | Operator approvals via /jin — kernel-witnessed confirm decisions; operator countersignature is conditional ([#2078](https://github.com/ima-jin/imajin-ai/pull/2078)) |
| ✅ | Public signed usage-rollup read API and manual/backfill `usage.billed` ([#2031](https://github.com/ima-jin/imajin-ai/pull/2031)); receipt upload binding ([#2041](https://github.com/ima-jin/imajin-ai/pull/2041)) |
| ✅ | `@imajin/money` — currency-safe Money primitive with signed FX snapshots ([#2036](https://github.com/ima-jin/imajin-ai/pull/2036)) |
| ✅ | Purpose-scoped SSH CA lifecycle ([#3066](https://github.com/ima-jin/imajin-ai/pull/3066)), bounded certificate signing ([#3083](https://github.com/ima-jin/imajin-ai/pull/3083)) and reusable GitHub OIDC deploy action ([#3095](https://github.com/ima-jin/imajin-ai/pull/3095)); host trust rollout is separate |
| ✅ | Sealed bank-details API ([#3107](https://github.com/ima-jin/imajin-ai/pull/3107)) and per-field legal-entity release ([#3096](https://github.com/ima-jin/imajin-ai/pull/3096)); custody/disclosure limits above apply |
| ✅ | Registry-owner-DID corpus partitions ([#3103](https://github.com/ima-jin/imajin-ai/pull/3103)) and source-owner GitHub OAuth credentials ([#3102](https://github.com/ima-jin/imajin-ai/pull/3102)); live explicit grants required, no node-token fallback, signed migration is a separate operation |
| ✅ | Grantee-only Cloudflare zone-grant metadata ([#3094](https://github.com/ima-jin/imajin-ai/pull/3094)), without credential release |
| ✅ | Inference release updater gated by exact-SHA successful production deployment and mint-backed health ([#3060](https://github.com/ima-jin/imajin-ai/pull/3060)); installation is operator-managed |
| ⏳ | Generalized weighted/decaying and portable standing (local eligibility checks exist) |
| ⏳ | Portable exit credentials |
| ⏳ | MJN token settlement (dual-currency) |
| ⏳ | Declared-intent marketplace |

---

Build metrics (lines of code, commits, live-since date) are generated, not hand-typed —
see the README's [Project Status](https://github.com/ima-jin/imajin-ai/blob/main/README.md#project-status)
for the replayable stats table and how each figure is derived.

---

Licensed under the [Imajin Network License (INL) v1.0](https://github.com/ima-jin/imajin-ai/blob/main/LICENSE.md).
This repository is the Imajin Inc. reference implementation of the MJN protocol, not the
protocol spec itself — the spec is scoped to move toward an independent protocol entity
over time.

v0.6 (2026-09): Revocation added as sixth primitive (#2042). MJN/MJNx model reconciled
(#2019). What's Live refreshed. Build Stats section removed — replayable stats live in
the README. Stale dates and counts corrected.

v0.7 (2026-10): Evidence pass against `6f16236e` — qualify proof, DFOS, standing, chat,
vault custody, node registration and exit claims; correct app boundaries, scoped DB chain
configuration, token authentication and persistence; reconcile What's Live to merged PRs,
including implemented broker modes, without inferring deployment. Economic/model disagreements
are explicitly flagged, not ruled here. This pass also records the previously unversioned
2026-10-17 events-boundary edit (`6d6c06c2`, referencing issue #2517); production acceptance
is tracked separately by #2516 and is not established by pruning.

v0.8 (2026-10): v0.8.26..`4d7b2dc1` release-diff sweep (#2028): document SSH
CA/signing/OIDC deploy boundaries, sealed bank-details/legal-entity records,
owner-DID corpus and OAuth requirements, Cloudflare metadata grants and the
production-evidence-gated inference updater; record #2516's 2026-10-20 ruling.
Economic/model annotations are unchanged.

*[Developer Guide](https://github.com/ima-jin/imajin-ai/blob/main/docs/developer-guide.md) · [llms-full.txt](https://imajin.ai/llms-full.txt) · [.fair spec](https://github.com/ima-jin/.fair) · [DFOS](https://protocol.dfos.com) · [Source](https://github.com/ima-jin/imajin-ai)*

*Live since February 2026.*
