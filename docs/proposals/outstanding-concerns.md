# Outstanding Concerns
*Unresolved and partially-resolved questions from architectural review — March 2026*
*Last cross-referenced against upstream: March 11, 2026 (HEAD: 6ca08d3)*

Items are ordered by priority. Each entry includes the concern, current status, and what a resolution requires.

---

## Critical — Requires Specification Before Launch Claims

### 1. Social Graph Portability (Exit Guarantee)

**From:** Historical Context §4.6, Concerns & Resolutions §7

**The concern:**
The sovereignty floor rests on portable identity. But DID portability and social graph portability are different things.

- Cryptographic key portability is solid — you take your keypair anywhere.
- Trust graph portability is unspecified: can you take your accumulated trust relationships, reputation, and attestations when you leave a node?

If you take your keys but start over socially, exit costs are substantially higher than the framing suggests. Higher exit costs mean weaker operator accountability — the threat to leave is less credible.

**What resolution requires:**
An explicit architectural answer to: *are trust relationships stored on the node or on the DID?*

- If **node-stored**: portability is keys-only, exit costs are high, the sovereignty claim is weakened.
- If **DID-stored or protocol-level**: true portability holds, the sovereignty claim is fully load-bearing.

This should be the next architectural specification priority before the sovereignty guarantee is published as a core feature.

**Code finding (March 10):** Trust graph IS node-stored. Confirmed in `packages/trust-graph/src/schema.ts` — pod membership lives in `connections.pod_members`, a Postgres table on the node. RFC-001 (`docs/rfcs/RFC-001-identity-portability.md`, status: Draft) proposes exporting `connections.json` as part of a full portable identity context package — this is the active resolution path. Implementation tickets not yet created. Track RFC-001 progress.

**Proposals filed (March 10):** Proposal 5 (BaggageDID) and Proposal 7 (Cryptographic Trust Layer) in `current-proposals.md` address this concern directly. Proposal 8 (Attestation Data Layer — Full Architecture) extends Proposal 7 with two additional unaddressed risks: node dark / orphaned attestation history (§4.1) and cascading revocation when an issuer DID is compromised (§4.2). BaggageDID closes the departure event gap specifically. Cryptographic Trust Layer is the architectural prerequisite — BaggageDID must be built on top of the attestation layer, not on unsigned DB records.

---

### 2. .fair Attribution Integrity for Automated Nodes

**From:** Historical Context §4.4, Concerns & Resolutions §4

**The concern:**
The claim that all five streams settle through .fair with unified, transparent attribution is asserted but not fully verified. Machine-to-machine settlements (Stream 3) raise a specific question: who writes the .fair manifest for an automated API call between two nodes?

If agents write their own attribution records, transparency requires auditable agent behavior — not just the protocol existing. Attribution is only as good as what gets declared in the manifest.

**What resolution requires:**
Explicit design of the enforcement layer for automated nodes. Likely requires cryptographic signing of manifests by the originating DID — deterministic attribution rather than declared attribution. The protocol layer is sound; the signing and auditability layer for agent-generated manifests needs specification.

**Code finding (March 10):** `FairManifest` (in `packages/fair/src/types.ts`) is an unsigned TypeScript object — `attribution: FairEntry[]` with `did`, `role`, `share`. No cryptographic signing requirement exists anywhere in the package. A manifest can be created and declared by anyone without proof of who authored it. The concern is real and the gap is confirmed in the codebase.

**Proposals filed (March 10):** Proposal 6 (.fair Attribution Integrity) and Proposal 12 (Declaration Granularity Standards — Stream 2) in `current-proposals.md` address this directly — minimum viable four-change implementation, Greg's positions on all five open questions, and a decisions table for Ryan.

---

## Design Choices — Require Explicit Documentation

### 3. Governance Equity vs. Economic Equity

**From:** Historical Context §4.2, Concerns & Resolutions §5

**The concern:**
Streams 1–4 provide economic equity for all participants. Governance equity is a separate and unresolved question.

The Network of Souls governance model — trust-weighted leadership, compute as vote — applies disproportionately to Stream 5 users. The 90% who only transact participate in a system whose direction is set by the 10% running inference. Economic participation and governance participation are structurally different; treating one as a proxy for the other papers over this asymmetry.

**Current status:** Analysis complete. Three-layer governance structure identified; community governance resolved by Cultural DID specification; remaining gap is network-level influence and unspecified Foundation governance mechanism.

**What resolution requires:**
Explicit documentation stating: the system provides economic equity for all participants; governance influence scales with demonstrated expertise and trust investment. The acceptability of this asymmetry depends on how "leadership" in the Network of Souls translates into protocol-level decisions. That translation needs to be specified.

**Proposals filed (March 10):** Proposal 13 (Cultural DID Complete Specification) resolves the governance equity concern at the community layer — Cultural DID token context is contribution-weighted, not inference-weighted. Proposal 14 (Governance Equity vs. Economic Equity) maps the three-layer governance structure, identifies the specific documentation deliverables needed, and frames the Foundation governance mechanism as the most urgent unresolved decision.

---

### 4. Vetting and Early-Member Influence (Org DID)

**From:** Concerns & Resolutions §8

**The concern:**
The proposed Org DID vetting mechanism — covenant as standard, trust-graph attestation as mechanism, no central approval committee — is architecturally consistent. But early members accumulate outsized influence over what kinds of businesses are ever permitted on the network. This compounds over time.

**Current status:** Identified, partially addressed.

**What resolution requires:**
A deliberate position on whether this compounding effect is acceptable, or whether a counterbalance mechanism is needed. Options include: time-decay on attestation weight for vetting decisions, a rotating attestor pool, or explicit acknowledgment that early-member influence is a known property of the system rather than a flaw.

**Proposal filed (March 10):** Proposal 10 (Org DID Vetting and Early-Member Influence) in `current-proposals.md` proposes the Composite Attestation Model as a fourth position — requiring three simultaneous inputs (standing-weighted vouches, unweighted soft-loading evidence, and covenant compliance declaration) none of which can be gamed in isolation. The soft-loading floor is democratic and decoupled from trust graph depth. The covenant document is identified as the most urgent deliverable.

---

## Calibration — Open Design Questions, Not Structural Gaps

### 5. Gas Model Ceiling (Stream 2)

**From:** Historical Context §4.3, Concerns & Resolutions §3

**The concern:**
The three-tier gas model addresses graph distance well. But capital could achieve saturation of the opted-in pool through volume even without buying trust-graph position. If a well-funded business pays high gas to reach every opted-in user in a category repeatedly, volume becomes influence within a consent-based model — and the user experience degrades.

**What resolution requires:**
Either a per-recipient rate limit (not per-sender), or gas costs that scale with frequency to the same user — not just with graph distance. This keeps the consent model intact while preventing volume from functioning as a proxy for influence.

**Proposal filed (March 10):** Proposal 11 (Gas Model Ceiling — Stream 2) in `current-proposals.md` recommends frequency-scaled gas (Mechanism C) as the primary mechanism with a defined multiplier curve, plus a user-configurable sovereign rate limit overlay. Adds cluster-aware gas computation (depends on attestation layer) and .fair compliance as a gas gate.

---

### 6. Declaration Granularity Standards (Stream 2)

**From:** Historical Context §4.3, Concerns & Resolutions §3

**The concern:**
Local profile matching (business sees match count, not the profile) is the correct privacy model. But match quality depends on declaration granularity. Coarse categories ("specialty coffee, vinyl, local restaurants") resist inference attacks. Fine-grained declarations ("Ethiopian natural process, within 2km, Tuesday mornings") start to reconstruct a detailed profile — even if it stays on the user's node.

**What resolution requires:**
A .fair-equivalent standard for permissible declaration categories, or explicit guidance on declaration granularity. Who governs this, and what enforcement looks like, needs to be specified before Stream 2 is live.

**Proposal filed (March 10):** Proposal 12 (Declaration Granularity Standards — Stream 2) in `current-proposals.md` recommends k-anonymity threshold enforcement (Option B) as the primary mechanism with sensitive category floors at the protocol level. Adds a `DeclarationEntry` type system with Ed25519 signing and `sensitivity` enum. Together with Proposal 11, defines the complete privacy envelope for Stream 2.

---

## Open Specification — Cultural DID Primitive

### 7. Cultural DID — Open Specification Questions

**From:** Historical Context §6, Concerns & Resolutions §9

The Cultural DID proposal is architecturally sound and the governance model is coherent. The following specific questions require values and implementation decisions before specification is complete.

**Proposal filed (March 10):** Proposal 13 (Cultural DID Complete Specification) in `current-proposals.md` answers all seven questions:
- Minimum founding members: **5**; token context threshold: **≥ 100** (calibratable)
- Token context: weighted query over attestations + .fair contributions + trust graph depth + recency decay; **Stream 5 not an input**
- Governance weight ceiling: **33%** per Governing Member; automatic redistribution when exceeded
- Removal: behavioral process — governance.flag → 14-day response → quorum review (minimum 3, excluding flagger and flagged); permanent signed outcome
- Founding member compromise: three scenarios (key rotation, DID revocation, below-minimum count) each with specific handling including 90-day grace period and dormant state
- Cultural-Org DID relationship: **yes** — declared-and-attested connection between separate entities; accountability propagation is indirect
- Dissolution: high-quorum vote; `fair.attribution.resolution` attestations alongside original manifests (originals never modified); contested dissolution process with mediator

---

---

## Flagged Concerns — From Code Review

*These concerns were surfaced by reading the upstream codebase directly. They are not from external analysis — they are gaps between what the architecture proposes and what the code currently implements.*

### F1. Attestation Data Layer Does Not Exist

**Flagged:** March 10, 2026
**Affects:** Progressive Trust Model (current-proposals.md §1), Trust Accountability Framework (§2), Cultural DID governance model

The Progressive Trust Model proposal states: *"Standing is computed, not assigned. It's a query over attestation history on `auth.identities`."* And: *"Attestations are the mechanism: 'attended event X', 'vouched by DID Y', 'checked in at Org Z' — typed, signed, verifiable."*

**What the code actually has:** `auth.identities` has no attestation fields (`id`, `type`, `publicKey`, `handle`, `name`, `avatarUrl`, `metadata`, `createdAt`, `updatedAt`). The word "attestation" in the codebase refers exclusively to *build attestation* — cryptographic proof that a node is running approved software (`packages/auth/src/types/node.ts`, `apps/registry/src/db/schema.ts`). These are node-level integrity proofs, completely unrelated to identity trust standing.

There is no table for: vouches, event attendance records as attestations, standing scores, flag records, or onboarding milestones.

**What this means:** Every proposal that depends on attestation-based standing — Progressive Trust Model, Trust Accountability Framework, Cultural DID governance thresholds — is proposing a data layer that does not yet exist. Before any of these can be implemented, a new attestation schema needs to be designed and the terminology needs to be distinct from node build attestation.

**Proposal filed (March 10):** Proposal 7 (Cryptographic Trust Layer) in `current-proposals.md` is the full architectural response. Complete `auth.attestations` schema, controlled type vocabulary, standing computation formula, privacy architecture, agent DID questions, open questions for Ryan with Greg's positions, and three-phase implementation path.

**Resolution requires:** Design and specification of an `attestations` table (or equivalent) separate from the existing node attestation system. Suggested home: `auth` schema or a new `trust` schema. Must define: attestation types, who can issue them, how they are signed, how standing is computed from them.

---

### F2. Identity Tier is Stored Cross-Service, Not in Auth

**Flagged:** March 10, 2026
**Affects:** Progressive Trust Model, any permission check across the platform

The `soft`/`hard` DID tier — the most fundamental identity property after the DID itself — is stored in `profile.profiles.identity_tier`, not in `auth.identities`. The session API (`apps/auth/app/api/session/route.ts`) queries the profile service's Postgres schema to resolve tier:

```ts
const profileRows = await db.execute(
  sql`SELECT identity_tier FROM profile.profiles WHERE did = ${session.sub} LIMIT 1`
);
```

If the profile service is unavailable, tier defaults to `'hard'` — full access — rather than minimal access. This is a fail-open security posture for an identity-critical property.

The Progressive Trust Model proposes adding a third tier (`preliminary`/`established`) as a standing level. If tier continues to live in the profile service, permission checks will remain scattered and the fail-open behaviour will extend to the new tiers.

**Resolution requires:** A position on where standing/tier should canonically live. Options: move to `auth.identities` (single source of truth, correct fail-closed default), or formalize the profile service as the authoritative tier store with explicit service-dependency guarantees and a fail-closed default.

---

### F3. Discussion #272 and #252 Confirm Greg's Proposals Are in Upstream

**Flagged:** March 10, 2026
**Informational — not a gap, a positive signal**

GitHub Discussion #272 (Community Issuance Network) is Greg's "Commons Layer" proposal, posted verbatim. Discussion #252 (Cultural DID) is Greg's Cultural DID proposal, migrated from #247. Both are in the official discussions with no comments yet — they are open for community input.

This means two of the four proposals in `current-proposals.md` are now formally in the upstream discussions. The proposals are live. Monitor for responses from Ryan or community.

---

### F4. Node Attestation Architecture Could Inform Identity Attestation Design

**Flagged:** March 10, 2026
**Informational — design opportunity**

The existing node attestation system (`packages/auth/src/types/node.ts`, `apps/registry/src/db/schema.ts`) has a well-designed pattern: a signed payload covering specific fields, a build hash, a version, a timestamp, and an Ed25519 signature. The registry stores these and verifies them on heartbeat.

The *form* of this system — signed, timestamped, verified attestations stored in a registry — is exactly what identity attestations would need. The design work is done at the node level; the proposal layer needs an equivalent at the identity level. This is worth noting when drafting the attestation schema for F1.

---

### F5. Three New RFCs in Upstream Repo — Not Yet in Proposals (March 11 Review)

**Flagged:** March 11, 2026
**Source:** Committed in `e079b80` — `apps/www/articles/rfc-01-fair-attribution.md`, `rfc-02-distribution-contracts.md`, `rfc-05-intent-bearing-transactions.md`

Three new RFCs appeared in the upstream repo as articles since the March 10 review. All three extend the `.fair` protocol in directions not yet covered by our proposals:

- **RFC-01** (`.fair` attribution from commit history): Git-based attribution objects per merged PR; DID linking from GitHub handles; three-tier weight signals; destined to become `ADR-001`. Explicitly positioned as *"the template for .fair attribution for everything"* (`rfc-01-fair-attribution.md:13`).
- **RFC-02** (Programmable Distribution Contracts): Versioned, signed distribution contracts attached to every sovereign presence; WeR1 primitive generalized; micro-founder layer; auditable values layer; destined to become `ADR-002`.
- **RFC-05** (Intent-Bearing Transactions and Contribution Pools): `intent` field extension to `.fair` manifest; contribution pool mechanism with mandatory redistribution; Howey test analysis. **Authors: Ryan Veteze and Jin.** RFC-05 is the most complete spec; it has clear implementation phases and was co-authored by the project leads.

**Proposals filed (March 11):** Proposals 15, 16, and 17 in `current-proposals.md` address all three RFCs with analysis and Greg's positions on all open questions.

**New problem detected:** P5 — `FairManifest` missing `intent` field (`packages/fair/src/types.ts`). Should be fixed in the same PR as P3 (missing `signature` field).

---

### F6. Consent Primitive Marked TODO in Architecture Doc (March 11 Review)

**Flagged:** March 11, 2026
**Source:** `apps/www/articles/grounding-03-ARCHITECTURE.md:149–151`

The architecture document lists four protocol-level primitives (Identity, Attribution, Consent, Settlement). Three are specified. Consent is:

> *"TODO: Programmable consent per interaction. Not a terms-of-service checkbox. A signed declaration attached to each exchange that says exactly what the sender permits."*

This is a one-sentence TODO for a primitive that every other part of the protocol depends on. Without a specified consent model, `.fair` signing proves attribution but not consent; intent declarations (RFC-05) are sender-only; Stream 2 opt-in is a database flag rather than a signed protocol record; Stream 3 automated settlement has no receiver-declared consent record.

**Proposal filed (March 11):** Proposal 18 (Consent Primitive) in `current-proposals.md` proposes a `ConsentDeclaration` type, its place in `auth.attestations` as `consent.given` / `consent.revoked` attestation types, and the relationship to Stream 2 opt-in, Stream 3 settlement, and the Embedded Wallet's delegated key model.

---

### F7. Architecture Doc Explicitly Contradicts P2 (March 11 Review)

**Flagged:** March 11, 2026
**Source:** `apps/www/articles/grounding-03-ARCHITECTURE.md:378`
**Informational — strengthens P2 case**

The architecture document's Schema Principles section states:

> *"No cross-service joins — services communicate via API, not shared tables."*

The `SELECT identity_tier FROM profile.profiles WHERE did = ${session.sub}` query in `apps/auth/app/api/session/route.ts:52–54` is a direct violation of this documented principle. P2 is no longer just an architectural concern raised by Greg — it is a documented violation of the project's own stated schema principles. This should be cited when raising P2 with Ryan.

---

## Resolved — For Reference

The following concerns were raised and are considered addressed. Details in `historical-context.md`.

| Concern | Resolution |
|---------|-----------|
| Presence ≠ Accountability (Unit) | Unit reframed as attention function; structural accountability lives in the stack |
| Personal AI as participation requirement | Stream 5 is additive; base economy requires no AI |
| Advertising as revenue (Stream 2) | Structural contradiction resolved by changing data model to Declared-Intent Marketplace |
| Businesses as nodes (same trust dynamics) | Org DID proposed as structurally distinct primitive with reduced privilege and mandatory transparency |
| BBS analogy at scale | Partially resolved; trust graph and portability provide structural accountability at scale |
