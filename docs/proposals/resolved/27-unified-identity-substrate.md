# Proposal 27 — The Unified Identity Substrate

**DFOS as Cryptographic Bedrock, MJN as Living Protocol**
*Not a Bridge Between Two Systems. One System With Two Expressions.*

---

## STATUS: RESOLVED
**Adopted:** 2026-03-22 (same day filed)
**Resolved:** 2026-03-27 (audit against upstream HEAD `1d943e0`)
**Evidence:** Whitepaper v0.4 states: *"Identity substrate: DFOS by Brandon/Metalabel. Every `did:imajin` is anchored to a DFOS proof chain. The chain is canonical; `did:imajin` is a stable alias. MJN is Layer 6."* The JBOS architecture diagram explicitly layers DFOS Proof Chains as the substrate beneath the kernel. RFC-19 (Kernel/Userspace Architecture) builds on this substrate thesis. Every service is now chain-aware via `@imajin/auth`.
**Outcome:** Core thesis (DFOS as cryptographic bedrock, not external protocol to bridge) is now the canonical architectural description in the whitepaper, build timeline, and all new RFCs. 4 of 8 decisions resolved in code; 1 newly resolved (whitepaper v0.4); 3 remain open but are implementation details, not architectural questions.

| Decision | Status | Evidence |
|----------|--------|----------|
| #4 External DFOS trust: fresh start | **RESOLVED** | `present-chain` → `tier: 'preliminary'`; countersig exception documented |
| #6 Relay: default node infra | **RESOLVED** | PR #453 — relay mounted in registry, not optional; bumped to v0.5.0 |
| #7 `institution.verified`: formalize now | **RESOLVED** | `packages/auth/src/types/attestation.ts` + events check-in PR #440 |
| #8 Whitepaper v0.4: MJN as L6 on DFOS | **RESOLVED** | Whitepaper v0.4 line 22: "MJN is Layer 6" on DFOS substrate |
| #1 Chain-first canonical | **Open** | `chainVerified` on session but `auth.identities` still primary |
| #2 CID scope: portable content only | **Open** | No explicit policy written |
| #3 Chain verification caching | **Open** | Verify-at-login pattern exists; not formally documented |
| #5 Collective chains: DFOS proposal | **Open** | P27 §7.4 defers to DFOS team; no proposal filed yet |

**Implementation:** Thesis in whitepaper v0.4, build timeline, and all downstream RFCs. Decisions #4/#6/#7/#8 resolved. Remaining open decisions (#1/#2/#3/#5) are implementation details within the adopted architectural frame.

---

**Filed:** March 22, 2026
**Author:** Greg Mulholland (Tonalith)
**Series:** Proposal 14 of the Greg architectural review series
**Against upstream HEAD:** `42a151a`
**Depends on:** P25 (Family DID), P26 (DFOS Adoption Audit), Discussion #393 (DFOS Deep Dive)
**Relates to:** P03 (Commons Layer), P19 (Solana Overlap), P21 (Attentional Sovereignty), P22 (Identity Archaeology), Whitepaper v0.3
**Matrix cells:** All scopes × All primitives (foundational substrate proposal)

---

## 1. The Problem With Bridging

P26 (DFOS Adoption Audit) is a thorough, service-by-service plan for propagating DFOS chain awareness across the Imajin platform. Discussion #393 is a masterful technical deep dive into where the protocols overlap and complement each other. Both documents are correct. Both are also framed as integration documents — how to make two systems talk to each other. That framing is the problem.

A bridge implies two shores. Two namespaces. Two canonical representations of the same entity. The moment a user has a `did:imajin` and a `did:dfos`, every service faces the dual-DID question that P26 raises in its open questions: which one do we show? Which is authoritative when they disagree? How do we display both without confusing people?

These are not engineering questions. They are symptoms of a framing error. The architecture should not ask "which DID is canonical?" — it should never have two canonical DIDs in the first place.

The thesis of this proposal: DFOS is not an external protocol to integrate with. It is the cryptographic substrate that MJN's identity layer should have been built on from the start. The reconciliation is not "how do we bridge `did:imajin` to `did:dfos`" — it is "how does MJN adopt DFOS as its native identity primitive and express its own semantics on top of that substrate."

One DID. One keypair. One chain. Everything else — scopes, attestations, standing, governance, settlement — is MJN protocol semantics layered onto that chain. Not a bridge. Not a dual-DID system. A single identity with two layers of meaning: cryptographic proof (DFOS L0–L3) and social/economic meaning (MJN L6).

---

## 2. The Door-Check Model: Physical Vetting as Architectural Clue

There is an analogy hiding in plain sight across the proposal history. At an Imajin event, a ticket buyer arrives at the door. A human checks their ID. The check-in creates an attestation: "this body, this DID, verified present at this event." The ticket's digital proof (Ed25519 signature on purchase) meets physical proof (a person standing in front of you). Neither alone is sufficient. Together, they establish something neither cryptography nor human judgment can establish alone: a verified link between a keypair and a living person.

P03 (Commons Layer) generalized this: the door-check model is not specific to events. Libraries, credit unions, schools, medical practices — any institution where a trusted human verifies a body and cryptographically records that verification. The insight was that EventDID check-in is structurally identical to community-anchored identity issuance. RFC-14 adopted this verbatim.

**What the door-check model reveals about the DFOS reconciliation:**

DFOS chains prove cryptographic identity — this key signed this operation, this chain is mathematically valid, this DID is self-certifying. This is L0–L3. It answers: *"Is this chain real?"*

MJN attestations prove social identity — this person showed up, this person was vouched for, this person contributed, this person has standing. This is L6. It answers: *"Is this person trustworthy?"*

The door check is the seam — the moment where cryptographic proof meets physical proof. The attestation that says "I, an established DID operating a trusted institution, verified this body presented this chain" is the primitive that makes the whole system cohere.

This is not a new feature. It is a precise name for what the system already does. The door check at an Imajin event is already issuing the link between DFOS-layer identity (the keypair) and MJN-layer identity (the attestation record). The proposal is to recognize this as the foundational identity operation and build the architecture accordingly.

---

## 3. The Unified Identity Architecture

### 3.1 One DID, Derived From the Chain

The current architecture maintains two identifiers: `did:imajin` (random nanoid, stored in Postgres) and `did:dfos` (self-certifying, derived from genesis CID). P26 proposes propagating both across all services. This proposal proposes eliminating the distinction.

The migration: `did:imajin` becomes an alias, not a canonical identifier. The canonical identity is the DFOS chain. The `did:imajin` string remains as a human-readable handle — like a DNS name pointing to an IP address — but it is not the identity. The chain is the identity. Every service resolves `did:imajin` to the chain, and the chain is the source of truth.

This is not a cosmetic change. It eliminates P26's open question #2 ("When DB and chain disagree, which wins?") by design: the chain always wins because the chain is the identity. The database row is a cache. When they disagree, the cache is stale.

It also eliminates open question #1 ("Which DID do we show?"): you show the handle (the `did:imajin` alias) in human-facing contexts and the chain identifier in protocol contexts. Same pattern as email addresses vs. public keys, DNS names vs. IP addresses, @handles vs. DIDs.

### 3.2 The Three-Way Convergence as Native Property

P19 identified the Ed25519 convergence: every Imajin DID keypair is simultaneously a Solana wallet and (now) a DFOS chain. This is not a coincidence to exploit — it is a structural property to formalize.

One keypair. Three simultaneous expressions:
- **DFOS chain** — root of cryptographic truth
- **Solana wallet** — root of economic capability
- **MJN attestation record** — root of social meaning

None of these requires a bridge because they are all the same key, viewed from different angles.

### 3.3 Soft DIDs: The Visitor Who Hasn't Arrived at the Door Yet

P26 raises open question #3: soft DIDs (email-only, no keypair) can't have chains. The unified architecture handles this cleanly.

A soft DID is an invitation — a placeholder that says "someone with this email address has been noticed by the network." It has no chain because it has no cryptographic identity. It is not a person on the network; it is a name on the guest list. The moment the holder generates a keypair (the soft→preliminary upgrade), they get a chain. That chain IS their identity from that point forward. The soft DID was never an identity — it was a reservation.

This maps precisely to the progressive trust model:
- **Visitor** (soft DID, no chain, read-only access)
- **Resident** (preliminary DID, chain exists, can participate)
- **Host** (established DID, chain + attestation depth, full governance)

The chain is the threshold between observer and participant. The door check is the threshold between participant and trusted actor.

---

## 4. What MJN Adds That DFOS Does Not

Ryan's assessment that DFOS chains are the superior identity substrate is correct on the narrow question of cryptographic self-certification. Where I push back is on the implication that adoption means wholesale replacement. DFOS is deliberately minimal. It proves identity and content existence. It does not — by its own architect's explicit design choice — handle the following:

### 4.1 Typed Identity Scopes

DFOS treats every DID as a generic identity. MJN's scopes — Actor, Family, Community, Business — are not application-layer decorations. They encode fundamentally different governance models, trust semantics, and privacy boundaries at the identity layer. A Family DID (P25) has custodial relationships, age-graduated rights, fork semantics for separation. A Community DID has trust-weighted quorum governance. A Business DID has non-severable founding anchors and mandatory transparency.

DFOS chains can carry these semantics. The chain's content operations can record governance events, membership changes, custodial transfers. But DFOS does not define what those operations mean. MJN defines the semantics; DFOS carries the proofs. This is the correct division of labor.

**Architectural implication:** Each MJN identity scope becomes a specific schema of DFOS chain operations. A Family DID genesis operation carries MJN-defined fields (guardian DID, governance config, privacy defaults). A Community DID formation operation carries quorum attestations from founding members. The DFOS chain is the container; the MJN scope is the content type.

### 4.2 Standing Computation From Attestation History

DFOS countersignatures record "this DID attested to that content." They do not compute standing, reputation, or trust distance. The whitepaper's standing computation — positive attestations weighted by type, issuer standing, and recency; negative flags with severity and decay; node context for local vs. cross-node standing — is entirely MJN semantics.

DFOS provides the raw material (signed, timestamped attestation records). MJN provides the interpretation (what those attestations mean for trust, governance weight, and access). DFOS proves the receipts; MJN reads them.

### 4.3 The Economic Layer

Discussion #393 identifies this as L6: settlement, gas, attribution fees, declared-intent marketplace. DFOS explicitly punts economics to the integration layer. Brandon's framing ("deeply virgoan commitment to geometrically minimal protocol shape at the cryptography layer") makes this intentional. MJN's five revenue streams, the .fair attribution chain, the frequency-scaled gas model — none of this exists in DFOS. None of it should. The settlement layer IS what Imajin brings.

### 4.4 The Physical Verification Layer

This is the piece neither protocol has fully specified, and it is the piece that makes the unified architecture cohere.

DFOS proves: "this chain is cryptographically valid." It cannot prove: "a real human controls this chain." Sybil resistance in DFOS is a platform-layer problem (spaces have membership gatekeeping). Sybil resistance in MJN is an attestation-layer problem (vouching, event attendance, physical verification at institutional issuance points).

The Commons Layer (P03/RFC-14) is the physical verification infrastructure. Libraries, credit unions, event venues — institutions where a trusted human verifies a body and cryptographically records that verification as an attestation on the person's chain. This is something MJN provides that no pure cryptographic protocol can: a link between a chain and a body.

The `door-check` attestation type (`institution.verified-in-person`) becomes the foundational trust-seeding operation in the unified architecture. A fresh DFOS chain with zero MJN attestations is cryptographically valid but socially unknown. A chain with a door-check attestation from a recognized institution has its first verifiable link to physical reality. Everything else — vouching, event attendance, community standing — builds on top of that initial physical anchor.

---

## 5. The Reconciliation: What Changes, What Stays

### 5.1 What Changes

| Current | Unified | Why |
|---------|---------|-----|
| `did:imajin` is the canonical identifier | DFOS chain is the canonical identity; `did:imajin` is a resolvable alias | Eliminates dual-DID confusion, makes chain authoritative by design |
| Identity stored as Postgres rows in `auth.identities` | Identity IS the chain; `auth.identities` becomes a chain index/cache | DB rows are caches of chain state, not sources of truth |
| JSON key-sort canonicalization (`canonicalize()`) | dag-cbor canonicalization via `@ipld/dag-cbor` (already shipped in `packages/cid`) | Cross-language deterministic, published standard, DFOS-compatible |
| Services look up DIDs via auth API | Services verify chains directly; auth API is one resolution path among several | Any node can verify any chain without calling home |
| Key rotation: not implemented | Key rotation: DFOS chain operations with signed handoff (shipped in PR #426) | The chain captures rotation; no separate mechanism needed |

### 5.2 What Stays

| MJN Component | Role in Unified Architecture | Why It's Not Replaced |
|---------------|-----------------------------|-----------------------|
| 4 identity scopes (Actor/Family/Community/Business) | Typed content schemas on DFOS chain operations | DFOS has no concept of scope; MJN defines what the chain means |
| 5 primitives (Attestation/Communication/Attribution/Settlement/Discovery) | The semantic layer that gives chain operations economic and social meaning | DFOS proves truth; MJN proves value |
| `auth.attestations` table + standing computation | MJN's read-side interpretation of chain-anchored attestation records | Countersignatures are the raw material; standing is the computed meaning |
| .fair attribution + settlement | L6 economic layer on top of CID-addressed content proofs | DFOS explicitly does not do economics; this is the open invitation |
| Progressive trust (Visitor/Resident/Host) | Computed from attestation depth on the chain; door-check is the threshold operation | Sybil resistance requires social verification, not just cryptographic validity |
| Declared-intent marketplace + gas model | Unchanged — local matching, gas-gated reach, frequency-scaled pricing | Pure L6; DFOS is not involved and should not be |
| Commons Layer / community issuance (P03/RFC-14) | The physical verification layer — institutional door-check attestations on chains | The link between chain and body; no pure crypto protocol provides this |
| Solana embedded wallet | Same keypair, same convergence — the chain root key IS the wallet | Three-way convergence is a native property, not a bridge |

---

## 6. How the Unified Architecture Works in Practice

### 6.1 Onboarding: The Journey From Visitor to Host

**Step 1 — Visitor (Soft DID, no chain):** Someone hears about an event. They get a magic link. They have a soft DID — an email-linked placeholder. No keypair, no chain, no wallet. They can browse, read, RSVP. They are on the guest list. They have not arrived at the door.

**Step 2 — Resident (Preliminary DID, chain exists):** They generate a keypair. This single act produces: (a) a DFOS identity chain with a self-certifying DID, (b) a Solana wallet address, (c) a `did:imajin` alias. One keypair, three expressions, zero bridging. Their chain is cryptographically valid but socially empty.

**Step 3 — The Door Check (first physical attestation):** They arrive at the event. A trusted actor (the door person, a library clerk, a community organizer) verifies their physical presence. The check-in creates a countersigned attestation on their chain: "this chain was presented by a verified body at this institution on this date." This is the seam between cryptographic identity and physical identity. The chain now has its first anchor to reality.

**Step 4 — Host (Established DID, attestation depth):** They attend more events. They get vouched for by established actors. They contribute to community projects. Their attestation record grows. Standing is computed. They reach the threshold for full governance participation. The chain records every step. The standing is a query over the chain, not a role in a database.

At no point in this journey does the user encounter two DIDs, two systems, or a bridge. They have one identity that deepens over time. The cryptographic layer (DFOS) and the social layer (MJN) are different lenses on the same chain.

### 6.2 Federation: Carrying Your Chain to a New Node

This is where the unified architecture pays its biggest dividend. In the current bridge model, a user migrating to a new node needs the receiving node to trust the sending node's database. In the unified model:

1. User presents their DFOS chain to the new node
2. New node verifies the chain mathematically — no call home to origin node
3. MJN attestations on the chain (countersigned by institutions, events, vouchers) are verifiable by any node that knows those issuer chains
4. The BaggageDID (P05) is not a separate export artifact — it IS the chain with its attestation history
5. Standing recomputation happens locally on the new node from the chain data

This resolves Outstanding Concern #1 (Social Graph Portability) completely. Trust relationships are not "stored on the node" or "stored on the DID." They are attestation records on the chain, verifiable by anyone with the chain and the issuer's public key. Portability is mathematical, not contractual.

### 6.3 External DFOS Users Joining Imajin

P26 frames this as "Log in with DFOS." In the unified architecture, it is simpler: a DFOS user already has the cryptographic substrate. They present their chain. The Imajin node verifies it. They now have a `did:imajin` alias and can start accumulating MJN attestations.

The crucial difference: they arrive with cryptographic identity but zero social identity on MJN. Their chain is valid but their standing is Visitor-equivalent. They still need a door check, still need vouching, still need to earn trust. The chain gets them in the door faster (no keypair generation needed), but it does not give them standing they have not earned on this network.

This is the correct design. A cryptographically valid identity from another network should not automatically confer trust on MJN. Trust is local. Trust is earned. The chain proves you are real; the attestation record proves you are trustworthy. These are different claims.

Exception: If the DFOS chain carries countersignatures from DIDs that the receiving MJN node already trusts (e.g., the user was attested by an institution that is also an MJN issuance point), those specific attestations can count toward standing computation. This is not a trust shortcut — it is the attestation system working as designed: cross-network trust carried by verifiable attestation records from known issuers.

### 6.4 Family DID on the Unified Substrate

P25 (Family DID) specified a family governance chain, threshold signatures for multi-guardian control, age-graduated rights through attestation accumulation, fork semantics for separation. All of this maps directly onto DFOS chain operations:

- **Family formation:** A DFOS identity chain genesis operation with MJN family-scope content schema (guardian DID, governance config, privacy defaults)
- **Adding members:** A chain update operation, countersigned by existing guardian(s) and the new member
- **Dependent registration:** A chain operation recording a named reference (encrypted), with a null member DID that gets filled on the dependent's keypair generation
- **Age graduation:** Not a chain operation at all — it is a computed query over the member's attestation record (external attestations + internal standing + self-declaration, per P25 §5)
- **Fork (separation):** Two new DFOS chains spawned from the parent chain, each recording the fork event and preserving history

The family DID does not need its own table (`auth.family_identities`) or its own type column. It is a DFOS chain with a family-scope content schema. The content schema IS the type. DFOS's recursive composition ("everything uses the same primitives") matches MJN's "profiles have scopes" design perfectly.

---

## 7. Where I Disagree With Wholesale Adoption

Ryan deems DFOS's identity primitives superior. On self-certification, key rotation, and content addressing — agreed, no contest. On the following points, I push back:

### 7.1 dag-cbor Everywhere Is Premature

Discussion #393 proposes CID-addressing all portable content: chat messages, profile updates, tickets, attestations, .fair manifests. The CID package (`packages/cid`) is shipped. The question is whether every write operation across every service should pay the dag-cbor serialization cost now.

**My position:** CID-address content that needs to be portable or verifiable cross-node. Do not CID-address ephemeral content that has no portability requirement. A chat message in a private conversation does not need a content-addressed CID until federation requires signed messages. A profile bio update does not need a CID until profile portability ships. Premature CID-addressing adds write latency to every operation without immediate benefit.

**The principle:** CID when the content crosses a trust boundary (leaves the node, enters a .fair manifest, gets committed to a chain, participates in a settlement). Do not CID for internal node operations that have no external verifier.

### 7.2 Chain Verification Performance Cannot Be Hand-Waved

P26 raises this as open question #4: chain verification on every request is expensive. The proposal's suggestion ("where do we verify and where do we trust the DB cache?") is correct but underspecified.

**My position:** Verify the chain at session establishment (login). Cache the verified state for the session duration. Re-verify on key rotation events (detected via chain-aware middleware, already shipped in PR #413). For read operations within a session, the DB cache is authoritative. For write operations that produce attestations or settlements, verify the chain head before committing. This gives you cryptographic verification where it matters (identity assertion, trust-relevant writes) without paying the cost on every GET request.

### 7.3 The "Log in with DFOS" Flow Needs a Trust Discount, Not Trust Equality

P26 frames external DFOS onboarding as the sovereign equivalent of "Log in with Google." The analogy is apt but the trust semantics must be explicit: logging in with a DFOS chain from another network gives you cryptographic identity, not social standing. The temptation will be to give DFOS arrivals a faster path to standing ("they already have a chain, they're clearly real"). This is incorrect.

A chain proves you control a key. It does not prove you are trustworthy in this community. The progressive trust model must apply equally to DFOS arrivals and new keypair generators. The chain saves them the keypair generation step. It does not save them the vouching, the door checks, the attestation accumulation.

**Exception:** If the DFOS chain carries countersignatures from DIDs that the receiving MJN node already trusts, those specific attestations can count toward standing computation. This is not a trust shortcut — it is the attestation system working as designed.

### 7.4 Collective Chains (Cultural DID / Family DID) Are an Open Design Question

P26 asks whether DFOS supports collective chains. As of the current spec, DFOS identity chains are single-signer. Multi-signer governance (Community DID quorum, Family DID threshold signatures) requires either a new DFOS operation type or an MJN-specific extension to the chain protocol.

**My position:** This should be proposed to the DFOS team as a protocol extension, not built as an MJN-only divergence. If MJN is serious about DFOS as the identity substrate, collective chain governance is something both protocols need. The alternative — MJN-specific chain extensions that DFOS nodes cannot verify — defeats the interoperability purpose. Raise it with Brandon as a shared design problem.

---

## 8. Imajin Nodes as Relay Infrastructure

Discussion #393's strongest architectural proposal is that Imajin nodes should implement the DFOS web relay spec, making every Imajin node a relay participant. This is correct and the unified architecture strengthens the argument.

If DFOS chains are the identity substrate, then relaying DFOS proofs is not an integration feature — it is a core infrastructure function. Every Imajin node that relays proofs is simultaneously:
- (a) verifying identity chains for its own users
- (b) propagating proof availability across the federation
- (c) enabling offline verification for any participant who has synced the relevant chains
- (d) building the index that sovereign presence (P21's attentional sovereignty) draws on for inference context

The relay is not a separate package to add. It is the identity verification layer that every node must run. If the chain is the identity, then relaying chains is relaying identity. It should ship with the node, not as an optional module.

---

## 9. Revised Priority Sequence

P26's three-phase priority is correct in structure but needs reframing under the unified architecture:

### Phase 1: Foundation (Now)

1. **Canonical chain resolution:** All services resolve `did:imajin` through the chain, not just the DB row. The chain-aware middleware (PR #413) is the starting point; extend it so downstream services receive chain-verified identity, not just session tokens.

2. **Registry as chain-first:** Node registration requires a valid DFOS chain. This is not an optional enhancement — it is the foundation for federation.

3. **Profile surfaces the unified identity:** One display: the handle (`did:imajin` alias) for humans, chain verification badge for protocol-level trust, Solana address in wallet contexts. Not three DIDs — three views of one identity.

### Phase 2: Portability (After Phase 1)

4. **.fair manifests as DFOS content operations:** Every .fair manifest gets committed as a content chain entry. This gives .fair full edit lineage and Merkle provability — for free.

5. **Settlement with chain-verified parties:** Pay service verifies payer/payee chains before settlement. Chain head check, not full re-verification (per §7.2).

6. **Door-check attestation type formalized:** `institution.verified` — a first-class attestation type for physical verification at institutional issuance points. The seam between chain and body.

### Phase 3: Federation (After Relay)

7. **Relay as default node infrastructure:** Every Imajin node relays DFOS proofs. Not optional. Chain-backed identity requires chain propagation.

8. **Connections as chain-backed operations:** Pod membership, Cultural DID formation, Family DID governance — all as chain operations with MJN scope schemas.

9. **Signed messaging:** Messages signed by chain keys for federation readiness. CID-addressed only when crossing node boundaries.

---

## 10. Decisions Required From Ryan

| # | Decision | Greg's Position | Status |
|---|----------|-----------------|--------|
| 1 | Canonical identity: chain-first or dual-DID? | Chain-first. `did:imajin` as alias, DFOS chain as source of truth. Eliminates dual-DID confusion. | Open |
| 2 | CID-addressing scope: everything or portable content only? | Portable content only. CID when content crosses a trust boundary. No CID for internal node operations. | Open |
| 3 | Chain verification caching strategy? | Verify at session start + on key rotation + before trust-relevant writes. DB cache for reads within session. | Open |
| 4 | External DFOS users: trust discount or fresh start? | Fresh start on standing. Exception: countersignatures from DIDs the node already trusts count toward attestation history. | Open |
| 5 | Collective chains: MJN extension or DFOS protocol proposal? | DFOS protocol proposal. Shared design problem. MJN-only chain extensions defeat interoperability. | Open |
| 6 | Relay: optional module or default node infrastructure? | Default. If the chain is the identity, relaying chains is relaying identity. | Open |
| 7 | `institution.verified` attestation type: formalize now or defer? | Formalize now. The door-check is the seam between cryptographic and social identity. It belongs in the attestation vocabulary before April 1. | Open |
| 8 | Whitepaper v0.4: does DFOS appear as substrate or integration? | Substrate. The whitepaper should describe MJN as L6 on DFOS L0–L5, not as a protocol that integrates with DFOS. | Open |

---

## 11. Resolution Signals

What resolution looks like in the repository:

- Chain-first resolution in auth middleware (services receive chain-verified identity, not just session DID)
- `did:imajin` resolution endpoint returns chain data, not just a database row
- `institution.verified` attestation type in the controlled vocabulary
- MJN scope schemas defined as DFOS content operation types (family-scope genesis, community-scope formation, etc.)
- Whitepaper v0.4 describes MJN as L6 on DFOS substrate
- Relay spec implementation in `packages/relay` as a core (non-optional) node dependency

---

*The internet never had a native layer for identity. MJN builds that layer. DFOS provides the cryptographic bedrock it should rest on. The door check — the moment a trusted human verifies a body and records it on a chain — is the operation that makes sovereign identity real. Not the keypair alone. Not the chain alone. The chain anchored to a body, witnessed by a community.*

*One system. Two layers. No bridge.*

— Greg, March 22, 2026
