# Current Proposals
*Active proposals for contribution to ima-jin/imajin-ai — March–April 2026*
*Last reviewed: April 7, 2026 (upstream HEAD: 227b2785)*

For prior proposals with discussion history and outcomes, see `historical-context.md`.
For which outstanding concerns these address, see `outstanding-concerns/outstanding-concerns.md`.
For upstream acknowledgements and implementation status, see `current-context.md`.

**March 27 audit — resolved and moved to `resolved/`:**
- **P03 (Commons Layer)** → RESOLVED — RFC-14 adopted, Greg credited
- **P04 (Embedded Wallet)** → RESOLVED — RFC-11 adopted, Ed25519 convergence confirmed three-way
- **P15 (.fair Attribution)** → RESOLVED — RFC-01 published, Ed25519 signing live in `packages/fair/src/sign.ts`
- **P17 (Intent-Bearing Transactions)** → RESOLVED — RFC-05 published, `FairIntent` type live
- **P19 (Solana/DID Overlap)** → RESOLVED — DFOS bridge live, Ed25519 convergence in whitepaper v0.4
- **P20 (Fee Model)** → SUPERSEDED — RFC-19's 1% settlement fee (0.4/0.4/0.2 split) replaces P20's 0.75%
- **P27 (Unified Identity Substrate)** → RESOLVED — thesis adopted; whitepaper v0.4 makes DFOS substrate canonical; 4/8 decisions resolved

**Previously resolved:** 01, 02, 06, 07, 08, 09, 13, 16, 26

**Active proposals (in this folder):** 05, 10, 11, 12, 14, 18, 21, 22, 23, 24, 25, 28, 29, 31, 32, 33, 34

**March 27 — new proposals filed:**
- **P28 (Launch Readiness)** — Critical path: 3 demo blockers, founding supporter tier, stale issue triage
- **P29 (Attestation Completeness)** — Trust bootstrap problem: 6 of 17 seams emitting; standing computation starved of inputs

**March 29 — new proposal filed:**
- **P31 (Fee Governance)** — Revenue sustainability and anti-capture mechanism. Ryan's decision: keep 1% flat, add governance mechanism (0.75% floor / 3% ceiling). **UPDATE March 30:** Upstream fee model v2 draft (`docs/rfcs/drafts/fee-model-v2.md`) advances to three-party fees (1% protocol + 0.5% node + 0.25% user credit = 1.75% default). P31's governance bounds adopted but rates restructured.

**March 30 audit — status changes:**
- **P8 → RESOLVED** — `settleTicketPurchase()` wired in events webhook. Moved to `resolved/`.

**March 30 — new proposal filed:**
- **P32 (Mooi Onboarding / Node Customization)** — First CulturalDID onboarding case study. Covers node management interface (router-style admin), client-focused landing pages, UI simplification (nav consolidation, feature toggles), crowd-funded events with escrow, progressive disclosure philosophy. Reference case for node operator autonomy.

**April 3 audit — status changes:**
- **P28 (Launch Readiness)** — April 1 infrastructure confirmed live. Refunds already shipping (#561). Post-demo velocity strong. Remaining: founding supporter tier (#474), issue triage.
- **P29 (Attestation Completeness)** — `institution.verified` attestation DISABLED (event DIDs lack keypairs, commit e8a28a1e). Regressed from 19→18 emitting seams. Fix requires sub-identity delegation model (#537).
- **P18 (Consent Primitive)** — DID consent preferences + interest signals + RFC 8058 unsubscribe shipped in email infra (#538–#543). App-level consent advancing; protocol-level primitive still TODO.
- **P31 (Fee Governance)** — PR #526 merged. P31 + questions-for-ryan now in upstream `docs/proposals/`. RFC-23 adds multi-chain settlement dimension.

**April 7 — new proposals filed:**
- **P33 (Group Key Sovereignty)** — Group Ed25519 keypairs are generated and stored but never used for signing. All attestations signed by platform key. Three-phase plan: (1) activate dead keys with server-delegated signing (~1 day), (2) threshold signing via Shamir secret sharing (~1-2 weeks), (3) social recovery + DFOS key rotation (post-fundraise). Phase 1 also resolves #537 (event DID signing) and unblocks P29's institution.verified.
- **P34 (Crowd-Funded Events)** — Four-stage flow: propose → poll → fund (via existing escrow API) → confirm/refund. Wires existing pay service escrow (`capture_method: 'manual'`) to events. New `funding_commitments` table + 5 columns on events. Includes scope fee integration (fee model v3), attestation chain, and end-to-end Mooi walkthrough. P0+P1 is ~3-5 days of work.

**April 7 audit — status changes (93 commits since April 3):**
- **P32 (Mooi / Node Customization)** — **NEAR-COMPLETE.** Ryan built the entire forest infrastructure independently: group identities (#587), forest config (#592/#593), contextual onboard (#597), scope-aware services (all 12), launcher filtering. Everything P32 proposed is now live except crowd-funded events (§6) and BBS/forum view. Mooi cited by name in fee model v3.
- **P10 (Org DID Vetting)** — **SUBSTANTIALLY RESOLVED.** Group identities with real Ed25519 keypairs, multi-controller access (owner/admin/member), service-scoped permissions via `allowedServices`. External vetting/attestation by third parties still missing.
- **P25 (Family DID)** — **SCHEMA COMPLETE.** `scope: 'family'` in group identities. Identity primitive now built.
- **P23 (Node Operator Recognition)** — **SUBSTANTIALLY ADVANCED.** Two revenue streams (settlement fee 0.25–2% + gas 100% to node), forest config gives operators control over service surface, relay auto-bootstrap simplifies setup.
- **P31 (Fee Governance)** — **v3 SUPERSEDES.** Four-layer model: protocol 1% + node 0.5% + buyer credit 0.25% + scope fee 0.25% = 2.0% default. Scope fee is sovereign (no protocol ceiling). Dual-token (MJN + MJNx at 1 CHF).
- **P29 (Attestation)** — 5 new types: `group.created`, `group.member.added`, `group.member.removed`, `group.member.left`, `scope.onboard`. Total now 24. `institution.verified` still disabled.
- **P14 (Governance Equity)** — Service-scoped controller access is a governance primitive. Scope fee is sovereign. Gas rate governance flagged for Tonalith analysis.
- **P11 (Gas Model)** — Fee model v3 specifies gas: 1¢ per non-economic operation, 100% to node, bilateral signing for integrity.

**Partially resolved (still active, monitoring):**
- P10 (Org DID Vetting) — schema + API complete (group identities with keypairs, controllers). External vetting/attestation gap remains
- P14 (Governance Equity) — community-layer done; service-scoped controller access adds governance primitive; Foundation governance still unspecified
- P18 (Consent Primitive) — RFC-22 consent-and-sign redirect + email infra consent preferences; per-transaction consent still TODO
- P21 (Attentional Sovereignty) — framing accepted, whitepaper does not yet use the language directly
- P22 (Identity Archaeology) — attestation schema live, `client_hint` and `category` fields still missing (P7 open)
- P24 (Agent Fair Attribution) — RFC-19 agents-as-userspace-apps spec; agent sub-identity designed; no code yet
- P28 (Launch Readiness) — demo infrastructure live; post-demo items (founding supporter #474, issue triage) still no progress
- P29 (Attestation Completeness) — 24 types now (was 18); `institution.verified` still disabled; event DID delegation model still blocked (#537)
- P31 (Fee Governance) — fee model v3 supersedes; scope fee + dual-token + gas model go beyond P31's scope
- P32 (Mooi / Node Customization) — forest infrastructure shipped; remaining: crowd-funded events, BBS/forum view, theme UI

**Still open:**
- P05 (BaggageDID) — no code, no spec adoption
- P11 (Gas Model Ceiling) — fee model v3 specifies gas (1¢ per op, 100% to node). No code yet. Governance bounds flagged as open question.
- P12 (Declaration Granularity) — spec in whitepaper (k-anonymity), blocked on Stream 2
- P25 (Family DID) — schema complete (`scope: 'family'` in group identities). Governance model exists (RFC-17). No family-specific UX.

---

## 1. Progressive Trust Model — Tiered Onboarding

**Author:** Greg Mulholland (concept), refined with Ryan Veteze and Jin
**Date:** March 2026
**Related upstream:** #247 (Cultural DID), #248 (Org DID), #244 (Delegated App Sessions), #271 (Progressive Trust Model)
**Addresses:** Outstanding Concerns: Governance Equity, Cultural DID specification gaps

### Context

The current identity model has a binary gap: Soft DID (email-verified, almost no access) vs. Hard DID (keypair-based, full access). There is no graduated middle ground. The proposal separates *entry* from *full participation* by computing standing from attestation history rather than from DID type.

Ryan's refinement: graduated permissions on *existing* DID types rather than introducing new DID types. Same keypair throughout. Same `did:imajin:*`. What changes is **standing**, computed from attestation history.

### The Model: Three Permission Levels, Two DID Types

**Soft DID — Visitor**
- Attend events, hold tickets, enroll in courses
- No profile, no apps, no wallet
- Created via email/magic link or event check-in

**Hard DID (Preliminary) — Resident**
- Full profile (avatar, bio, handle)
- Connect payment rails (wallet active, can transact)
- Use apps (coffee, links, learn, dykil, etc.)
- Message direct connections
- See markets/offers within immediate trust graph
- Browse Cultural DID lobbies, apply to join
- ❌ Cannot vouch for or invite others
- ❌ Cannot create events, Cultural DIDs, or Org DIDs
- ❌ Cannot see extended trust graph (direct connections only)

**Hard DID (Established) — Host**
- Everything above, plus:
- Vouch for Preliminary DIDs (starts their onboarding period)
- Create events, Cultural DIDs, Org DIDs
- See extended trust graph
- Eligible for governance weight in communities
- Standing visible to the network

### Progression

**Soft → Preliminary:** Generate a keypair. Register. Immediately a Preliminary hard DID.

**Preliminary → Established:** Requires both:
1. A vouch from an Established DID — someone in good standing sponsors onboarding
2. Milestone completion during onboarding period — the vouch starts a probation window, not instant graduation

**Onboarding Milestones** (examples, governance-configurable):
- N verified interactions with Established DIDs
- N event attendances (verified physical presence)
- N days on the network (time-gating prevents rush)
- Zero unresolved flags

**Accelerated path:** An Established DID can manually vouch and accelerate — but their standing is on the line. Reckless vouching has consequences (see Trust Accountability Framework below).

**Automated path:** If no one vouches but a Preliminary DID accumulates sufficient attestations organically (through events, check-ins, interactions), the system can surface them to governance bodies for evaluation. The network doesn't require a personal relationship with an existing member — just demonstrated relational behavior.

### Clarification on Preliminary DID Connections

Preliminary DIDs can *receive and accept* connections from Established DIDs. They can message within those direct connections. What they cannot do is vouch, invite, or initiate connections to other Preliminary DIDs.

The network comes to you through people who are already trusted. The preliminary phase is immediately useful — you're not in a waiting room. The restriction is on outbound trust actions (vouching, inviting), not on inbound relationships.

### Implementation Notes

- Standing is computed, not assigned — it's a query over attestation history on `auth.identities`
- Attestations are the mechanism: "attended event X", "vouched by DID Y", "checked in at Org Z" — typed, signed, verifiable
- No new DID type needed — `did:imajin:*` with a `standing` field derived from attestations
- Permission checks happen at the service level — each API checks the caller's standing tier
- Greg's "context tokens" map to attestation count + diversity — not a new token primitive, just a query shape

### Open Questions

- What are the right milestone thresholds? Network-wide defaults or per-Cultural-DID configurable?
- How long is the onboarding period? Fixed or variable based on activity velocity?
- Should Preliminary DIDs see that they're in an onboarding phase, or is it invisible until they try to do something they can't?
- Can an Established DID be demoted back to Preliminary? (See Trust Accountability Framework)

---

## 2. Trust Accountability Framework — Bad Actor Model

**Author:** Greg Mulholland (concept), vouch chain accountability refined with Ryan Veteze
**Date:** March 2026
**Related upstream:** #271 (Progressive Trust Model), #247 (Cultural DID), #248 (Org DID), #273 (Trust Accountability Framework)
**Addresses:** Outstanding Concerns: Governance Equity (by establishing consequence model)

### Context

The existing system has connections and trust graph queries but no formalized consequence model for bad behavior. Current recourse: manual intervention (doesn't scale), removing connections (informal), or nothing. No flagging system, no consequence tiers, no vouch chain accountability, no rehabilitation path.

### Behavioral Categories

The model is **behavioral, not ideological** — defining patterns that undermine trust, accountability, and non-extraction.

**Category A — Extraction and Exploitation**
- Commercial solicitation in non-commercial community spaces
- Using trust graph access to harvest contact or behavioral data
- Manufacturing fake vouches or coordinated identity deception
- Sockpuppet or Sybil behavior to manipulate governance weight

**Category B — Relational Harm**
- Harassment, sustained unwanted contact, boundary violation
- Behavior that causes a member to disengage or feel unsafe
- Abuse of the flagging system as a weapon against legitimate participants

**Category C — Network Integrity**
- Circumventing physical attendance gates (ticket fraud, ID fraud)
- Coordinated manipulation of attestation accumulation
- Bad actor behavior by a vouched person that the voucher had reasonable cause to anticipate

### Detection Sources

No automated content moderation. Detection from three sources:
1. **Peer flagging** — by Established DIDs, Cultural DID governance bodies, or EventDID operators. The flagger's trust weight is attached to the flag.
2. **Systemic anomaly detection** — unusual patterns in connection requests, attestation velocity, or check-in behavior that diverge from baseline.
3. **Vouch chain accountability** — if a vouched person exhibits bad behavior, the voucher is notified and their standing is reviewed.

All flags are initially private — visible only to the flagging party, the flagged party's direct trust graph, and governance. The flagged DID is not publicly identified. Imajin does not issue public verdicts. The trust graph renders judgment structurally. Exclusion comes through irrelevance, not public shaming.

### Consequence Tiers

**Level 1 — Yellow Flag** (first incident or low-severity)
- DID notified privately
- Standing adjusts marginally
- Cultural DID governance bodies alerted with summary
- No access changes

**Level 2 — Amber Flag** (repeated or moderate-severity)
- Attestation accrual rate throttled
- Applications to new Cultural DIDs surfaced with flag history visible to evaluators
- Direct messaging to non-connected DIDs suspended
- Established DID may be demoted to Preliminary standing

**Level 3 — Red Flag** (sustained pattern or severe single incident)
- DID demoted to Preliminary (or Soft) standing
- EventDID and Cultural DID operators notified
- Vouching DID takes a standing reduction
- Recovery path exists but requires formal review by a governance body

**Permanent Removal** (Category C violations or uncontested pattern of Category A + B)
- Cryptographic DID blacklisted across the network
- Vouching DID takes significant standing penalty
- Threshold intentionally high — over-punishment erodes trust as surely as under-punishment

### Vouch Chain Accountability

When you vouch for someone, you're saying "I'm sponsoring their onboarding, and my standing reflects how that goes."

- Vouched person completes onboarding → your standing gets a small positive attestation
- Vouched person flagged during onboarding → you're notified, your standing is reviewed
- Vouched person permanently removed → you take a significant standing hit

This makes vouching a considered act with real consequences. The social pressure is architectural, not performative.

### Implementation Notes

- Flags are attestations — typed, signed, attached to the flagged DID's identity record
- Standing computation incorporates flag history alongside positive attestations
- Governance weight for flag evaluation follows the Cultural DID model — weighted by contribution, corrected by inactivity
- Privacy by default — flags don't leak beyond relevant governance scope
- Appeals process — flagged DID can request review by a higher-standing governance body

### Open Questions

- Who has flagging rights? Only Established DIDs? Or can Preliminary DIDs flag too (with lower weight)?
- How does cross-community flagging work? Does a flag in Cultural DID A affect standing in Cultural DID B?
- What's the decay rate on flags? Do Yellow flags expire after N months of clean behavior?
- How do we prevent coordinated flagging attacks (brigading)?
- Should there be a "voucher score" — a visible track record of how your vouched people have performed?

---

## 3. The Commons Layer — Community-Anchored Identity Issuance

**Author:** Greg Mulholland
**Date:** March 2026
**Related upstream:** #271 (Progressive Trust Model), #247 (Cultural DID), #249 (Plugin Architecture), Discussion #269 (MJN Token Economics / Foundation)
**Addresses:** Outstanding Concerns: Governance Equity (by expanding who can issue identity)

### The Insight

Imajin's EventDID check-in model is, structurally, a **community-anchored identity issuance network**. A person scans a ticket, passes an ID check, receives a DID. The physical body is the proof of work. This generalizes: the gate is any verifiable in-person interaction at a trusted institution.

| Institution | Issuance Context |
|-------------|-----------------|
| Imajin events | EventDID check-in (exists today) |
| Libraries | Library card issuance → DID |
| Credit unions | Account opening → DID |
| Community orgs | Membership verification → DID |
| Medical practices | Patient verification → DID |
| Schools/universities | Student verification → DID |

Each institution becomes an issuance point. The DID they issue carries an attestation: "verified in-person by [institution DID] on [date]." Cross-institution trust: a DID issued at a library carries weight at a credit union because both are on the same trust network.

### How This Maps to Existing Architecture

**What already exists:**
- Ed25519 keypair identity — no platform issues it, no platform can revoke it
- EventDID — events as first-class identity-issuing entities
- Federated nodes — anyone can run a node (`registry.imajin.ai`)
- MJN Foundation (planned) — protocol stewardship separate from Imajin Inc.

**What this adds:**
- Institutional DID type — a new DID category for trusted issuance points, or an Org DID with issuance attestation rights
- Issuance attestations — "DID X was verified in-person by Institution Y" as a first-class attestation type
- Issuance point registry — how institutions register as trusted issuers (likely through the federated node model)

### Imajin Protocol vs. Imajin Product

| | Imajin Protocol (Foundation) | Imajin Product (Inc.) |
|---|---|---|
| Owns | DID spec, trust primitives, settlement protocol | Reference implementation, UX, community tools |
| Governed by | Foundation board, weighted by community contribution | Imajin Inc. (Canadian corp) |
| Revenue | Protocol fees (mint/burn spread, settlement micro-fees) | Operator excellence, premium features, node hosting |
| Analogy | HTML/HTTP | Netscape/Chrome |

The protocol is a public good. The product competes on operator excellence. Open protocol makes the product more valuable because the network is larger.

### Why This Matters

There is currently no public option for digital identity. Every major system (Google, Apple, Meta) extracts value from the identity it holds hostage. Government IDs have no digital-native form in most jurisdictions.

A community-anchored issuance network means:
- Identity doesn't require a smartphone with a proprietary OS
- Identity doesn't require an advertising account
- Identity doesn't require a government to issue it
- Identity requires a trusted human to verify that a body exists — and cryptographically record that verification

### Open Questions

- How do institutions register as issuance points? Through the federated node model, or a separate registration path?
- What level of verification is required? Government ID check? Or is institutional trust sufficient?
- How does this interact with MJN Foundation governance? Does the Foundation certify issuance points?
- Timeline: Year 1 (product), Year 2 (protocol), or Year 3 (public infrastructure)?

---

## 4. Embedded Wallet — DID Keypair as MJN-Scoped Solana Wallet

**Author:** Ryan Veteze and Jin (discovered architecturally, March 9, 2026)
**Related upstream:** #268 (Embedded Wallet), MJN whitepaper v0.2
**Addresses:** Outstanding Concerns: .fair attribution integrity (on-chain anchoring), Social graph portability (key rotation model)

### The Discovery

Imajin chose Ed25519 for DID keypairs because it was the right primitive for sovereign identity. Solana uses Ed25519 for wallet addresses. On March 9, 2026, during a conversation about whether users would need external wallet apps for MJN, the realization: **they already have wallets**. Every DID keypair is a valid Solana keypair. Every backup file already contains a wallet private key. Every registered identity — ~25 hard DIDs, ~48 soft DIDs at that time — is one derivation away from holding MJN tokens.

Nobody planned this. The architecture planned itself.

### Design Principles

**MJN-Scoped Only**
The embedded wallet transacts MJN tokens only. Not general-purpose Solana. Not SPL tokens. Not DeFi. A settlement instrument, not a trading platform. A compromised key can only affect the MJN balance — no bridge exploits, no DeFi drainage. Blast radius is structurally contained.

**Identity IS the Wallet**
Registration generates a keypair → DID + wallet address in one step. No external wallet app required. Client-side signing — private key never touches the server.

**Gas Subsidization**
Solana transactions cost ~$0.001. The MJN Foundation operates a gas pool that covers transaction fees for MJN settlements. Users never think about SOL or gas.

### Hierarchical Key Derivation

The master DID keypair is the root identity. Child keys are derived for scoped purposes:

| Key | Scope | Revocable | Example |
|-----|-------|-----------|---------|
| Master | Full identity + wallet | No (IS the identity) | `did:imajin:ryan` |
| Spending | Daily transactions, capped balance | Yes, by master | `did:imajin:ryan/spending` |
| Savings | Long-term holdings, cold | Yes, by master | `did:imajin:ryan/savings` |
| Delegation | Agent/service can spend within limits | Yes, by master | `did:imajin:ryan/delegate/jin` |
| App Session | Scoped to one service, time-limited | Yes, by master or expiry | `did:imajin:ryan/session/events` |

### Per-Primitive Wallet Behavior

| Identity Type | Wallet Governance |
|---------------|------------------|
| Individual | Personal hierarchy (spending, savings, delegation). Full autonomy. |
| Family | Shared treasury — multi-sig between family member DIDs. Allowance keys for dependents. |
| Cultural | Quorum-signed treasury — governed by trust-weighted membership. Contribution payouts follow .fair governance weights. No single member can unilaterally move funds. |
| Org | Corporate spending authority with delegation hierarchy. Employee expense keys with per-transaction limits. Founder can revoke any delegated key. |

### Settlement Integration

**.fair → On-Chain Settlement**
When a .fair manifest triggers a payment:
1. Consumer's spending key signs the transaction
2. Transaction splits per .fair contributor shares
3. Each contributor's wallet receives their share directly
4. Settlement is atomic — all splits execute or none do
5. The .fair manifest hash is recorded on-chain as provenance

**Trust-Gated Inference Payments**
When someone queries a presence through the trust graph:
1. Querier's spending key signs inference fee
2. Fee routes to knowledge leader's wallet
3. If the leader is part of a Cultural DID, the fee splits per governance weight
4. All on-chain, all auditable, all following the identity graph

### Implementation Phases

**Phase 1 — Surface the Wallet:** Derive Solana address from existing DID keypair. Display wallet address and MJN balance on profile. No transactions — just visibility.

**Phase 2 — Receive MJN:** Wallet can receive MJN tokens. Balance display in pay service. Transaction history.

**Phase 3 — On-Chain Settlement:** Client-side transaction signing in pay service. .fair settlements execute on Solana. Gas subsidized by Foundation pool. Spending key derivation.

**Phase 4 — Hierarchical Keys:** Key derivation UI. Per-primitive governance (Family multi-sig, Cultural quorum, Org delegation). Revocation and rotation. Optional export to external wallets.

### Key Rotation (Social Recovery)

If a master key is compromised, the trust graph provides social recovery:
1. N trusted connections attest to a new keypair
2. Attestations carry the weight of the attesting DIDs
3. Once threshold is met, the new keypair inherits the DID
4. Old key is revoked network-wide
5. MJN balance transfers to new wallet address

### Dependencies

- MJN token on Solana mainnet (exists: `12rXuUVzC71zoLrqVa3JYGRiXkKrezQLXB7gKkfq9AjK`)
- Pay service pluggable backend architecture (exists)
- Ed25519 keypair generation (exists: `@imajin/auth`)
- Trust graph for social recovery (exists: connections service)
- .fair attribution manifests (exists: `@imajin/fair`)

### Open Questions

- Key derivation scheme — BIP-44 style paths or custom derivation?
- Soft DIDs — do `did:email:` soft DIDs get wallet addresses? Probably not until upgrade to hard DID.
- Multi-device — spending key on phone, master key in cold storage. UX?
- Regulatory — does an embedded wallet trigger money transmitter requirements?
- Gas pool economics — how is the Foundation gas pool funded?
- Social recovery threshold — how many attestations, at what trust weight, to rotate a master key?
- Child key limits — how are spending caps enforced? On-chain program or client-side?

---

## 5. BaggageDID — Portable Social Context on Node Exit

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/social-graph-portability.md`
**Related upstream:** RFC-001 (`docs/rfcs/RFC-001-identity-portability.md`), Discussion #255 (Sovereign User Data)
**Addresses:** Social Graph Portability (Critical), supplements RFC-001 at the departure event specifically

### Executive Summary

RFC-001 correctly identifies that key portability and social graph portability are different problems. This proposal addresses the gap at the moment of node departure — the specific transition event where the current architecture drops accumulated social context.

The BaggageDID is a signed, encrypted identity artifact issued to a personalDID when they leave a node — whether through inactivity, voluntary removal, dissolution of a culturalDID node, or behavioural removal. It carries a privacy-preserving summary of the departing member's trust graph history and token context without exposing the private data of any other DID in the network.

When the personalDID applies to join a new node, they can optionally present their BaggageDID. The new node receives only what it needs to make a trust-seeding decision — without accessing the underlying private relationships that generated that context.

### The Problem This Solves

**Exit Cost Undermines Accountability**

Greg's framing from the social-graph-portability thread is the right lens: exit cost determines operator accountability. The current architecture has a hidden asymmetry — cryptographic key portability is solid, but social context is node-local. A personalDID who leaves a node takes their keypair and starts over socially.

This creates structural lock-in. Users stay not because the node serves them well, but because departure means losing years of accumulated trust relationships. The exit threat stops being credible, and with it, operator accountability weakens.

**The Departure Event Is Underspecified**

RFC-001 proposes an Identity Context Package and an append log as canonical truth layer. Both are sound architectural directions for long-term portability. But neither addresses the specific departure event with precision. When a node dissolves a culturalDID, or removes a personalDID for inactivity, or a member chooses to leave — what actually happens to that member's accumulated context right now?

Currently: nothing portable is generated. The trust graph stays in Postgres on the originating node, inaccessible to the departing member and invisible to any future node they join. The BaggageDID is the missing piece at that moment.

### The BaggageDID: Core Concept

A BaggageDID is a signed, self-contained identity artifact — a structured encrypted document issued by the originating node to a departing personalDID at the moment of their exit. It is not a live credential or a DID Document in the W3C sense. It is better understood as a **sealed context envelope**: portable, privacy-preserving, and presenter-controlled.

**Two-layer structure:**

**Public summary layer** (legible to receiving node upon presentation):
- Departure classification: voluntary, inactivity, culturalDID dissolution, behavioural removal
- Aggregate trust tier reached on originating node (e.g., tier 3 of 5) — no relationship detail
- Token context summary: latent token accumulation expressed as a normalized score, not raw transactions
- Node type and scale class of originating node (community node, cultural node, org node)
- Attestation count: number of attestations received, without revealing content or authors
- Duration of active membership (months)
- Departure timestamp and originating node's DID signature

**Encrypted context layer** (decryptable only by the personalDID, or with their explicit key grant):
- Full pod membership history with roles and timestamps
- Trust graph edges (co-memberships, invite chain)
- Full token context history
- Any behavioural flags with associated context, encrypted under the personalDID's key

**What It Does Not Contain** (critical constraint for network sovereignty):
- No private data from other personalDIDs
- No content of conversations, attestations, or transactions
- No identification of specific trust relationships (who vouched for whom)
- No culturalDID internal records or orgDID transaction details
- No data that would allow a new node to reconstruct the originating node's social graph

### Departure Classification and BaggageDID Behaviour

| Departure Type | BaggageDID Config | Receiving Node Handling |
|----------------|-------------------|------------------------|
| Voluntary | Full summary, full encrypted context | Standard trust seeding — member in good standing |
| Inactivity | Full summary, encrypted context, inactivity duration flagged | Throttled trust growth rate (can be opacity-applied) |
| CulturalDID dissolution | Full summary for all active members before teardown | Treated as voluntary — neutral event |
| Behavioural removal | Summary with flag tier noted, encrypted flag detail | Receiving node may apply restricted onboarding path |

### Receiving Node: Presentation and Trust Seeding

Presentation is always the personalDID's choice. A member can join any node without presenting their BaggageDID, starting with zero context — the same baseline as any new member today.

Presentation is a signal of intent. By submitting the BaggageDID as part of a node application, the personalDID explicitly accepts a degree of context sharing in exchange for recognition of prior experience.

| Receiving Node Decision | Trigger Condition |
|------------------------|-------------------|
| Full recognition / accelerated onboarding | Voluntary departure, high tier, clean history |
| Standard onboarding with context credit | Voluntary or dissolution, mid tier |
| Throttled growth rate (applied silently) | Inactivity removal |
| Restricted onboarding path | Behavioural removal with unresolved flags |

**Note on opacity:** For inactivity removal, the receiving node can apply a reduced trust growth rate without making this visible to the personalDID. The member experiences onboarding that feels normal but progresses slightly slower. Ryan should weigh in on whether this opacity is desirable — opacity protects members from unnecessary stigma, transparency gives them agency to understand and adjust their standing.

### Privacy Architecture and Network Sovereignty

The BaggageDID follows the same one-way interaction model already used in personalDID–orgDID transactions: the system records that an interaction occurred without exposing private data about it. The originating node signs the public summary — verifiable by any receiving node — but the signature attests only to aggregate context, not to any individual relationship within it.

The encrypted layer serves the personalDID's long-term interests, not the receiving node's verification needs. It is their private history, under their key, which they can choose to share with specific parties (a node operator they deeply trust, a future service they authorize). This maps to RFC-001's Identity Context Package concept.

### Relationship to RFC-001 and Discussion #255

| | BaggageDID | RFC-001 | Discussion #255 |
|---|---|---|---|
| Scope | Departure event specifically | Full portability architecture | Append log + export API |
| Timing | Issued at exit | On-demand export | Continuous append |
| Prerequisite | Departure trigger points in connections service | Full context packaging | Per-service export interface |
| Relationship | Complement — near-term implementation | Long-term portability stack | Canonical truth model |

The BaggageDID can be implemented before RFC-001 Tier 2 is complete. It requires only an `exportForDid` function scoped to the departure flow, plus a defined schema for the signed context envelope.

### Implementation Path

**Four new components:**

1. `departureSummary(did, departureType)` in connections service — aggregates tier, attestation count, token score, duration; no individual relationship data in output

2. `encryptContextForDid(did)` — serializes full trust graph context under the personalDID's public key; leverages existing `pod_keys` E2EE infrastructure

3. `issueBaggageDID(did, departureType)` — combines public summary and encrypted context into a signed envelope; node signs with its DID keypair; output is a portable JSON document delivered to the personalDID

4. `verifyAndSeedBaggageDID(baggageDid)` — receiving node ingestion; verifies issuing node signature; parses public summary layer; exposes departure type, tier summary, and token context score to node operator trust-seeding logic

**Departure trigger points** (auto-issue at each):
- Voluntary removal — existing `pod_members` removal flow (`removedAt` soft delete trigger)
- Inactivity removal — wherever inactivity policy executes member removal
- CulturalDID dissolution — node dissolution event, issued to all active members before teardown
- Behavioural removal — moderation action resulting in `pod_members` removal

**Detecting resolution in the repo:**
- New `issueBaggageDID` function in `packages/trust-graph` or connections service
- New `departureSummary` query in trust-graph package
- New `departure_type` field on `pod_members` removal events
- New endpoint `POST /api/identity/baggage-import` in auth or connections service
- Email notification trigger on member removal events

### Open Questions for Ryan

- Should the BaggageDID be auto-issued on all departure types, or only on voluntary and dissolution departures?
- Should the personalDID be notified that a BaggageDID has been generated and is available for download?
- Is opacity on inactivity-throttled trust growth acceptable, or does the platform philosophy require transparency?
- Does the originating node retain a copy of the issued BaggageDID? If yes, for how long?
- Can a personalDID request re-issuance of their BaggageDID after departure (e.g., they lost the original)?
- Should receiving nodes be able to query whether a DID has an outstanding BaggageDID without the DID presenting it?

---

## 6. .fair Attribution Integrity — Cryptographic Signing for Automated Node Settlement

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/fair-attribution-automated-nodes.md`
**Related upstream:** `packages/fair/`, Discussion #268 (Embedded Wallet), MJN whitepaper v0.2
**Addresses:** .fair Attribution Integrity for Automated Nodes (Critical)

### Executive Summary

The whitepaper positions .fair as a required protocol primitive. A protocol primitive that can be self-declared by any node, without verification, is not a primitive — it is a convention. Conventions break under adversarial conditions. Cryptographic signing does not.

### The Problem in Detail

**What .fair manifests are today:**

Any service can call `createManifest({ owner: "did:imajin:ryan", attribution: [...] })` and receive a structurally valid manifest. The system cannot distinguish this from a manifest actually authorized by `did:imajin:ryan`. There is no signature. There is no proof. Validation checks structure and arithmetic — share totals, required fields, type correctness. It does not verify that the declared owner authorized the manifest.

**Why Stream 3 makes this critical:**

For human-initiated transactions, social accountability and UI friction provide sufficient integrity. A human reviewing and submitting a manifest is an implicit consent signal. Stream 3 eliminates that signal entirely. When one agent calls another autonomously — a Cultural DID treasury executing a distribution, a node-to-node data exchange, an inference gateway settling compute — the manifest is written by software and settled by software. There is no human review step.

**What on-chain anchoring does and does not solve:**

The Embedded Wallet RFC introduces on-chain manifest hash anchoring. This is meaningful progress — if the hash is recorded at settlement, the manifest becomes tamper-evident after the fact. But it does not solve origination. The hash proves the manifest was not modified after settlement. It does not prove the manifest was authorized by the named owner before settlement. A fraudulent manifest anchored on-chain is a fraudulent manifest with a permanent record.

### Proposed Resolution

**Architectural direction:** .fair manifests become signed protocol messages — the same pattern applied to every other MJN exchange. The manifest owner DID signs the manifest with their private key. Any recipient can verify the signature against the DID's public key. Unsigned manifests are rejected at the settlement layer.

**Minimum viable implementation — four concrete changes:**

| Change | Location | Description |
|--------|----------|-------------|
| Add `signature` field | `packages/fair/src/types.ts` | `{ algorithm: 'ed25519', value: string, publicKeyRef: string }` |
| Add `sign(manifest, privateKey)` | `packages/fair/src/index.ts` | Returns `SignedFairManifest` |
| Add `verifyManifest(manifest)` | `packages/fair/src/index.ts` | Checks signature against `owner` DID's public key |
| Enforce at settlement | `apps/pay/` settlement routes | Reject unsigned or invalid-signature manifests |

**Automated node authorization model:**
- Agent DIDs are child keys derived from parent human or organizational DIDs (hierarchical key model from Embedded Wallet RFC)
- Agent manifests are signed by the agent's own DID keypair
- The agent DID's derivation encodes authority scope — what attributions the agent is permitted to declare
- Out-of-scope attributions fail at the signing step — the agent's key does not carry that authority and cannot produce a valid signature for that claim

### Open Questions: Greg's Position

**Q1 — Unsigned manifests: reject or treat as provisional?**

Position: reject. A manifest that cannot be verified is not a .fair manifest — it is an attribution claim. The settlement layer should treat them as invalid. Migration of existing unsigned manifests is handled separately (see Q4).

**Q2 — Multi-contributor signing: owner only, or all contributors?**

Position: owner-only for MVP; migrate to multi-party later. Multi-party signing requires an async signing flow (manifest created → distributed to contributors for signature → settleable only once all signatures collected). This is meaningful additional complexity. Ryan should weigh whether MVP launches with owner-only signing.

**Q3 — Cultural DID treasury signing:**

Two approaches:
- **Quorum signature (N-of-M):** Distribution manifests require signatures from N Governing Members. Most cryptographically rigorous. Adds coordination requirement.
- **Designated treasury key:** Cultural DID generates a treasury child key. A quorum vote authorizes the treasury key to sign. Simpler operationally; the governance is in the key authorization, not in each signing act.

Position: designated treasury key with quorum authorization. Cleaner UX, governance burden at key creation rather than at each distribution.

**Q4 — Retroactive signing: migration path for existing manifests:**

Position: legacy manifests are tagged as `{ signed: false, legacy: true }` and excluded from signature verification. All new manifests from the signing enforcement date require signatures. This avoids migration deadlock (asking all historical manifest owners to retroactively sign is operationally infeasible) while maintaining a clear boundary.

**Q5 — Agent authority scope: key derivation:**

Position: scope must be encoded in the agent DID's derivation path. An agent DID derived as `did:imajin:ryan/delegate/jin` carries Ryan's authority for delegated actions within Jin's scope. This requires the Embedded Wallet RFC's hierarchical key model to support scope encoding in derivation paths — if that is not currently planned, it becomes a dependency before Stream 3 can launch with full attribution integrity.

### Decisions Required from Ryan

| Decision | Options | Blocking? |
|----------|---------|-----------|
| Unsigned manifests | Reject / treat as provisional | Yes — determines enforcement model |
| Multi-contributor signing | Owner-only MVP / full multi-party | Yes — determines manifest signing flow |
| Cultural DID treasury | Quorum signature / designated treasury key | Yes — determines Cultural DID settlement model |
| Retroactive migration | Legacy tag / retroactive signing | Yes — determines migration scope |
| Agent scope encoding | Key derivation / permission system | Yes for Stream 3 — determines agent authorization model |

---

## 7. Cryptographic Trust Layer — Unified Architecture

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/attestation-data-layer.md`
**Related upstream:** RFC-001, Discussion #255, #268 (Embedded Wallet), #271 (Progressive Trust), #273 (Trust Accountability)
**Addresses:** Attestation Data Layer (Flagged, blocks multiple proposals); synthesizes Proposals 5 and 6

### Executive Summary

Three active proposals — Progressive Trust Model, Trust Accountability Framework, and Cultural DID governance — share a foundational dependency that does not yet exist: a cryptographic identity attestation layer. The existing codebase uses the word 'attestation' for build integrity proofs of node software. Identity attestations — signed, typed records of meaningful social acts between DIDs — are architecturally absent.

This proposal argues for a more fundamental reframe: cryptographic signing should not begin at the BaggageDID (departure event) or at .fair manifests (settlement). It should begin at the first meaningful interaction between a node and a personalDID. Every trust-relevant act — onboarding, vouching, attendance, flag, attribution — should be a cryptographically signed record from the moment it occurs. The BaggageDID then becomes a natural output of that layer, not a patch on top of it.

### 1. The Semantic Collision in the Current Codebase

The word 'attestation' currently refers exclusively to build integrity (`packages/auth/src/types/node.ts`):

```typescript
export interface NodeAttestation {
  nodeId: string;
  buildHash: string;      // SHA256 hash of running binary
  sourceCommit: string;
  version: string;
  signature: string;      // Ed25519 signature over all fields
}
```

This is a machine-verifiable integrity proof: a node proving it runs approved software. It has nothing to do with trust relationships between people.

The Progressive Trust Model states: *"Standing is computed, not assigned. It's a query over attestation history on `auth.identities`."* But `auth.identities` has no attestation fields.

The good news: the NodeAttestation architecture is an excellent design template — signed, typed, timestamped, registry-stored, verified. The same pattern applied at the identity layer is exactly what's needed. The design work at the infrastructure level is already done.

### 2. The Proposed Reframe: Trust Signing Starts at Onboarding

The BaggageDID (Proposal 5) correctly identifies that social context portability is a different problem from key portability, and introduces a privacy-preserving departure artifact. This proposal endorses the BaggageDID architecture — but argues that its cryptographic model should start higher up the chain.

The BaggageDID as proposed is issued at departure — a retrospective summary compiled at exit. If the underlying history is a collection of unsigned database records, the signed BaggageDID summary is **attestation-laundering**: converting unsigned social history into a signed artifact at the last possible moment, producing a cryptographic claim whose inputs were never cryptographically verified.

**The correct model: every trust-relevant act is signed when it occurs.**

#### 2.1 The Node–PersonalDID Relationship as the Cryptographic Root

When a personalDID joins a node, a bilateral relationship is established. That relationship should be initialized with a signed record — the equivalent of a mutual handshake: the node signs a record that this DID has joined, and the personalDID signs acceptance. This root record becomes the cryptographic anchor for all subsequent attestations within that relationship.

From this root, every trust-relevant act is a child attestation — signed by the issuer DID, referencing the root relationship, storing only what is necessary for standing computation while encrypting relationship-sensitive detail under the personalDID's key.

#### 2.2 Privacy Architecture: What the Node Sees vs. What It Knows

| Layer | Contents | Who Can Read |
|-------|----------|-------------|
| Public attestation record | Type, issuer DID, subject DID, timestamp, signature, aggregate metadata | Node operator, governance, network queries |
| Encrypted payload | Narrative context, relationship detail, flag content | personalDID only (or explicit key grants) |

This resolves the node-operator-as-surveillance-vector problem. The node operator has enough information to compute standing and enforce governance. They do not have access to the narrative content of individual relationships. That content belongs to the personalDID — encrypted under their key, portable with them on exit.

### 3. The Identity Attestation Data Layer

**Schema** (following the NodeAttestation pattern):

```sql
CREATE TABLE auth.attestations (
  id           TEXT PRIMARY KEY,           -- att_xxx
  issuer_did   TEXT NOT NULL,              -- who signed it
  subject_did  TEXT NOT NULL,              -- who it's about
  type         TEXT NOT NULL,              -- controlled vocabulary
  context_id   TEXT,                       -- event/org/interaction DID or ID
  context_type TEXT,                       -- 'event' | 'org' | 'interaction' | 'system'
  payload      JSONB DEFAULT '{}',         -- type-specific public metadata
  encrypted_payload TEXT,                  -- narrative detail, encrypted under subject_did key
  signature    TEXT NOT NULL,              -- Ed25519 by issuer_did
  issued_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,                -- optional decay (for time-limited flags)
  revoked_at   TIMESTAMPTZ                 -- nullable, for revocation
);
```

#### 3.1 Controlled Attestation Type Vocabulary

| Type | Issuer | Description |
|------|--------|-------------|
| `node.join` | Node DID | personalDID joined this node (root record) |
| `node.join.accepted` | personalDID | personalDID accepts node join (bilateral root) |
| `event.attendance` | EventDID | Verified physical presence at event |
| `vouch.given` | Established DID | Sponsors a Preliminary DID's onboarding |
| `vouch.received` | System | Acknowledgment of vouch acceptance |
| `checkin.verified` | Org DID | Physical presence at org location |
| `interaction.verified` | System | Completed meaningful exchange with Established DID |
| `milestone.completed` | System | Onboarding milestone reached |
| `flag.yellow` | Established DID / governance | Low-severity flag |
| `flag.amber` | Governance body | Moderate-severity flag |
| `flag.red` | Governance body | Severe flag |
| `flag.cleared` | Governance body | Flag resolved |
| `vouch.outcome.positive` | System | Vouched person completed onboarding successfully |
| `vouch.outcome.negative` | System | Vouched person was flagged or removed |

#### 3.2 Standing Computation

Standing is a computed view over the attestations table — not a stored field:

```
standing(did) = f(
  positive_attestations(did),   // weighted sum by type and recency
  negative_attestations(did),   // flags, weighted by tier
  trust_graph_depth(did),       // BFS depth from trust-graph package
  fair_contribution_count(did), // .fair manifests where did appears
  activity_recency(did)         // decay function on last attestation timestamp
)
```

Tier thresholds:
- Soft DID (Visitor): no attestations required
- Hard DID Preliminary (Resident): keypair registration
- Hard DID Established (Host): `standing(did) >= ESTABLISHED_THRESHOLD` (value to be set by governance)

### 4. The BaggageDID as a Natural Output

With the attestation layer in place, the BaggageDID (Proposal 5) becomes architecturally coherent:

| Without attestation layer | With attestation layer |
|--------------------------|----------------------|
| BaggageDID summarizes unsigned DB records | BaggageDID aggregates already-signed attestation records |
| Cryptographic claim with unverified inputs | Cryptographic claim with verified, signed inputs |
| Integrity is asserted | Integrity is provable |

The presenter-control model is fully preserved and strengthened. Because the attestation payloads are encrypted under the personalDID's key, the originating node cannot reconstruct the BaggageDID's encrypted layer after the personalDID has left. The data belongs to the person, not the node.

### 5. .fair Attribution Integrity: The Same Root

The .fair signing proposal (Proposal 6) identifies that `FairManifest` objects are currently unsigned. The fix — cryptographic signing with Ed25519, settlement enforcement rejecting unsigned manifests — is correct and urgent.

The strongest articulation in Proposal 6 applies with equal force here:

> *"A protocol primitive that can be self-declared by any node, without verification, is not a primitive — it is a convention. Conventions break under adversarial conditions. Cryptographic signing does not."*

The attestation data layer must include a verification gate at ingestion — unsigned or unverifiable attestations should be rejected, not merely stored with a null signature field.

#### 5.1 Agent DIDs: A New Actor Type Not Yet Accounted For

The .fair proposal introduces agent DIDs — child keys derived from parent human or organizational DIDs, with authority scope encoded in the key derivation path. The attestation data layer as currently specified does not account for non-human DID actors. Before the attestation schema is finalized:

| Question | Required Answer |
|----------|----------------|
| Can an agent DID issue attestations? | Yes/No — determines whether automated check-ins and event attendance records are valid |
| What is an agent DID's attestation authority scope? | Derived from parent DID? Explicitly delegated? |
| Can an agent DID receive attestations (be vouched for, flagged)? | Determines whether agents have standing in the trust graph |
| How are agent attestations distinguished from human attestations? | Type field? Separate issuer class? |

### 6. What This Unblocks

| Proposal | Blocked By | Unblocked When |
|----------|-----------|----------------|
| Progressive Trust Model | No attestation table | auth.attestations + standing computation |
| Trust Accountability Framework | No flag storage | auth.attestations with flag types |
| Cultural DID governance | No token context computation | Standing computation over attestations |
| BaggageDID (Proposal 5) | Unsigned history | Attestation layer + encrypted payloads |
| .fair signing (Proposal 6) | No signing infrastructure | @imajin/auth sign/verify utilities |
| Social recovery (Embedded Wallet) | No trust graph attestations | Attestation layer operational |

### 7. Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Should `auth.attestations` live in the `auth` schema or a new `trust` schema? | Determines service ownership and cross-service access patterns | New `trust` schema — semantically distinct from identity primitives |
| Is the bilateral root record (node + personalDID both sign) required for MVP, or deferred? | Bilateral root is the cleanest model; unilateral is simpler to ship | Bilateral, even in MVP — it's one extra signature on join |
| Who can issue `interaction.verified` attestations — system only, or also peer DIDs? | If peer-issued, social gaming becomes possible; if system-only, interaction verification requires server-side logic | System-issued, triggered by both parties completing a defined interaction (e.g., message exchange with response) |
| Does standing computation run on every session check, or is it cached? | Performance concern at scale | Cached with TTL (e.g., 5 minutes), invalidated on new attestation |
| Should flags be a subtype of attestation, or a separate table? | Flags have different privacy and governance requirements | Subtype of attestation — same signing model, different access control on encrypted payload |
| Can a personalDID revoke an attestation they issued (e.g., a vouch for someone they no longer trust)? | Vouch revocation before onboarding completion — should it be possible? | Yes for vouch revocation during probation window; no for retroactive revocation after onboarding completes |

### 8. Implementation Path

**Phase 1 — Foundation** (unblocks all dependent proposals):
- New migration: `auth.attestations` table
- Controlled type vocabulary defined and documented
- Signing utilities in `@imajin/auth`: `sign(attestation, privateKey)` and `verify(attestation)`
- Ingestion enforcement: unsigned attestations rejected at write
- Standing computation view or function over `auth.attestations`
- Onboarding root record: bilateral signed record on personalDID join

**Phase 2 — BaggageDID integration**:
- `departureSummary(did, departureType)`: authenticated aggregate query over `auth.attestations`
- Encrypted context layer: export of attestation payloads under personalDID key
- `issueBaggageDID(did, departureType)`: signed departure artifact generation
- `departure_type` field on `pod_members` removal events
- `verifyAndSeedBaggageDID(baggageDid)`: receiving node ingestion and trust seeding

**Phase 3 — .fair and Stream 3**:
- `FairManifest` gains `signature` field
- `@imajin/fair` exports `sign(manifest, privateKey)` and `verifyManifest(manifest)`
- Settlement routes reject unsigned or invalid-signature manifests
- Agent DID attestation scope defined and encoded in key derivation (per Ryan's decision on Q5 in Proposal 6)
- Stream 3 does not go live until Phase 1 signing enforcement is deployed

**Detecting resolution in the repo:**
- New migration adding `auth.attestations` (or `trust.attestations`)
- `@imajin/auth` exports `signAttestation` and `verifyAttestation`
- Standing computation function in auth service
- Onboarding flow creates bilateral root record
- Any commit referencing "attestation layer" or "identity attestation" (distinct from build attestation)

---

## 8. Attestation Data Layer — Full Architecture Review

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/attestation-data-layer.md`
**Extends:** Proposal 7 (Cryptographic Trust Layer) — adds risks and distinctions not covered there
**Related upstream:** Discussion #271 (Progressive Trust), #273 (Trust Accountability), RFC-001

### Executive Summary

Three active proposals — Progressive Trust Model, Trust Accountability Framework, and Cultural DID governance — share a foundational dependency that does not yet exist: a cryptographic identity attestation layer. The word 'attestation' appears throughout these proposals as if a shared implementation exists. It does not. The existing codebase uses it exclusively for build integrity proofs for nodes — a categorically different concept.

This document diagnoses the gap precisely, proposes a schema and architecture, and surfaces design decisions requiring Ryan's explicit input before implementation can proceed.

The core architectural argument: cryptographic signing should not begin at the departure event (BaggageDID) or at settlement (.fair manifests). It should originate at the first meaningful interaction between a node and a personalDID — the onboarding root. Every trust-relevant act that follows is a signed child of that relationship.

### 1. The Naming Collision

**What exists in the codebase:** `NodeAttestation` (`packages/auth/src/types/node.ts`) is a build integrity mechanism — a node proving it runs approved software. It has nothing to do with trust relationships between people.

**What the proposals need:** Social acts recorded as cryptographic facts — `event.attendance`, `vouch.given`, `checkin.verified`, `flag.yellow`. Fundamentally different.

**The opportunity:** The `NodeAttestation` architecture is an excellent design template — signed, typed, timestamped, registry-stored. The same pattern applied to identity trust acts is exactly what is needed. The infrastructure-level design is already done.

### 2. The Architectural Reframe: Sign at the Root

If the underlying attestation history is a collection of unsigned database records, a signed BaggageDID summary is **attestation-laundering** — converting unsigned social history into a signed artifact at the last possible moment.

**The correct model:** When a personalDID joins a node, a bilateral root record is signed by both parties. This becomes the cryptographic anchor for all subsequent attestations within that relationship. Every attestation references the root record — the trust history is anchored, not floating free.

#### Privacy Architecture

| Layer | Contents | Who Can Read |
|-------|----------|-------------|
| Public attestation record | Type, issuer DID, subject DID, timestamp, signature, aggregate metadata | Node operator, governance, network queries |
| Encrypted payload | Narrative context, relationship detail, flag content | personalDID only (or explicit key grants) |

This resolves the node-operator-as-surveillance-vector problem. The node has what it needs to compute standing; it does not have access to the narrative content of individual relationships.

### 3. Schema and Vocabulary

See Proposal 7 §3 for the complete `auth.attestations` schema and controlled attestation type vocabulary. This proposal adds two important distinctions:

**Community vs. cross-node standing:** The schema enables two distinct queries — standing within a specific node vs. aggregate standing across nodes. Without this distinction, standing collapses into a global aggregate that ignores whether trust was earned in one tight-knit community or spread across many.

**Legacy seed attestations:** Existing data — ticket purchases, invite records, pod membership history — can seed initial attestations as `legacy.seed` type. This introduces a permanent data quality distinction that must be handled explicitly in standing computation.

**Verification gate at ingestion:** `signature TEXT NOT NULL` in the schema is insufficient — a non-null string satisfies the constraint regardless of validity. The `POST /api/attestations` endpoint must verify the Ed25519 signature against the issuer DID's public key before writing. Invalid signatures must be rejected with a 4xx, not stored.

### 4. Two Unaddressed Risks

#### 4.1 Node Dark — Orphaned Attestation History

If attestations are stored exclusively in Postgres on a node operator's infrastructure, a node going dark could orphan years of attestation history. Three options:

1. BaggageDID as the only protection (current direction — members who departed before the node went dark are unaffected; members who didn't depart lose their history)
2. Continuous attestation export to a backup node or personalDID-controlled store
3. Personalised attestation log maintained alongside the BaggageDID — each personalDID holds a running copy of their own attestation record

**Ryan should choose a position** before the attestation schema is finalized. Option 3 is most consistent with the sovereignty model.

#### 4.2 Cascading Revocation When an Issuer DID Is Compromised

If a prolific voucher's DID is compromised and revoked, all attestations they issued are suddenly suspect. Two options:

- **Hard cascade:** Revocation triggers retroactive standing recalculation for all subjects. Correct but potentially disruptive — many Established DIDs could lose standing simultaneously.
- **Soft decay:** Revoked issuer attestations are down-weighted from the revocation date forward but not retroactively removed. Standing degrades gradually rather than collapses.

**Ryan should make an explicit choice** before the standing computation function is written.

### 5. Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| `auth.attestations` or `trust.attestations`? | Service ownership and access patterns | New `trust` schema — semantically distinct from identity primitives |
| Bilateral root record required for MVP? | Bilateral is cleanest; unilateral is simpler to ship | Bilateral — it's one extra signature on join |
| Who can issue `interaction.verified`? | If peer-issued, social gaming becomes possible | System-issued, triggered by both parties completing a defined interaction |
| Standing computation: on every session check, or cached? | Performance at scale | Cached with TTL (5 minutes), invalidated on new attestation |
| Flags: subtype of attestation, or separate table? | Different privacy and governance requirements | Subtype of attestation — same signing model, different access control |
| Can a personalDID revoke an attestation they issued? | Vouch revocation before onboarding completion | Yes during probation window; no retroactively after onboarding completes |
| Node dark: which protection model? | Attestation history durability | Option 3 — personalDID-held attestation log |
| Cascading revocation: hard or soft? | Standing stability vs. correctness | Soft decay — gradual not catastrophic |
| Can agent DIDs issue and receive attestations? | Required before Stream 3 automated check-ins | Yes — must be explicitly scoped to parent DID authority |

### 6. Implementation Path

See Proposal 7 §8 for the three-phase path. This proposal adds:
- Phase 1 must include payload encryption before any attestations containing sensitive context are written
- Legacy seed migration should run before Phase 1 goes live so historical data counts from day one
- The verification gate at ingestion must be part of Phase 1, not a later hardening phase

**Detecting resolution in the repo:**
- Same signals as Proposal 7, plus:
- `POST /api/attestations` endpoint with signature verification before write
- Legacy seed migration script in `apps/auth/` or `packages/trust-graph/`
- `node_context_id` on attestation records distinguishing community from cross-node standing

---

## 9. Identity Tier Storage — Security Fix and Auth Domain Consolidation

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/identity-tier-storage.md`
**Related upstream:** `apps/auth/app/api/session/route.ts`, `apps/profile/src/db/schema.ts`
**Addresses:** Problems P1 (fail-open default) and P2 (wrong service); Outstanding Concern F2

### Executive Summary

The soft/hard DID tier — the most fundamental access control property after the DID itself — is stored in the profile service, not the auth service. The auth session API crosses a service boundary to retrieve it on every permission check. If that query fails, it defaults to `'hard'` (full access) rather than minimal access. This is a fail-open security posture for an identity-critical property.

In the current single-server deployment, the risk is low. But the platform is building toward federated nodes, a three-tier Progressive Trust Model, key delegation in the Embedded Wallet, and an attestation-based standing computation layer. Each of these compounds the cost of leaving tier in the wrong place.

### 1. Three Compounding Problems in the Current Code

**In `apps/auth/app/api/session/route.ts`:**

1. **Fail-open default:** `session.tier || 'hard'` — falls back to full access, not minimal access (Problem P1)
2. **Silent exception swallow:** the catch block discards the exception without logging — no observability into profile service failures (Problem P4 — new)
3. **Wrong service boundary:** `identity_tier` is an access control property stored and owned by a display service (Problem P2)

**Why shared Postgres mitigates but does not resolve:** Both services currently point at the same Postgres instance, so the cross-schema query is a local join. But 'same Postgres' is an accident of current deployment that future infrastructure changes will invalidate.

### 2. Why This Matters Now — Converging Dependencies

**Progressive Trust Model — the third tier:** If standing is computed from `auth.attestations`, and tier is the access-control output of standing computation, then tier must live in auth — so the computation and its output are in the same service domain.

**BaggageDID — authoritative tier claims:** For the BaggageDID's tier summary to be verifiable, the originating node must sign a tier claim from the service that owns and computed that value. If tier lives in profile, the auth service is signing a claim about a value it doesn't own.

**Attestation layer:** Tier is the access-control output of standing computation. If tier remains in profile, standing computation in auth must write its result across a service boundary into a display service to take effect.

### 3. The Immediate Fix — One Line, No Migration

Change `session.tier || 'hard'` to `session.tier || 'soft'` on line 50 of `apps/auth/app/api/session/route.ts`.

A user experiencing a profile service outage will see reduced permissions rather than elevated ones. The catch block should also log the exception at minimum — silent failure is an observability gap regardless of the fail-default direction.

### 4. Longer-Term Options

**Option A — Move tier to `auth.identities` (Recommended):**
Add a `tier TEXT NOT NULL DEFAULT 'soft'` column directly to `auth.identities`. Migrate existing values from `profile.profiles.identity_tier`. The session route reads from auth only — no cross-schema query, no service boundary crossing.

**Option B — Formalize profile as canonical tier store:**
Keep tier in `profile.profiles`, but replace the silent fail-open pattern with an explicit availability contract — explicit error handling, fail-closed default, and a defined SLA for the profile service as a dependency of auth.

**Option C — Dual write during transition (bridge path):**
Add tier to `auth.identities` immediately, begin dual-writing to both locations, then cut the session route over to read from auth once the dual-write has been running stably. Maintains backward compatibility throughout migration.

Option C allows the fail-closed fix (one line, immediate) to ship independently of the migration.

### 5. The Unified Auth Domain

The correct long-term architecture concentrates every access-control property into the auth service: the DID, the keypair, and the access tier.

**Tier values in the three-tier model:**

| Column Value | Standing Level | Access |
|-------------|----------------|--------|
| `soft` | Visitor (Soft DID) | Attend events, hold tickets |
| `preliminary` | Resident (Hard DID, onboarding) | Full profile, wallet, apps |
| `established` | Host (Hard DID, standing threshold met) | Vouch, govern, full platform |

The `tier` column stores the output of standing computation, not the raw attestation history. Attestations are the evidence; tier is the access decision. This keeps permission checks fast (single column read) while keeping the evidence base rich.

**Tier computation trigger model:**

| Option | Description | Recommendation |
|--------|-------------|----------------|
| On-write trigger | Recompute standing each time a new attestation is written | Cleanest — consistent with attestation layer's integrity model |
| Scheduled recomputation | Batch job recalculates all standing on a schedule | Acceptable; standing may be stale between runs |
| On-demand with cache | Compute on session check, cache with TTL | Performance-friendly; standing lags by cache TTL |

### 6. Recommended Sequencing

1. Change fail-default to `'soft'` immediately (one line, no migration, no dependencies)
2. Add logging to the catch block immediately (one line addition)
3. Add `tier` column to `auth.identities` with dual-write
4. Build `auth.attestations`
5. Implement standing computation
6. Cut session route to read from `auth.identities` only
7. Remove `identity_tier` from `profile.profiles` once migration confirmed

### 7. Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Option A, B, or C for tier migration? | Determines migration scope and timeline | Option C — dual-write bridge path for zero-downtime migration |
| Three-tier column values: `soft/preliminary/established` or `soft/hard.preliminary/hard.established`? | Naming convention for the new standing levels | `soft/preliminary/established` — cleaner, less verbose |
| Tier computation trigger: on-write, scheduled, or on-demand? | Performance vs. consistency tradeoff | On-write trigger for consistency |
| Does the profile service retain `identity_tier` for display purposes after migration? | Profile may need to show tier in the UI | Yes — profile reads from auth as a downstream consumer, not a canonical store |

**Detecting resolution in the repo:**
- `|| 'hard'` no longer appears on line 50 of `apps/auth/app/api/session/route.ts`
- Catch block in session route includes logging
- New migration adding `tier` column to `auth.identities`
- `apps/profile/src/db/schema.ts` removes or deprecates `identity_tier` column

---

## 10. Org DID Vetting and Early-Member Influence

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/org-did-vetting.md`
**Related upstream:** Discussion #253 (Org DID), #248 (Org DID original), #273 (Trust Accountability)
**Addresses:** Outstanding Concern 4 (Vetting and Early-Member Influence)

### Executive Summary

The Org DID proposal correctly identifies that businesses require a structurally distinct identity primitive: typed, publicly transparent, less privileged than Person DIDs, and non-severably anchored to founding Person DIDs so accountability cannot be discarded. The proposed vetting mechanism — covenant as standard, trust-graph attestation as mechanism — is architecturally elegant.

The concern: early members of the network accumulate outsized and compounding influence over which businesses are ever permitted to enter. If the founding community is culturally or economically homogeneous, the vetting mechanism will systematically reflect that homogeneity — not through bad intent, but through the mathematics of trust graph depth and attestation weight.

This proposal presents an integrated **Composite Attestation Model** (Position 4) that draws on the attestation infrastructure to build a vetting system that is decentralized, community-accountable, and structurally resistant to founding-cohort capture.

### 1. The Compounding Dynamic

1. Network launches with a founding community
2. Founding members' attestations determine who becomes Established DIDs
3. Established DIDs vouch for Org DID claims with weight proportional to their standing
4. Founding members have the deepest trust graphs, most connections, highest standing
5. New members have lower attestation weight
6. The founding community's values are structurally embedded in the vetting mechanism

Even if attestation weight decays over time, the covenant document itself may embed founding cohort values. A covenant that explicitly names behavioral disqualifications can be governed fairly. A covenant that implicitly reflects founding cohort aesthetic preferences will exclude legitimate businesses without obvious mechanism for appeal.

### 2. The Founding Person DID Anchor as Accountability Infrastructure

The non-severable link between an Org DID and its founding Person DID(s) is the mechanism that gives Org DID accountability its teeth. Negative attestations on an Org DID propagate a standing penalty to founding Person DIDs. A Person DID that vouches for an Org DID's entry stakes their own standing on that business's future behavior.

A new attestation type is needed to record this relationship: `org.founding` — issued by the system at Org DID creation, recording which Person DIDs are founding anchors.

### 3. Soft-Loading as Pre-Vetting Evidence

The soft-loading model from Discussion #253 inverts standard business onboarding: don't ask businesses to join, let their customers accumulate a presence, then the business claims what their community already built.

**Critical distinction:** `org.checkin.soft` (a Person DID checking in at a location before any claim exists) is fundamentally different from `org.claim.vouch` (a Person DID explicitly endorsing an Org DID claim). A Person DID who checked in at a coffee shop three years ago did not consent to be counted as a vetting endorser. Soft-loading history is evidence of community use — it should **inform** the vetting decision, but must not **substitute** for explicit attestation.

### 4. Position 4 — The Composite Attestation Model (Recommended)

Three positions are available (attestation-only, decay-based, covenant-only). None resolves the problem cleanly. The Composite Attestation Model requires three simultaneous inputs — none of which can be gamed in isolation:

| Input | Mechanism | Capture Resistance |
|-------|-----------|-------------------|
| Person DID attestations | Standing-weighted `org.claim.vouch` from Established DIDs | Gaming requires acquiring Established DID standing first |
| Soft-loading evidence | Count of `org.checkin.soft` attestations from any DID level | Democratic — counts community use regardless of checker-in's standing |
| Covenant compliance declaration | Self-declaration against a behavioral disqualification list | Auditable — tests behaviors, not values |

**How the composite model addresses compounding influence:** Soft-loading attestations are issued by any Person DID — Preliminary or Established. A new member who has been a regular customer generates soft-loading evidence that counts on equal footing with a founding member's check-in. The soft-loading floor is **decoupled from trust graph depth**.

**Proposed claim threshold (example — to be calibrated):**
- Minimum 3 `org.claim.vouch` attestations from Established DIDs (weighted by standing)
- Minimum 15 distinct `org.checkin.soft` attestations (unweighted — any DID level counts)
- Covenant compliance self-declaration (binary — present or absent)

The bar should be achievable by a legitimate local business with real community relationships, and unachievable by a coordinated bad actor who has manufactured soft-loading data.

### 5. The Covenant Document — The Most Urgent Deliverable

The covenant document should appear in `docs/` or `apps/www/articles/` in the repo. It should contain:

- A **behavioral disqualification list** — explicit, auditable behaviors, not values statements
- Categories of clear disqualification: data brokers, surveillance advertisers, extractive labor platforms, predatory lending
- An explicit statement on data handling and .fair compliance requirements
- A version number and amendment process
- An explicit acknowledgment of what the covenant does **not** restrict (aesthetic preferences, market categories, business models not on the disqualification list)

**The covenant is the most urgent deliverable** — it must be written, reviewed, and ratified before the first Org DID claim is processed, because once the first businesses are admitted, the covenant is retroactively fixed by those admissions.

### 6. Connections to the Architecture Series

- Requires `auth.attestations` with `org.founding`, `org.checkin.soft`, and `org.claim.vouch` attestation types
- Founding Person DID accountability propagation requires standing computation in Proposal 7/8
- The cluster gaming vector in Stream 2 (Gas Model Ceiling) depends on `org.founding` attestation linkage to detect coordinated Org DID clusters

### 7. Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| What is the minimum `org.claim.vouch` threshold? | Determines entry bar for Org DIDs | 3 Established DIDs minimum, calibrated post-launch |
| What is the minimum soft-loading count? | Determines community evidence requirement | 15 distinct Person DIDs, any tier |
| Does soft-loading evidence expire? | Old check-ins from long-departed members may not reflect current community | Yes — 24-month decay window recommended |
| Who writes the first covenant document? | Founding team or community ratification? | Ryan drafts; community comment period before first Org DID claim |
| Can a Person DID lose their founding anchor status for an Org DID? | If accountability propagation becomes too burdensome | No — the anchor is permanent; the accountability is the value |

**Detecting resolution in the repo:**
- `org.founding`, `org.checkin.soft`, and `org.claim.vouch` attestation types in the controlled vocabulary
- Covenant document appears in `docs/` or `apps/www/`
- New migration for Org DID claim flow referencing composite attestation model
- `apps/auth/` or a new `apps/business/` service gains Org DID claim processing logic

---

## 11. Gas Model Ceiling — Stream 2

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/gas-model-ceiling.md`
**Related upstream:** Discussion #253 (Org DID), MJN whitepaper
**Addresses:** Outstanding Concern 5 (Gas Model Ceiling)

### Executive Summary

The Declared-Intent Marketplace (Stream 2) resolved the structural contradiction between Imajin's sovereignty values and commercial revenue: no platform optimization between user attention and advertiser reach, local profile matching, trust-graph position that cannot be purchased.

One calibration gap remains: capital can achieve saturation of the opted-in pool through **volume**, even without buying trust-graph position. A well-funded Org DID paying high gas can reach every opted-in user in a relevant category as frequently as it chooses. Within a consent-based model, volume becomes a proxy for influence. The door can't be bought, but it can be knocked on constantly by the highest bidder.

This is a calibration problem, not a structural problem. The recommended solution: **frequency-scaled gas** as the primary mechanism, with user-configurable rate limits as an optional overlay.

### 1. Reach Width vs. Reach Depth

The three-tier gas model gates reach by graph distance — **reach width**. It says nothing about how frequently a business can reach the same opted-in user — **reach depth** is unconstrained.

A well-funded Org DID can pay Tier 2 or Tier 3 gas repeatedly to maintain constant presence. A bootstrapped business sends one message and waits. This recreates a two-tier visibility problem inside the consent model.

### 2. The Three Mechanisms

**Mechanism A — Consent alone (current state):** The problem is the asymmetry between opt-out friction (cognitive cost that compounds) and saturation cost (marginal for a well-funded sender). Surveillance advertising depends on exactly this tolerance gap.

**Mechanism B — Per-recipient rate limit (hard cap):** Cap the number of times a single Org DID can reach a single opted-in Person DID within a time window. Clean enforcement, but creates hard-limit edge cases (legitimate high-frequency businesses, user whitelists).

**Mechanism C — Frequency-scaled gas (Recommended):** Gas cost to reach the same opted-in Person DID scales with recency. First message within a 30-day window: standard Tier 2/3 gas. Subsequent messages: exponentially increasing cost.

### 3. The Recommended Multiplier Curve

| Message # to same DID (30-day window) | Multiplier | Rationale |
|---------------------------------------|------------|-----------|
| 1st | 1× | Standard gas |
| 2nd | 2× | Mild deterrence |
| 3rd | 4× | Meaningful cost signal |
| 4th | 8× | Saturation becomes expensive |
| 5th | 16× | Economically irrational for most senders |
| 6th+ | 32×+ | Hard ceiling in practice |

**The multiplier curve is the single governance parameter.** It should be a protocol-level parameter that nodes can adjust within defined bounds. The critical calibration question: at what multiplier does saturation become economically irrational, and does the 5th/6th message multiplier achieve that threshold?

### 4. Closing the Gaming Vector — Cluster-Aware Gas

The coordinated Org DID cluster scenario — multiple businesses sharing a founding Person DID, rotating senders to circumvent per-sender frequency scaling — is the primary gaming risk.

The fix requires `auth.attestations` infrastructure: Org DIDs are non-severably anchored to founding Person DIDs through `org.founding` attestations. Cluster gas computation detects when multiple Org DIDs share a founding Person DID and applies the cumulative frequency cost as if they were a single sender to the same recipient.

Negative behavioral attestations on an Org DID propagate a standing penalty to founding Person DIDs. This creates a direct disincentive for coordination.

**This is a hard dependency:** cluster-aware gas computation cannot be implemented before the attestation layer is live.

### 5. User-Configurable Overlay — Sovereign Rate Limit

Frequency-scaled gas deters saturation economically; user configuration provides personal sovereignty over commercial reach:

- **Personal rate limit:** User sets maximum messages-per-Org-DID-per-period (default: platform default, user can restrict further)
- **Whitelist:** User explicitly whitelists an Org DID for unrestricted reach (e.g., their favorite local business)
- **Blacklist:** User permanently blocks an Org DID — supersedes everything else, including gas payment

**Key design principle:** The default state should be the low-effort, well-protected baseline. A user who never configures anything is already protected by the frequency-scaled gas curve.

### 6. .fair Compliance as a Gas Model Gate

An Org DID that is not .fair compliant pays a higher gas cost to reach opted-in users, or is blocked from Stream 2 entirely pending compliance. The gas model becomes a partial enforcement mechanism for covenant adherence:

- `flag.yellow` on an Org DID: standard gas + transparency notice to recipients
- `flag.amber`: elevated gas cost (e.g., 2× base)
- `flag.red`: blocked from Stream 2 until flag resolved

Automated Org DID messages (Stream 3 settlement) must carry signed .fair manifests as a condition of settlement.

### 7. Where Gas Fees Go — Incentive Alignment

The platform should never benefit from enabling saturation. Recommended distribution:
- Node operator: operational costs
- Platform: protocol sustainability
- Recipient Person DID: small share for high-frequency messages — creating a direct financial incentive for users to permit high-gas commercial reach, while retaining the right to set their own rate limit

The most important property: if the platform and node operators both benefit more from high-quality, low-frequency commercial reach than from saturation, the incentive structure reinforces the gas model's design intent.

### 8. Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Multiplier curve starting values — are these correct? | Determines economic deterrence threshold | Start with proposed values; calibrate post-launch with transaction data |
| Should frequency scaling be per-Org-DID or per-founding-Person-DID? | Determines gaming surface before cluster-aware computation is live | Per-Org-DID for MVP; upgrade to cluster-aware when attestation layer is live |
| Does the recipient Person DID receive a share of high-frequency gas fees? | Incentive alignment for high-gas commercial reach | Yes — creates positive-sum model for frequent reach |
| What is the time window for frequency scaling — 30 days, 7 days, rolling? | Shorter windows are stricter; longer windows are more business-friendly | 30-day rolling window |
| Should .fair non-compliance block Stream 2 access entirely, or just cost more? | Enforcement vs. incentive model | Cost more first; block after unresolved `flag.amber` |

**Detecting resolution in the repo:**
- Frequency multiplier applied in Stream 2 gas calculation logic
- `apps/pay/` or Stream 2 routing service reads per-recipient message history for gas computation
- User rate limit configuration in profile or settings service
- `.fair` compliance check in Stream 2 dispatch flow

---

## 12. Declaration Granularity Standards — Stream 2

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/declaration-granularity.md`
**Related upstream:** Discussion #253 (Stream 2), `packages/fair/` (for pattern reference)
**Addresses:** Outstanding Concern 6 (Declaration Granularity Standards)

### Executive Summary

The Declared-Intent Marketplace uses local profile matching: a user declares interests on their own node, a business offers, the system returns a match count without the user's profile ever leaving their node. At coarse granularity — specialty coffee, live music — this is a strong privacy model.

The gap: match quality and privacy protection are inversely coupled at fine granularity. As declaration specificity increases — Ethiopian natural process, within 2km, Tuesday mornings, age 25–35 — the sum of a user's declared interests becomes a high-resolution behavioral profile. An adversarial business sending systematically varied offers and observing match counts can probe the local matching system to reconstruct that profile statistically, without ever receiving it directly. This is a known attack class (related to the linkage attack in differential privacy literature).

**Recommended solution:** k-anonymity threshold enforcement at the matching layer, combined with offer probe rate limits from the Gas Model Ceiling proposal. Users declare at any granularity they choose. The matching layer enforces the privacy guarantee structurally — through the mathematics of the matching computation itself.

### 1. The Privacy Guarantee — Where It Holds and Where It Breaks

**Declaration granularity levels:**

| Level | Example | Privacy status |
|-------|---------|---------------|
| L1 — Category | specialty coffee | Strong — match count is a genuinely aggregate signal |
| L2 — Subcategory | single origin, natural process | Holds — meaningful aggregate |
| L3 — Specific | Ethiopian natural process, within 2km | Weakened — match count narrows significantly |
| L4 — Behavioral | Ethiopian natural process, within 2km, Tuesday mornings, age 25–35 | Fails — sum of declarations begins to uniquely identify |

The inference attack requires only the ability to send many offers with systematically varying specificity and observe match counts. Gas cost provides economic friction but does not prevent inference — a well-funded adversary can afford to probe systematically.

### 2. The Three Defense Options

**Option A — Controlled vocabulary (reject):** Define a fixed taxonomy of declaration categories. Users can only declare from this vocabulary. Resolves the privacy problem by degrading the product. Rejects user sovereignty over their own declarations.

**Option B — k-anonymity threshold (recommended as primary):** Users declare at any granularity. The matching layer only uses a declaration in the match count if at least k users in the opted-in pool share that declaration. Fine-grained declarations matching fewer than k users are suppressed — invisible to the matching layer.

**Option C — Rate-limited offer probing (defense-in-depth):** Restrict how many distinct offers a business can send per time period. A patient adversary can still probe, but the rate limit slows the attack. This is the mechanism from the Gas Model Ceiling document — Mechanism B (per-recipient rate limit) and Mechanism C (frequency-scaled gas) both contribute.

**The recommended model:** Option B as primary + Option C as defense-in-depth.

### 3. k-Anonymity Parameter Calibration

**The k threshold is the single most important design decision:**

| k value | Privacy level | Match pool impact |
|---------|--------------|------------------|
| k=3 | Minimal | Very few declarations suppressed |
| k=5 | Standard (differential privacy convention) | Moderate suppression of fine-grained declarations |
| k=10 | Strong | Some L3 declarations suppressed; most L2 unaffected |
| k=25 | Strict | L3 and many L2 declarations suppressed |

**Recommended default: k=5**, with node operators able to increase (not decrease) the threshold.

**Sensitive category floor:** Certain declaration categories carry inherently higher inference risk and should have a higher minimum k enforced at the protocol level, not adjustable by node operators:

| Sensitivity class | Examples | Recommended minimum k |
|------------------|---------|----------------------|
| `standard` | Interests, hobbies, food preferences | k=5 |
| `temporal` | Time-of-day, day-of-week preferences | k=10 |
| `location` | Neighbourhood, distance radius | k=10 |
| `demographic` | Age range, household size | k=15 |
| `health` | Health conditions, dietary restrictions | k=25 |

### 4. The Declaration Type System

There is no declaration category type in any package. The `.fair` package has a role vocabulary but no equivalent for interest declarations. This proposal recommends a declaration type system modeled on the `.fair` package's pattern but structured for k-anonymity enforcement:

```typescript
export interface DeclarationEntry {
  did: string;           // declaring DID
  category: string;      // user-defined free text (no central vocabulary)
  sensitivity: 'standard' | 'temporal' | 'location' | 'demographic' | 'health';
  value: string;         // the declaration itself
  created: string;       // ISO 8601
  expires?: string;      // optional expiry
  signature: string;     // Ed25519 signature by declaring DID's keypair
}
```

**The `sensitivity` field is a controlled enum** that triggers the appropriate k threshold at the matching layer. The `category` field is user-defined free text — no central vocabulary, full user sovereignty.

**The `signature` field is critical:** User declarations signed by the declaring DID's keypair using the same Ed25519 signing infrastructure from the Attestation Data Layer proposal. Declarations are tamper-evident, portable (consistent with the BaggageDID model), and auditable.

### 5. Connections to the Architecture Series

**Attestation Data Layer:** The k-anonymity enforcement model requires the matching layer to know pool size — a query against the same trust graph data used for standing computation. The signing utilities in `@imajin/auth` should be extended or reused for declaration signing.

**Identity Tier Storage:** A Soft DID (Visitor) should not be able to make highly sensitive declarations, because the identity behind the declaration is not cryptographically verified. Sensitive category declarations should require at minimum a Hard DID (Preliminary).

**Gas Model Ceiling:** k-Anonymity provides structural protection; probe rate limits provide economic protection; frequency-scaled gas provides behavioral deterrence. Together they define the full privacy envelope of Stream 2.

**Org DID Vetting:** Systematic declaration probing is a covenant violation. A pattern of systematic probing should trigger a `flag.yellow` against that Org DID.

**BaggageDID:** Because declarations are signed by the declaring DID's keypair, they are portable. The BaggageDID's encrypted context layer should include the full declaration history. On a new node, declarations are available immediately; the k-anonymity computation is always local to the current pool.

### 6. The Complete Privacy Envelope for Stream 2

With both Gas Model Ceiling (Proposal 11) and Declaration Granularity resolved, the full privacy envelope of Stream 2 can be stated:

- **Structural protection:** Local matching means profiles never leave the user's node; k-anonymity means fine-grained declarations cannot be used to uniquely identify users even in aggregate
- **Economic deterrence:** Frequency-scaled gas prices saturation; probe rate limits slow inference attacks
- **Cryptographic tamper-evidence:** Declarations are signed by the declaring DID — tamper-evident and portable

### 7. Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Default k threshold: 5, 10, or higher? | Core privacy guarantee | k=5 default, node operators can increase |
| Should sensitive category floors be protocol-level or node-configurable? | Governance of privacy baseline | Protocol-level minimums — nodes cannot reduce below floor |
| Who governs sensitivity classification for new declaration types? | Extensibility of the type system | Protocol proposal process, similar to IETF; Cultural DIDs can add community namespaces |
| Should a Soft DID be able to make any declarations, or only standard-sensitivity? | Identity verification and declaration integrity | Soft DIDs: standard only; Hard DID Preliminary+: all sensitivity levels |
| Should the noise addition option (differential privacy extension) be in MVP? | Stronger privacy at cost of implementation complexity | Defer to post-MVP hardening phase |
| Declaration portability: should declarations be included in the BaggageDID? | User sovereignty over their own declared context | Yes — full declaration history in encrypted BaggageDID layer |
| Where does the `packages/declarations/` package live — standalone or merged into `packages/fair/`? | Package architecture | Standalone — declarations and attribution are distinct concerns |

**Detecting resolution in the repo:**
- New `packages/declarations/` (or declaration types added to `packages/fair/`)
- `DeclarationEntry` type with `sensitivity` enum and `signature` field
- Matching layer in Stream 2 applies k-anonymity threshold check before returning match counts
- Sensitive category floor constants defined at protocol level
- `@imajin/auth` signing utilities used for declaration signing

---

## 13. Cultural DID — Complete Specification

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/cultural-did-specification.md`
**Related upstream:** Discussion #252 (Cultural DID), #271 (Progressive Trust), #273 (Trust Accountability)
**Addresses:** Outstanding Concern 7 (Cultural DID — Open Specification Questions) — all seven questions answered

### Executive Summary

The Cultural DID is the fourth identity primitive: entities defined by shared practice rather than legal structure — art collectives, music scenes, mutual aid networks, intentional festivals, open-source creative projects. Discussion #252 is live. What was missing was specific, implementable answers to seven open specification questions. This document answers all seven with full analysis, cross-references to the prior proposals in this series, and code-level specifications ready for implementation tickets.

**Critical dependency:** The Cultural DID governance model depends entirely on the Attestation Data Layer (Proposals 7/8). Token context cannot be computed without `auth.attestations`. Phase 1 of Cultural DID implementation cannot begin until the attestation infrastructure is live. This is a technical requirement, not a preference.

### 1. Membership Tiers

| Tier | Description | Access |
|------|-------------|--------|
| Governing Member | Token context above formation threshold; active governance participation | Full governance weight, treasury access, dissolution vote |
| Active Member | Hard DID (Established) + minimum attestation count within Cultural DID | Participate in governance review, nominate Governing Members |
| Participant | Hard DID (Preliminary) + invited or vouched | Full cultural access, .fair attribution, event participation |
| Observer | Soft DID or un-vouched Hard DID | Public-facing content and events only |

Tier transitions are **computed states** derived from attestation history — not manual elections. A Person DID whose token context rises above the Active Member threshold is automatically eligible for promotion, confirmed by a Governing Member attestation.

### 2. Q1 — Founding Member Count and Token Context Threshold

**Minimum founding members: 5.**

Below 5 (2–3 founders) the Cultural DID is vulnerable to bad-faith formation by a small aligned group who accumulate governance control before genuine membership exists. 5 achieves quorum diversity (with a 33% ceiling, no single founder can block without 2 others) while remaining achievable early in the network's life. Above 7 creates formation barriers that exclude the communities Imajin most wants to reach.

**Token context threshold for formation:** Each founding Person DID must have token context ≥ 100 (proposed starting value — see Q2 for computation). This ensures founding members have demonstrated participation before forming a Cultural DID.

### 3. Q2 — Token Context Calculation

Token context is a **standing score computed from behavioral history** — a read-only query over `auth.attestations`, `.fair` records, and pod membership history. It is never stored as a value; always computed on demand. Consistent with Ryan's "standing is computed, not assigned" principle.

```
token_context(did) = (
  attestation_count(did)     × 1.0   +   // raw attestation volume
  fair_contributions(did)    × 3.0   +   // weighted — attribution = meaningful contribution
  trust_graph_depth(did)     × 2.0   +   // connections within the Cultural DID specifically
  activity_recency(did)      × 1.5       // decay function — recent activity weighted higher
) × community_context_multiplier
```

- **Attestation count:** all positive attestation types (event.attendance, vouch.given, checkin.verified, etc.)
- **.fair contributions:** count of `.fair` manifests where the DID appears in `attribution[]`
- **Trust graph depth:** BFS depth from the Cultural DID's membership pool specifically (community context, not global)
- **Activity recency:** linear decay over 12 months — full weight at 0 months, zero weight at 12 months of inactivity
- **Community context multiplier:** a node-specific parameter Cultural DIDs can set at formation (default 1.0; allows communities with different participation patterns to calibrate)

Stream 5 participation (inference fees, Network of Souls queries) is **not an input**. Token context is contribution-weighted, not inference-weighted.

### 4. Q3 — Governance Weight Ceiling and Redistribution Trigger

**Ceiling: 33% of total governance weight** among active Governing Members.

With a 33% ceiling, no single Governing Member can unilaterally control outcomes (majority requires >50%). A single Governing Member can prevent quorum from acting against them — this asymmetry is intentional: it is easier to block a bad decision than to force a good one. Correct governance posture for a community body.

**Redistribution trigger:** When any Governing Member's computed token context would push them above 33% of total, the excess weight is redistributed proportionally to other Governing Members. The redistribution is automatic and computed — not a governance vote.

**Edge case — below minimum Governing Members:** If Governing Member count drops below 5, governance weight ceilings are relaxed to allow the remaining members to function. The Cultural DID enters a grace period (see Q5, Scenario C).

### 5. Q4 — Governance Removal for Values Misalignment

The removal mechanism is behavioral rather than ideological — specific observable acts, not values judgments. The Cultural DID's founding charter can add community-specific removal criteria, but the base process is:

1. A Governing Member issues a `governance.flag` attestation citing a specific behavioral category from the removal criteria list
2. The flagged member is notified privately. They receive 14 days to submit a `governance.response` attestation
3. A quorum of Governing Members — **excluding the flagged member and the flagger** — reviews both attestations. Minimum: 3 participating Governing Members (or all remaining if fewer than 5 after exclusions)
4. Removal requires weighted majority of the reviewing quorum. The flagged member's governance weight is **suspended during review** — if the vote fails, they retain full standing
5. Outcome is recorded as `governance.removal` (approved) or `governance.flag.dismissed` (rejected) — both are permanent signed records

**Behavioral disqualification categories for Cultural DID removal:**
- Systematic extraction of community resources without contribution
- Harassment or sustained harm to members (corroborated by multiple attestation sources)
- Unauthorized use of Cultural DID identity or attribution
- Breach of the founding charter's declared behavioral commitments

The founding charter is the right place for values-based criteria specific to the community's domain.

### 6. Q5 — Founding Member DID Revocation or Compromise

**Scenario A — Keypair compromised, member still active:** Key rotation through social recovery (Embedded Wallet RFC #268). The new keypair inherits the DID. All attestations — including Cultural DID governance weight — continue uninterrupted. The key rotation event is recorded as a system attestation. No governance weight change.

**Scenario B — Governing Member DID revoked (Trust Accountability Category C flag):**
- Governance weight immediately zeroed and removed from computation
- Revocation recorded as `governance.member.revoked` against the Cultural DID
- The Cultural DID does not dissolve — it loses one governance anchor
- Attribution records naming the revoked DID are not altered — signed manifests remain permanently valid
- If active Governing Member count drops below 5, enter 90-day grace period (Scenario C)

**Scenario C — Cultural DID drops below minimum Governing Members:**
- 90-day grace period begins
- Remaining Governing Members can nominate Active Members for promotion to Governing Member
- Each promotion requires weighted majority of remaining Governing Members
- If count is not restored to 5 within 90 days, the Cultural DID enters **dormant state**
- Dormant Cultural DID: no governance actions, no treasury operations, attribution records remain permanent and valid
- Reactivation: 5 new Governing Members can petition for reactivation from the Active Member pool

### 7. Q6 — Cultural DID + Org DID Relationship

Yes — a Cultural DID can hold an Org DID relationship. A music scene Cultural DID that runs a record label. An artist collective with a gallery. A festival community that operates a production company. The architecture keeps them as **separate entities with a declared relationship**, not merged into a single primitive.

**The relationship is attested, not structural:**

```
cultural.org.relationship attestation:
  issuer_did:  [Cultural DID]
  subject_did: [Org DID]
  type:        'cultural.org.relationship'
  payload:     { relationship_type: 'operator' | 'partner' | 'fiscal_sponsor', declared_scope: string }
  signature:   [Cultural DID treasury key or Governing Member quorum signature]
```

**Privacy model:** The Org DID's business operations are transparent (mandatory for Org DIDs). The Cultural DID's internal membership and deliberation remain private. The relationship is public — which Cultural DID is connected to which Org DID, and in what declared capacity.

**Accountability propagation:** The Org DID's founding Person DID anchors are separate from the Cultural DID's Governing Members — unless the same Person DIDs hold both roles. Negative attestations on the Org DID do not automatically propagate to the Cultural DID (the relationship is declared, not structural ownership). However, a Pattern of Org DID misconduct by founding Person DIDs who are also Cultural DID Governing Members will affect their Cultural DID governance weight through the Trust Accountability Framework's standing penalties.

### 8. Q7 — .fair Attribution Records on Cultural DID Dissolution

Signed `.fair` manifests are permanent provenance records. Dissolution must not erase, invalidate, or make unverifiable any attribution records naming the Cultural DID.

**Dissolution process:**

1. A Governing Member issues `governance.dissolution.proposal` with written rationale and proposed attribution transfer distribution
2. Proposed distribution specifies how Cultural DID attribution shares transfer to individual Person DIDs. Default: proportional to governance weight at dissolution time. Quorum can vote for an alternative distribution
3. **High quorum bar:** weighted majority of **all** active Governing Members. Higher threshold than routine governance — dissolution is irreversible
4. If approved, dissolution event recorded as `cultural.dissolved` — signed by all Governing Members who voted in favour
5. Attribution resolution: `fair.attribution.resolution` attestations are issued alongside existing manifests — **not modifying original signed manifests** (which would invalidate their signatures), but issuing resolution records naming the individual Person DIDs who now hold the attribution shares

**The dissolved state is permanent and publicly visible.** The Cultural DID identity record does not disappear — it is marked as dissolved with a timestamp and reference to the dissolution attestation. Any future query about attributed work returns: (a) the original signed manifest, (b) the Cultural DID's record marked as dissolved, and (c) the resolution record naming the current attribution holders.

**Contested dissolution:** If the high-quorum bar is not met:
- Cultural DID enters a Dispute Resolution period (maximum 60 days)
- A mediator — an Established DID outside the Cultural DID, nominated by both sides — issues a non-binding `governance.mediation.report`
- After the report, a second dissolution vote is held
- If the second vote fails, dissolution is blocked for 90 days and can be re-initiated after that window
- During Dispute Resolution, governance is suspended except for emergency removal of members posing active harm

### 9. New Attestation Types Required

The Cultural DID specification requires the following additions to the controlled vocabulary defined in Proposals 7/8:

| Type | Issuer | Description |
|------|--------|-------------|
| `governance.flag` | Governing Member | Initiates removal review against another Governing Member |
| `governance.response` | Flagged member | Response attestation during removal review |
| `governance.removal` | Reviewing quorum | Records approved removal outcome |
| `governance.flag.dismissed` | Reviewing quorum | Records rejected removal — member retains standing |
| `governance.member.revoked` | System | Records loss of Governing Member due to Trust Accountability revocation |
| `governance.dissolution.proposal` | Governing Member | Initiates dissolution process |
| `cultural.dissolved` | Governing Member quorum | Records approved dissolution |
| `fair.attribution.resolution` | System (post-dissolution) | Resolution record mapping Cultural DID shares to individual Person DIDs |
| `cultural.org.relationship` | Cultural DID (treasury or quorum) | Declares relationship to an Org DID |
| `cultural.org.relationship.removed` | Cultural DID (treasury or quorum) | Records end of Cultural-Org DID relationship |

### 10. Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Minimum founding members: 5, or adjustable per community? | Determines formation barrier | 5 as protocol-level minimum; Cultural DIDs cannot form below 5 |
| Token context formation threshold: 100, or to be calibrated? | Gate for founding member qualification | Start at 100; calibrate after first Cultural DIDs form |
| Community context multiplier: who sets it and within what bounds? | Allows communities to weight participation differently | Cultural DID sets at formation; range 0.5–2.0; unchangeable after formation |
| Does the Cultural DID treasury key require quorum authorization for each signing act, or is it a delegated key? | Determines operational complexity of treasury operations | Delegated key with quorum authorization at key creation — same model as Proposal 6 |
| Should Cultural DID membership rosters be private by default or public by default? | Core privacy/transparency tradeoff | Private by default; Cultural DID can opt into public roster |
| Can a Cultural DID be reactivated from dormant state after more than 90 days? | Long-dormant communities may want to reconvene | Yes — no time limit on reactivation, but requires 5 new Governing Members from the remaining Active Member pool |

**Detecting resolution in the repo:**
- New migration adding Cultural DID tables or columns to existing schema
- `governance.flag`, `cultural.dissolved`, `fair.attribution.resolution` added to attestation type vocabulary
- Cultural DID formation flow in auth or a new `apps/cultural/` service
- Token context computation function referencing `auth.attestations`, `.fair` records, and trust graph depth
- Discussion #252 gains implementation status label or linked PR

---

## 14. Governance Equity vs. Economic Equity

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/governance-equity.md`
**Related upstream:** MJN Whitepaper v0.2, Discussion #252 (Cultural DID), Discussion #269 (MJN Token Economics)
**Addresses:** Outstanding Concern 3 (Governance Equity vs. Economic Equity) — identifies the three-layer structure and the specific documentation gap

### Executive Summary

Imajin's economic model is genuinely accessible — Streams 1–4 require nothing beyond a keypair and an invite. This is real economic equity.

Governance equity is a different and unresolved question. The Network of Souls model concentrates network-level influence in the 10% who run inference. The 90% who transact, create, and participate without running AI are economically included but have no equivalent path to network-level influence.

This document does not argue the asymmetry is wrong. Epistemic authority — people paying to access your thinking — is a philosophically serious governance signal. But a design decision that is intentional and defensible must be **stated as such**. An unstated asymmetry becomes a grievance. A stated one becomes a position that can be evaluated and refined.

The prior proposals in this series have already answered the governance equity question at the **community level**. The Cultural DID specification (Proposal 13) builds a contribution-weighted governance model that is Stream 5 independent. The remaining gap is at the **network level** — between community governance and protocol governance — where Network of Souls influence operates without a formal counterbalance or explicit documentation.

### 1. The Three-Layer Governance Structure

| Layer | Mechanism | Stream 5 Dependent? | Current Status |
|-------|-----------|---------------------|---------------|
| **Community** | Cultural DID token context (contribution-weighted, attestation-based) | No — any participant earns weight through demonstrated participation | Specified in Proposal 13 |
| **Network** | Network of Souls influence (epistemic authority, query fees) | Yes — influence flows to highly-queried inference nodes | Undocumented as a design decision |
| **Protocol** | MJN Foundation governance (Swiss Stiftung) | Mechanism unspecified | Structurally separated; internal governance not yet designed |

These three layers must not be conflated. Claiming that Cultural DID governance answers the question about Foundation governance is a category error. Each layer operates on different participants, through different mechanisms, with different stakes.

### 2. The Philosophical Case for the Asymmetry — and Its Limits

**The case for epistemic authority:**
- Token-based governance (plutocracy): capital compounds, holders govern in their own interest
- Vote-based governance (majority rule): uninformed majorities can override expert minorities on technical questions
- Epistemic authority: governance weight flows to those whose thinking others value enough to pay for — a revealed-preference signal, not self-declared or purchased

The argument is coherent and defensible. It is also incomplete in four ways:

1. **Inference access problem:** Not all knowledge is expressible through personal AI queries. A community organizer who holds relational knowledge, keeps the community healthy, and shows up reliably generates value that doesn't produce inference fees. The epistemic authority model implicitly devalues tacit, relational, and care-oriented contributions.

2. **Early-adopter concentration:** The same compounding dynamic from the Org DID Vetting proposal applies here. Early Network of Souls participants accumulate query history, trust-graph depth, and inference fees before the broader network exists. By the time the 90% arrive, the 10% have already established epistemic authority that is structurally difficult to contest.

3. **Legibility asymmetry:** The network can see query counts and inference fees. It cannot see the person who quietly mentors new members, resolves conflicts before they escalate, or maintains the cultural container that makes the community worth joining. Network of Souls influence is legible to the protocol; community stewardship is not.

4. **The translation gap:** Does network-level influence (highly-queried Network of Souls nodes) translate into protocol-level decisions? If yes, the asymmetry affects the platform's evolution. If no, the asymmetry is about social influence, not governance power. The design decision is different in each case — and this question is not yet answered.

### 3. What Is Already Resolved

**Community governance — already equitable:**
The Cultural DID governance model (Proposal 13) is explicitly Stream 5 independent:
- Token context inputs: attestation count, .fair contributions, trust graph depth, activity recency
- Stream 5 participation is **not an input**
- Accessible to any Person DID meeting the Hard DID (Established) threshold — requires keypair + 90 days active participation, not personal AI
- Decays with inactivity rather than compounding with capital or compute

Every stream that generates attestations generates governance weight at the community level. This is the answer to the concern at the community layer — comprehensively.

**Protocol governance — structurally separated, mechanism unspecified:**
MJN Whitepaper v0.2 separates Imajin Inc. (reference product operator) from the MJN Foundation (protocol steward — Swiss Stiftung). The Foundation governs the DID spec, trust primitives, and settlement mechanics. What is not yet specified: the Foundation's **internal governance mechanism** — who votes, how weight is allocated, whether it connects to Network of Souls participation.

This is a planned gap, not an oversight. But if Foundation governance is built on top of the Network of Souls model, it inherits the asymmetry at the protocol level. Changes to the inference layer that benefit inference operators would have a structural governance advantage over changes that benefit everyone else. Specifying the mechanism now, while the network is small, avoids path dependency.

**The attestation layer as a cross-layer bridge:**
`auth.attestations` records all forms of participation — event attendance, .fair contributions, vouching, check-ins, education. These records feed Cultural DID governance weight. They could also feed Foundation governance weight — providing a bridge between community-level demonstrated participation and protocol-level governance voice. This is not a proposal; it is an observation that the infrastructure for a participation-based Foundation governance mechanism already exists, if Ryan chooses to build on it.

### 4. The Remaining Gap — Network-Level Influence

With community governance addressed and protocol governance structurally separated, the remaining gap is specifically at the **network level**: diffuse influence flowing from being a highly-queried node in the Network of Souls.

**Q1: Does network-level influence translate into protocol-level decisions?**

| Scenario | Implication |
|----------|-------------|
| Network influence → Foundation votes directly | Asymmetry is a governance power problem; urgently needs counterbalance |
| Network influence → social influence only, Foundation is independent | Asymmetry is real but contained; documentation resolves it |
| Currently unclear | This is the core problem — must be specified before the network grows large enough to create path dependency |

Greg's assessment: the answer is currently unclear — and that ambiguity is the core problem. Specify the Foundation governance mechanism before a cohort of highly-queried inference nodes exists and has accumulated epistemic authority.

**Q2: Should Foundation governance be separate from or built on the Network of Souls model?**

Greg's position: **separate**. The Foundation governs the protocol layer that all nodes depend on, including nodes run by participants who will never run personal AI. Protocol governance built on inference participation would make the protocol's evolution structurally dependent on Stream 5 economics.

The Foundation's governance mechanism should draw on participation across all streams — with attestation history as the primary signal, consistent with the Cultural DID governance model. This is the cross-layer bridge from Section 3.

**Q3: Three options for Foundation governance weight distribution:**

| Option | Mechanism | Status |
|--------|-----------|--------|
| A — Attestation-based (target state) | Foundation governance weight = participation-weighted query over `auth.attestations` — same model as Cultural DID token context, but across all nodes | Requires attestation layer to be live |
| B — Cultural DID delegate model | Cultural DIDs elect delegates; delegates hold Foundation council seats; Cultural DID governance weight determines delegate elections | Requires Cultural DID formation to be live |
| C — Founding team governance (current default) | Ryan + Imajin Inc. team govern the Foundation until formal mechanism is implemented | Operational; creates path dependency risk if it persists too long |

**Greg's recommendation:** Option C at launch (pragmatic, operational), with Option A as the target state once the attestation layer is live, and Option B as a bridging mechanism once Cultural DIDs exist. Document the upgrade path explicitly so Option C doesn't become permanent by default.

**Q4: Can Cultural DID governance weight carry weight in protocol-level decisions?**

Yes — and this is the cleanest bridge between layers. When Cultural DIDs elect delegates for Foundation council representation, Cultural DID governance weight determines delegate election outcomes. A Person DID with high Cultural DID governance weight in multiple communities has demonstrated cross-community trust and contribution — exactly the kind of signal that should inform protocol governance. It is community-validated, contribution-earned, and not Stream 5 dependent.

### 5. What Documentation Is Needed

This concern resolves with **documentation**, not code changes. Three statements need to appear in the whitepaper or architecture docs as explicit design decisions:

**Statement 1 — Three-layer governance:**
> "Imajin's governance operates at three distinct levels. Community governance is contribution-weighted and Stream 5 independent — any participant earns weight through demonstrated participation in their Cultural DID. Network-level influence flows through the Network of Souls model — epistemic authority accumulates in highly-queried personal AI nodes. Protocol governance is steered by the MJN Foundation — governed by [specified mechanism]. These layers are distinct. Economic participation in Streams 1–4 is fully accessible to all hard DID holders. Network-level governance influence is Stream 5 dependent. Protocol governance is [mechanism]."

**Statement 2 — Cultural DID governance equity:**
> "Cultural DID governance is explicitly Stream 5 independent. Token context — the measure of governance weight — is computed from attestation count, .fair contribution history, trust graph depth, and activity recency. Running personal AI is not an input. Any Person DID meeting the Hard DID (Established) threshold can earn governance weight in their community through demonstrated participation."

**Statement 3 — Foundation governance mechanism:**
> "The MJN Foundation governs the protocol layer that all Imajin nodes depend on. Foundation governance is [built on: participation-weighted attestation history / Cultural DID delegate elections / founding team authority with defined transition mechanism]. Network of Souls participation [does / does not] contribute to Foundation governance weight. The current governance mechanism is [X]; the target mechanism is [Y]; the transition path is [Z]."

Statement 3 is the most urgent missing piece. Once it exists, the governance equity concern can be evaluated against a stated design position rather than an implied one.

### 6. Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Does network-level (Network of Souls) influence translate into Foundation governance votes? | Determines whether the asymmetry is a governance power problem or a social influence one | Must be answered and documented before Network of Souls participation is significant |
| Is Foundation governance built on attestation history, Cultural DID delegates, or founding team authority? | Determines who governs protocol evolution | Attestation-based as target; founding team as bridge; explicit transition plan required |
| What is the Foundation's transition path from founding governance to the target mechanism? | Without a stated path, Option C (founding team) becomes permanent | Must be specified now, not after the network has grown |
| Should highly-queried Network of Souls nodes have any formal governance role, or only social influence? | If formal role: counterbalance needed; if social only: documentation resolves the concern | Social influence only at the network level; attestation-based participation at the protocol level |
| Should the Foundation governance documentation address the early-adopter concentration risk explicitly? | Naming known failure modes in advance strengthens trust in the design | Yes — acknowledge the risk and the structural mitigations |

**Detecting resolution:**
This concern resolves when the following appear in the repo or in public documentation:

- Whitepaper gain a section explicitly mapping the three governance layers and their Stream 5 dependency
- Cultural DID documentation states that token context is not Stream 5 dependent (can be added to Discussion #252)
- MJN Foundation governance mechanism is specified — even provisionally, with an explicit transition path documented
- The relationship between Network of Souls influence and Foundation governance decisions is stated explicitly in whitepaper or governance documentation

---

## 15. .fair Attribution from Commit History — ADR-001

**Author:** Ryan Veteze (RFC open for community input)
**Date:** March 2026 (committed in `e079b80`)
**Source:** `apps/www/articles/rfc-01-fair-attribution.md`
**Status upstream:** Open for discussion — destined to become `ADR-001: .fair Attribution Protocol`
**Related upstream:** Discussion #15 (GitHub), Bounty #17 (Syndication Service)
**Connects to:** Proposals 3 (.fair signing), 6 (.fair Attribution Integrity), 7/8 (Cryptographic Trust Layer)

### The Core Claim (rfc-01-fair-attribution.md:11–13)

> *"This isn't just a contributor credits problem. It's a protocol design question. The answer here becomes the foundation for how imajin attributes everything — not just code, but content, curation, introductions, and eventually any value-generating act that passes through the network."*

And explicitly (rfc-01-fair-attribution.md:140):

> *"We're solving the code case first because the data is clean, the tooling exists, and the stakes are low enough to experiment. But the protocol we land on here is the protocol."*

This RFC is not about contributor credits. It is the first working implementation of the `.fair` attribution model — the template for all attribution going forward. Everything Greg's proposals say about `.fair` signing and attribution integrity applies directly here.

### What Ryan Has Proposed (rfc-01-fair-attribution.md:23–29)

Git is already a content-addressed, cryptographically signed ledger: author identity, timestamp, precise diff, hash chain. PRs are natural attribution boundaries — discrete units of contribution with author, reviewer, merge decision (rfc-01-fair-attribution.md:31–33). Weight is the unsolved part: *"a one-line architectural decision can outweigh a thousand-line boilerplate addition"* (rfc-01-fair-attribution.md:37).

**The proposed attribution object per merged PR** (rfc-01-fair-attribution.md:45–76):

```json
{
  "id": "attr_abc123",
  "repo": "ima-jin/imajin-cli",
  "pr": 42,
  "merged_at": "2026-03-15T14:22:00Z",
  "contributors": [
    {
      "github": "contributor-handle",
      "did": "did:imajin:...",
      "commits": 7,
      "lines_added": 312,
      "lines_removed": 44,
      "files_touched": ["src/adapters/linkedin.ts"]
    }
  ],
  "reviewers": [{ "github": "reviewer-handle", "did": "did:imajin:...", "approved": true }],
  "weight": null
}
```

**Three tiers of weight signals** (rfc-01-fair-attribution.md:82–97):
- *Structural* (from the diff): touches interface definitions? adds tests? new adapter vs. fix?
- *Community* (from PR activity): reviewer count, review thread length, issues closed, references from subsequent PRs
- *Network* (from trust graph, over time): downstream contribution references, query frequency of contributed module, trust weight of reviewers

**Attribution chain anchoring** (rfc-01-fair-attribution.md:99–106): the resolved attribution object is hashed and written to the node's attribution ledger, linked to the contributor's DID via GitHub handle claim, and referenced in every downstream use — *"the contributor is in the chain of every use of the thing they built."*

### Greg's Position on the Six Open Questions (rfc-01-fair-attribution.md:114–131)

**Q1 — Weighting a small architectural commit** (rfc-01-fair-attribution.md:114–115):
The structural signal approach is correct but incomplete. Interface-touching PRs should carry higher weight — but detecting *why* a small change is load-bearing requires either: (a) explicit tagging by the author in the PR description, or (b) network signals that only emerge over time as downstream PRs reference the change. Greg's position: structural signals for initial weight assignment; network signals as a retroactive weight correction mechanism. Weight is not fixed at merge — it accumulates.

**Q2 — Reviewer attribution** (rfc-01-fair-attribution.md:117–118):
Review thread depth is the best proxy for reviewer contribution quality. A reviewer who leaves substantive comments redirecting the architecture leaves a longer, more substantive thread than an approve-only reviewer. Greg's position: reviewer weight = f(comment count, thread depth, whether PR was modified in response to their comments). This is inferable from the PR record without additional signal.

**Q3 — DID linking from GitHub handle** (rfc-01-fair-attribution.md:120–121):
The GitHub handle becomes an *unclaimed mention* — a reference that exists in the attribution ledger before the profile does. Greg's position: the claim flow should require the contributor to prove ownership of the GitHub handle by signing a message with their imajin DID that matches a verification challenge posted to the GitHub account (via a public Gist or profile README). This is the same model used by Keybase and similar DID linking systems. Once claimed, all historical attribution objects referencing that GitHub handle are retroactively linked to the DID.

**Q4 — Retroactive attribution** (rfc-01-fair-attribution.md:123–124):
Walk the existing commit history and generate attribution objects for all historical PRs. Contributors who haven't yet claimed imajin profiles exist as unclaimed mentions in the ledger. Greg's position: retroactive generation is required — it is the founding generation of the attribution ledger. Unclaimed attributions accumulate; they become claimable when the contributor creates their imajin profile and completes the GitHub handle linking flow (Q3). Unclaimed attributions should not distribute value until claimed — value accumulates in a holding state attached to the unclaimed mention.

**Q5 — Gaming resistance** (rfc-01-fair-attribution.md:126–127):
Structural signals are harder to fake than commit counts but not immune. Interface-definition commits can be fabricated; review thread depth can be gamed with sock-puppet accounts. Greg's position: gaming resistance at launch relies on the trust graph — reviewers carry the trust weight of their DID. A review approval from a Preliminary DID carries less weight than one from an Established DID. The trust graph already provides the anti-gaming layer; no separate mechanism is needed for MVP.

**Q6 — Forking and derivative work** (rfc-01-fair-attribution.md:129–130):
The git history records the fork relationship. `derives_from` in the `.fair` manifest (already present in the architecture doc at `grounding-03-ARCHITECTURE.md:136`) is the mechanism. Greg's position: forked adapters should carry a `derives_from` reference to the original PR's attribution object. The original contributor's share in derivative work is a governance parameter — proposed starting value: 20% of the derivative's attribution weight flows to the original, decaying with each subsequent fork.

### Connection to Unsigned FairManifest (P3)

The attribution object proposed in this RFC has `"weight": null` — unresolved weight. The RFC does not specify that the attribution object itself is *signed*. This is the same gap identified in P3 and Proposal 6: an attribution claim without a cryptographic proof that the claimed DID authorized it.

Greg's position: the attribution object schema needs a `signature` field from the moment it is specified. An unsigned attribution object is the same category of problem as an unsigned `.fair` manifest. The RFC should be extended to require Ed25519 signing of the attribution object by the contributor's DID (not just the GitHub handle) before it is written to the attribution ledger.

### Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Is weight fixed at merge, or does it accumulate retroactively as network signals emerge? | Determines attribution ledger mutability model | Accumulates — network signals update weight over time; original weight is a floor |
| What is the unclaimed attribution holding model — accumulate to a zero address, escrow, or redistribute? | Determines what happens to value from unclaimed GitHub handles | Accumulate to a per-mention escrow; claimable indefinitely; unclaimed after N years → distribute to active pool |
| Should attribution objects be signed at creation, or only hashed? | Integrity vs. operational complexity | Signed — same requirement as `.fair` manifests (extends P3) |
| Who computes `derives_from` weight decay — the contributor, a governance parameter, or a protocol constant? | Attribution economics for fork chains | Protocol constant initially; Cultural DID can override for community-specific forks |

**Detecting resolution in the repo:**
- New `ADR-001` document in `docs/decisions/`
- Attribution object schema appears as TypeScript types in a new package or `@imajin/fair`
- PR merge webhook generates attribution objects (GitHub Actions or pay service webhook)
- GitHub handle → DID claim flow in auth service
- `derives_from` field on attribution objects referencing parent PR attribution

---

## 16. Programmable Distribution Contracts — ADR-002

**Author:** Ryan Veteze (RFC + Bounty, open for community input)
**Date:** March 2026 (committed in `e079b80`)
**Source:** `apps/www/articles/rfc-02-distribution-contracts.md`
**Status upstream:** Open for discussion — destined to become `ADR-002: Distribution Contract Protocol`
**Related upstream:** RFC-01 (attribution), RFC-05 (intent-bearing transactions)
**Connects to:** Proposal 6 (.fair signing), Proposal 15 (attribution from commits)

### The Idea (rfc-02-distribution-contracts.md:12–16)

> *"Every sovereign presence on imajin can declare a distribution contract — a programmable, editable declaration of where incoming value flows the moment it arrives... The distribution logic is part of your sovereign presence. It's who you are, encoded. It runs automatically, every time, without you having to remember."*

The primitive is generalised from the WeR1 codebase (rfc-02-distribution-contracts.md:22–28): *"When a mix is played, every contributor to every track in that mix gets automatically compensated. The split logic runs at the moment of the transaction. No intermediary. No manual accounting. No forgotten payments."* — now extended from music to everything.

### The Schema (rfc-02-distribution-contracts.md:36–79)

```json
{
  "profile_did": "did:imajin:abc123",
  "version": 3,
  "effective_at": "2026-03-01T10:00:00Z",
  "allocations": [
    { "label": "infrastructure", "recipient": "did:imajin:node-operator", "percentage": 15 },
    { "label": "wer1-protocol",  "recipient": "did:imajin:wer1",          "percentage": 5  },
    { "label": "rainforest",     "recipient": "did:imajin:rainforest",     "percentage": 10 },
    { "label": "mortgage",       "recipient": "did:imajin:my-bank-account","percentage": 40 },
    { "label": "retained",       "recipient": "did:imajin:abc123",         "percentage": 30 }
  ],
  "overflow": "retained",
  "minimum_transaction": 0.001,
  "currency": "multi",
  "signature": "..."
}
```

**Four non-negotiable properties** (rfc-02-distribution-contracts.md:82–85):
- **Versioned** — every change creates a new version; full history preserved
- **effective_at** — no retroactive changes; the record is honest about when intent was declared
- **overflow** — rounding errors and sub-minimum transactions accumulate before routing (not lost)
- **signed** — Ed25519 by the DID; nobody can alter your distribution logic without your keys

**Note:** The `signature` field is already in Ryan's schema. This RFC has already resolved the signing question that P3 flags for `.fair` manifests — within its own schema. The `.fair` manifest itself still lacks the field.

### The Micro-Founder Layer (rfc-02-distribution-contracts.md:91–112)

Financial contributors are logged as micro-founders in the `.fair` attribution chain with a structured record including `type: "financial_contribution"`, `contributor_did`, `amount`, `currency`, `contributed_at`, and `weight: null` (to be resolved by the same weighting mechanism as code contributions). Early contributions carry more weight because *"the network was smaller and the risk was higher when they showed up"* (rfc-02-distribution-contracts.md:108). The "I Need Help" essay (`essay-26`) is cited as the mint event — the moment the micro-founder layer opens to the public.

### The Auditable Values Layer (rfc-02-distribution-contracts.md:118–124)

Because contracts are signed, versioned, and readable, aggregate queries become possible: total value flowed to environmental causes this month; percentage of inference fees directed to food security; node operators allocating most to community infrastructure. *"These aren't marketing claims. They're readable facts in the ledger. The network's values become legible in aggregate."*

### Greg's Position on the Seven Open Questions (rfc-02-distribution-contracts.md:130–149)

**Q1 — Minimum viable distribution** (rfc-02-distribution-contracts.md:130–131):
The `overflow` field and `minimum_transaction` threshold already address this architecturally. The implementation question is: does the overflow accumulate locally (in the profile wallet) or in a protocol-level micro-payment batching layer? Greg's position: local accumulation is simpler and consistent with sovereignty. The overflow accumulates in the profile's retained balance and routes when the next transaction above `minimum_transaction` clears.

**Q2 — Recipient types without imajin DIDs** (rfc-02-distribution-contracts.md:133–134):
Legacy financial bridge (Stripe Connect) is the right first target. The adapter pattern from the syndication bounty applies: each payment rail is an adapter registered with the distribution contract execution engine. Recipients without DIDs are addressed by `did:external:{stripe_account_id}` or equivalent bridge DID format. Greg's position: a bridge DID namespace for external accounts, with the adapter layer handling the actual payment routing.

**Q3 — Contract versioning and disputes** (rfc-02-distribution-contracts.md:136–137):
`effective_at` already specifies the governing version per transaction. What needs explicit handling: (a) transactions initiated before `effective_at` but settled after; (b) batch settlements spanning a version change. Greg's position: the version in effect at the moment of transaction initiation governs, not settlement. Settlement batch should lock the distribution contract version at batch creation time.

**Q4 — Circular distributions** (rfc-02-distribution-contracts.md:139–140):
Cycle detection is required before execution. A→B→C→A creates an infinite loop in a naive execution engine. Greg's position: depth-first cycle detection before routing; maximum routing depth of 5 hops as a protocol constant; circular chains are rejected with a specific error code (not silently failed).

**Q5 — Tax and legal** (rfc-02-distribution-contracts.md:142–143):
Each routing decision should emit a structured log record with: source DID, destination DID, amount, currency, contract version, allocation label, timestamp. This is the data a tax authority would need. Greg's position: the audit log is a byproduct of the execution engine — not a separate reporting system. Every routing decision is a signed record (consistent with the Cryptographic Trust Layer proposal).

**Q6 — WeR1 integration boundary** (rfc-02-distribution-contracts.md:145–146):
This requires a direct conversation with the WeR1 team. Until that happens, the safest architectural position is: WeR1 handles distribution logic for audio specifically; imajin's distribution contract handles everything else and calls WeR1's execution logic as an adapter where audio is the asset type. Greg's position: WeR1's primitive should be wrapped as an adapter in Tier 3 of the bounty scope — not merged into the core contract schema.

**Q7 — Graceful degradation** (rfc-02-distribution-contracts.md:148–149):
The contract should declare an `on_failure` field per allocation: `hold` (transaction waits), `overflow` (reroutes to overflow), or `fail` (entire transaction fails). Greg's position: `overflow` as the protocol default for unreachable recipient DIDs; `fail` as an option for allocations the sender considers non-negotiable (e.g., covenant-required distributions).

### New Code-Level Gap Identified

The distribution contract schema has a `signature` field in the RFC. No `DistributionContract` type exists anywhere in the current codebase — not in `@imajin/fair`, not in `@imajin/pay`, not in `apps/pay/`. The contract schema and execution engine are entirely absent. This is not a bug (P-list) — it is a missing feature. But it has a dependency: the `signature` field requires the same `@imajin/auth` signing utilities proposed in Proposals 7/8, which also don't exist yet. **The distribution contract cannot be implemented before Phase 1 of the attestation layer is live.**

### Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Does the distribution contract live in `@imajin/pay`, `@imajin/fair`, or a new `@imajin/distribution` package? | Service ownership and dependency structure | New `@imajin/distribution` package — distribution is a distinct concern from payment processing or attribution formatting |
| Is the WeR1 integration boundary a blocker for MVP, or can distribution contracts launch without audio settlement? | Timeline dependency on external team | Launch without audio settlement; WeR1 adapter is Tier 3 of the bounty scope |
| Should the micro-founder layer (financial contributions as attribution) be part of the distribution contract package or RFC-01 attribution? | Attribution ledger ownership | RFC-01 attribution — financial contributions are the same primitive as code contributions, weighted differently |
| `effective_at` governs which version applies — what is the dispute resolution mechanism when `effective_at` is contested? | Legal and operational risk | Sign and timestamp every version change; the signed record is the evidence |

**Detecting resolution in the repo:**
- New TypeScript types for `DistributionContract` in `@imajin/fair`, `@imajin/pay`, or a new package
- Distribution contract execution endpoint in `apps/pay/` or new `apps/distribution/`
- Signed audit log for every routing decision
- `ADR-002` document in `docs/decisions/`

---

## 17. Intent-Bearing Transactions and Contribution Pools — RFC-05

**Authors:** Ryan Veteze, Jin
**Date:** March 3, 2026 (rfc-05-intent-bearing-transactions.md:5)
**Source:** `apps/www/articles/rfc-05-intent-bearing-transactions.md`
**Status upstream:** Draft
**Depends on:** RFC-01 (.fair attribution), RFC-02 (distribution contracts), RFC-04 (settlement protocol)
**Connects to:** Proposals 6 (.fair signing), 11 (Gas Model Ceiling), 16 (Distribution Contracts)

### Abstract (rfc-05-intent-bearing-transactions.md:12–14)

> *"This RFC extends the .fair protocol with two capabilities: intent declarations (money that carries purpose and constraints) and contribution pools (community-funded infrastructure with attributed rewards and mandatory redistribution). Together, these enable a new economic primitive: value that moves with meaning, accumulates through attribution, and redistributes by design."*

### Part 1 — Intent Declarations

**Motivation** (rfc-05-intent-bearing-transactions.md:22–24): Current payment systems move money but don't carry meaning. A $20 tip and a $20 grant and a $20 investment all look the same on the ledger. *"In a sovereign network, the reason money moves matters as much as the movement."*

**Schema extension to `.fair` manifest** (rfc-05-intent-bearing-transactions.md:28–41):

```json
{
  "fair": "0.2.0",
  "chain": [...],
  "intent": {
    "purpose": "infrastructure | living | grant | sponsorship | charitable",
    "directive": "human-readable description of intended use",
    "constraints": ["no-advertising", "open-source-only", "local-only", "no-surveillance", "attributed-only"],
    "pool": "pool_id (optional)"
  }
}
```

**Constraint enforcement model** (rfc-05-intent-bearing-transactions.md:60): *"Constraint enforcement is trust-graph-mediated. Violating a constraint doesn't block the transaction — it affects the violator's trust score. The network self-corrects through reputation, not gatekeeping."*

**Auditability** (rfc-05-intent-bearing-transactions.md:64–70): Every intent-bearing transaction is permanently auditable. The `.fair` manifest travels with the funds through every subsequent settlement — the full intent chain is traceable across all hops.

#### Greg's Position on Intent Enforcement

The trust-graph-mediated enforcement model is philosophically consistent but operationally weak at launch. Before the attestation layer (Proposals 7/8) is live and trust scores are meaningful, constraint violations have no teeth. Greg's position: intent constraints should be enforced in two phases:
1. **Phase 1 (pre-attestation layer):** constraints are logged and publicly auditable — violations are visible but don't trigger automatic consequences
2. **Phase 2 (post-attestation layer):** constraint violations trigger `flag.yellow` attestations against the violator's DID, which affect standing computation

The `constraints` field also has an intersection with the Gas Model Ceiling (Proposal 11): an Org DID that has constraint violations logged against it should pay higher gas to reach opted-in users — this is the `.fair` compliance gate proposed in Proposal 11 §6.1.

### Part 2 — Contribution Pools

**Motivation** (rfc-05-intent-bearing-transactions.md:78–80): *"Traditional funding models force a choice: donate (no returns) or invest (securities law). Contribution pools are a third path: community-funded infrastructure where attributed rewards flow back proportionally, with mandatory redistribution above thresholds."*

**Contribution rounds** (rfc-05-intent-bearing-transactions.md:124–130):

| Round | Timing | Weight |
|-------|--------|--------|
| 1 (Bootstrap) | Pre-revenue | 1.2× |
| 2 (Growth) | Early revenue | 1.1× |
| 3+ (Scale) | Established | 1.0× |

Weight multipliers are intentionally small — *"20% acknowledgment, not 10x returns. The goal is fair recognition, not wealth concentration."*

**Attribution staking** (rfc-05-intent-bearing-transactions.md:132–148): Pool funds are staked against the platform's `.fair` attribution chains. Rewards are proportional to attributed platform revenue — not speculation, not dividends, but participation in the value the platform creates.

**Mandatory redistribution — the anti-hoarding mechanism** (rfc-05-intent-bearing-transactions.md:152–175): When accumulated rewards exceed the redistribution threshold, the contributor *must* declare a distribution chain. Self-allocation is permitted but capped. Recipients must be valid DIDs in the trust graph. Circular chains are detected and rejected. *"Failure to declare within grace period → rewards pause (not lost)"* (line 175).

**Why this isn't securities — Howey test analysis** (rfc-05-intent-bearing-transactions.md:177–191):

| Howey factor | Contribution Pools |
|-------------|-------------------|
| Investment of money | Contribution to infrastructure you use |
| Common enterprise | Open network, no central management |
| Expectation of profit | Attributed rewards from usage, not speculation |
| From efforts of others | From attribution graph *including your own participation* |
| Accumulation | Mandatory redistribution above threshold |
| Transferable | Non-transferable, no secondary market |

**⚠️ Legal review required before implementation** (rfc-05-intent-bearing-transactions.md:191).

### Greg's Position on the Six Open Questions (rfc-05-intent-bearing-transactions.md:220–232)

**Q1 — Attribution decay as new modules enter** (line 222): Pool stakes should track dynamic attribution, not lock to a snapshot. Locking to a snapshot rewards early entrants whose code may have been superseded — dynamic attribution is more honest about current value. Greg's position: dynamic attribution with a floor — stakes cannot fall below 50% of their initial weight, preventing early contributors from being entirely displaced by later work.

**Q2 — Inactive contributors** (line 224): Rewards for dormant DIDs should accumulate with a decay threshold. Greg's position: accumulate for 24 months; after 24 months of DID inactivity, rewards begin redistributing to the active pool at 10% per month — consistent with the activity recency decay in the Cultural DID token context formula (Proposal 13 §3).

**Q3 — Negative attribution for removed bad actors** (line 226): This is the most architecturally complex question. If a `.fair` chain participant is removed (Trust Accountability Category C flag), retroactively zeroing their attribution would invalidate signed manifests. Greg's position: soft decay model — the removed DID's attribution weight decays from the removal date forward; historical signed manifests are not altered; pool rewards attributable to that DID's historical work stop accruing from the removal date.

**Q4 — Pool-to-pool staking** (line 228): Recursive attribution is powerful but creates cycle detection requirements across pools. Greg's position: permit pool-to-pool staking with a maximum depth of 2 (pool A stakes in pool B, pool B cannot stake in pools that stake back in pool A). Same cycle detection model as distribution contracts.

**Q5 — Governance of pool parameters** (line 230): Who adjusts round weights, redistribution thresholds, self-allocation caps? Greg's position: pool operator for pool-specific parameters (round weights, redistribution threshold); protocol constants for safety floors (maximum self-allocation cap at 60%, minimum redistribution threshold). Cultural DIDs operating pools should be able to set more restrictive parameters than the protocol defaults — but not less restrictive.

**Q6 — Tax implications** (line 232): Attributed rewards above reporting thresholds in relevant jurisdictions will require tax documentation. Greg's position: the `.fair` manifest chain is the tax documentation — every attribution event is a signed, timestamped, permanently auditable record. The execution engine should emit structured tax records per contributor per settlement period.

### New Code-Level Gap Identified

The `intent` field proposed in this RFC does not exist on `FairManifest` in `packages/fair/src/types.ts` (confirmed: file ends at line 41 with no `intent` field). This is a direct extension to the same type that P3 identifies as lacking a `signature` field. Both gaps must be resolved in the same PR — the manifest type needs both `signature` and `intent` added together to avoid two separate migrations of the same type.

**New problem flagged: P5 — FairManifest missing `intent` field** — see `problems.md` update.

### Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Does `intent` enforcement upgrade from logged-only to attestation-triggered automatically when Phase 1 attestation layer is live? | Enforcement model transition | Yes — automatic upgrade; constraints become `flag.yellow` triggers without a separate governance decision |
| Is the micro-founder layer (from RFC-02) the same as pool Round 1 contributors, or a separate primitive? | Avoids duplicating the early-contributor recognition mechanism | Same primitive — micro-founders are Round 1 pool contributors whose contribution type is `financial_contribution` instead of code or content |
| What is the protocol-level self-allocation cap: 60% (as specified in RFC-05 line 170), 40%, or governance-adjustable? | Anti-hoarding effectiveness | 60% as protocol floor; Cultural DID pools can set lower cap for their community |
| Does a pool have a DID (`did:imajin:pool:xxx` — rfc-05 line 88)? If so, can a pool be a `.fair` attribution recipient? | Pool as first-class network citizen | Yes — pool DID is required; pools can receive `.fair` attribution and redistribute it |

**Detecting resolution in the repo:**
- `intent` field added to `FairManifest` in `packages/fair/src/types.ts` (alongside P3's `signature` field)
- Pool creation and contribution endpoints in `apps/pay/` or new `apps/pools/`
- Redistribution threshold monitoring and distribution chain declaration UI
- Howey test legal review documented in `docs/decisions/` or equivalent

---

## 18. Consent Primitive — Unspecified Protocol Primitive

**Author:** Ryan Veteze (identified, not yet specified)
**Source:** `apps/www/articles/grounding-03-ARCHITECTURE.md:149–151`
**Status upstream:** TODO — explicitly unspecified in the architecture document
**Related upstream:** MJN Whitepaper, Discussion #255 (Sovereign User Data), Discussion #268 (Embedded Wallet)
**Connects to:** Proposal 6 (.fair signing), Proposal 17 (intent-bearing transactions)

### The Gap (grounding-03-ARCHITECTURE.md:149–151)

The architecture document lists four protocol-level primitives. Three are specified and implemented. One is not:

> **"3. Consent**
> TODO: Programmable consent per interaction. Not a terms-of-service checkbox. A signed declaration attached to each exchange that says exactly what the sender permits."*

This is one sentence and a TODO. Identity, attribution, and settlement are all specified, architected, and partially implemented. Consent is named as a protocol-level primitive and left blank.

### Why This Is Architecturally Significant

Every other primitive in the architecture depends on consent being specified:

- **`.fair` signing** (Proposal 6): a manifest can declare who gets attribution — but who consented to the transaction that generated it? The manifest proves *who* attributed, not *that* the exchange was consented to.
- **Intent declarations** (Proposal 17 / RFC-05): intent carries purpose and constraints, but constraints are enforced by trust score, not by a prior consent declaration from the recipient. Intent is sender-declared; consent is receiver-declared.
- **Stream 2 (Declared-Intent Marketplace)**: the user opts in to receiving commercial offers — this is a consent declaration. It is currently implemented as a database flag, not as a signed protocol-level consent record.
- **Stream 3 (automated node-to-node settlement)**: when two nodes settle automatically, what signed consent record proves that the receiving node agreed to the transaction terms? Without a consent primitive, Stream 3 settlement is structurally identical to the problem with unsigned `.fair` manifests — it is a claimed exchange, not a proven one.
- **Trust Accountability Framework** (Proposal 2): flags require evidence of harm. The most actionable evidence of harm is a consent violation — a transaction that occurred outside the declared consent scope of one of its parties.

### What a Consent Primitive Would Look Like

The architecture doc gives one sentence: *"a signed declaration attached to each exchange that says exactly what the sender permits."* Greg's position: the consent primitive needs to be both *sender-side* and *receiver-side*:

```typescript
export interface ConsentDeclaration {
  issuer_did: string;      // the DID giving or withdrawing consent
  subject_did: string;     // the DID being consented to interact with
  scope: string[];         // what is consented to: 'settlement', 'messaging', 'data-access', 'inference'
  constraints: string[];   // same vocabulary as RFC-05 intent constraints
  valid_from: string;      // ISO 8601
  valid_until?: string;    // optional expiry — permanent if omitted
  revocable: boolean;      // can the consented DID rely on this being stable?
  signature: string;       // Ed25519 by issuer_did
}
```

The consent declaration travels with the exchange — attached to the `.fair` manifest or the settlement instruction — as proof that the exchange occurred within the declared scope of both parties.

### Connection to the Intent Constraint Model (RFC-05)

RFC-05's constraint enforcement model (rfc-05-intent-bearing-transactions.md:60) is a unilateral sender declaration: *"I intend this money for X, not Y."* Consent is the bilateral version: *"I agree to receive this exchange under these conditions."* The two primitives are complementary. An exchange has full cryptographic integrity only when:
- The sender has declared intent (RFC-05 `intent` field)
- The receiver has declared consent (Consent primitive)
- The attribution is signed (Proposals 6/7/8)
- The distribution is declared (RFC-02 distribution contract)

None of these substitutes for the others. The consent primitive is the missing fourth element.

### Greg's Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Is consent per-exchange or per-relationship? | Per-exchange is most granular but operationally heavy; per-relationship is practical but less auditable | Per-relationship with per-exchange override — a standing consent declaration with the ability to override for specific exchange types |
| Does a consent declaration live in `auth.attestations` (as a `consent.given` attestation type), or as a separate table? | Schema ownership | In `auth.attestations` as a controlled type — `consent.given` and `consent.revoked` — consistent with the attestation layer proposal |
| What happens to an in-flight transaction when consent is revoked mid-flight? | Settlement atomicity | The settlement executes under the consent in effect at initiation; revocation applies to future transactions only |
| Is Stream 2 opt-in (Declared-Intent Marketplace) currently a consent declaration? | If yes, it needs to be signed and verifiable; if no, it needs to be migrated | Yes — the Stream 2 opt-in should be stored as a `consent.given` attestation with `scope: ['commercial-intent-matching']` |
| Does the Embedded Wallet RFC (#268) specify consent for delegated key actions? | Delegation without consent bounds is the same gap as unsigned `.fair` manifests | RFC-268 should explicitly include a consent scope in the key derivation path — an agent key that can only act within declared consent scope |

**Detecting resolution in the repo:**
- `ConsentDeclaration` type added to `@imajin/auth` or `@imajin/fair`
- `consent.given` and `consent.revoked` added to the attestation type controlled vocabulary
- Architecture doc `grounding-03-ARCHITECTURE.md:151` updated from TODO to a specification
- Settlement routes in `apps/pay/` check for a valid consent record before processing
- Stream 2 opt-in migrated to a signed `consent.given` attestation
