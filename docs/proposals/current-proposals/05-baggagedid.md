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

