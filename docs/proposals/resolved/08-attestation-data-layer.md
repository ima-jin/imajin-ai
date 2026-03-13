## STATUS: RESOLVED
**Resolved:** 2026-03-13
**Evidence:** Ryan's Identity & Attestation Hardening Roadmap (March 13) — Phase 1, issue #320 ("auth.attestations schema"); whitepaper v0.3 — "Attestation Data Layer" new section credited
**Outcome:** The `auth.attestations` schema is adopted as Phase 1 of the Identity Hardening Roadmap (issue #320). The naming collision (NodeAttestation vs identity attestation) is resolved by creating a new table rather than repurposing the existing build attestation. The bilateral root record pattern and signed attestation types (`vouch.given`, `flag.yellow`, `checkin.verified`, `event.attendance`) are included in the schema specification. Phase 1 also shares the `sign()`/`verify()` keystone (#316) with the .fair hardening roadmap.
**Implementation:** Whitepaper v0.3 — concept credited. Issue #320 created — schema migration and types not yet in code.

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

