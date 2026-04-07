# Outstanding Concerns
*Unresolved and partially-resolved questions from architectural review — March 2026*
*Last cross-referenced against upstream: April 7, 2026 (HEAD: 227b2785)*

**April 7 audit (93 commits since April 3):**
- C04 (Org DID vetting) — **SUBSTANTIALLY RESOLVED.** Group identities with real Ed25519 keypairs, multi-controller access, service-scoped permissions. External vetting/attestation by third parties still missing.
- C05 (Gas model ceiling) — **SPEC COMPLETE.** Fee model v3: 1¢ per non-economic op, 100% to node, bilateral signing. No code yet. Governance bounds flagged as open question.
- C10 (Relay auth) — **ADVANCED.** DFOS 0.7.0 adopted. Relay auto-bootstraps identity (#575). `requireAuth` validates `actingAs` across all services. Cross-service relay auth middleware still TODO.
- C11 (isValidDID) — **STILL OPEN.** Both bugs unchanged in `packages/auth/src/providers/keypair.ts`.
- C13 (Org DID covenant) — STILL OPEN. No covenant document drafted. Group identities have no covenant/terms mechanism.
- C14 (Foundation governance) — STILL OPEN. Fee model v3 defers protocol fee governance to "trust-graph-weighted voting" but no mechanism specified.
- C15 (Agent authority scope) — STILL OPEN. `FairEntry` still cannot distinguish human/agent.
- C16 (Family DID primitive) — **SCHEMA COMPLETE.** `scope: 'family'` in group identities. No family-specific UX.
- C17 (Stale issue taxonomy) — STILL OPEN. No triage work observed.

**April 3 audit:**
- C10 (Relay auth) — PARTIALLY RESOLVED. RFC-22 rewritten three times; final model: consent-and-sign redirect as primary cross-platform auth.
- C11 (isValidDID) — STILL OPEN. Both bugs unchanged.
- C12 (Consent primitive) — PARTIALLY RESOLVED. DID consent preferences + interest signals shipped in registry (#538/#539). Unsubscribe flow with HMAC verification + RFC 8058 headers. Still no `ConsentDeclaration` type or per-transaction consent.
- C02 (.fair automated nodes) — PARTIALLY RESOLVED. Signing infra live; agent scope encoding + enforcement toggle pending.
- C03 (Governance equity) — PARTIALLY RESOLVED. Community-layer done + service-scoped controller access; Foundation governance unspecified.
- C08 (Dark graph clustering) — PARTIALLY RESOLVED. RFC-13/15 model; cluster detection primitives pending.
- F6 (Consent primitive) — PARTIALLY RESOLVED. P18 specced; RFC-19 consent screen; email infra adds DID consent preferences. No new consent work in April 7 sprint.

**New upstream since April 3:**
- **Forest infrastructure** — Group identities (#587), forest config (#592/#593), forest switcher (#588), contextual onboard (#597), scope-aware services (all 12 userspace)
- **Fee model v3** — Four-layer (protocol + node + buyer credit + scope fee = 2.0% default). Dual-token (MJN + MJNx). Gas fees (1¢/op).
- **DFOS 0.7.0** (#535) — Library conformance, deleted 924 lines custom ingest, relay auto-bootstrap (#575)
- **Connections refactor** (#577) — First-class connections table, nicknames table, O(1) DID pair lookup
- **Chat** — Nicknames (#579), reactions fix (#533), group access (#582), group membership management (#570/#571)
- **Light mode** (#534) — Dark/light toggle across all services
- **OG metadata** (#8) — 7 services gained social cards
- **RFC-24** — Knowledge Surfaces (learn + MCP + queryable profile)
- **Launcher as landing page** — Service grid with live stats, forest-aware filtering, old content moved to `/project`

**Previously resolved:** C01 (social graph portability), C07 (Cultural DID specification), C09 (migration system integrity), C18 (April 1 demo blockers)

Items are ordered by priority. Each entry includes the concern, current status, and what a resolution requires.

---

## Critical — Pre-Production Blockers

### C09. Migration System Integrity — RESOLVED

**Resolved:** March 27, 2026. See `resolved-concerns/c09-migration-system-integrity.md`.
Ryan kept file-based migrations but added per-service tracking (`scripts/migrate-service.mjs`), pre-flight validation in `build.sh`, and build-fail-on-migration-error. Drift detection via `npm run db:generate`.

---

### C10. Relay Authorization Gap — PARTIALLY RESOLVED

**Flagged:** March 23, 2026
**Priority:** HIGH — pre-production blocker
**Source:** Issue #454
**Updated:** March 30, 2026

DFOS relay is live in registry. DFOS 0.6.0 (PR #518) provides chain-level integrity via JWS-signed operations — each operation is cryptographically signed by the DID holder, and the relay verifies JWS signatures during ingestion (`ingestOperations060()` in `apps/registry/src/relay/ingest.ts`). This means forged operations are rejected at the protocol level.

**RFC-22 (Federated Authentication)** — drafted March 30 — provides the full architecture for cross-relay auth: signed attestations, challenge-nonce freshness, four key custody tiers (custodial KMS, stored key, self-custody, local-first). This is the design that will gate relay write endpoints.

**What's still missing:** The relay POST `/operations` endpoint (`apps/registry/src/relay/create-relay.ts:42–54`) has no session/JWT middleware — any client can submit operations. The JWS validation catches forged operations but does not prevent DoS (submitting valid but unwanted operations). RFC-22's attestation-based auth is the designed solution but not yet deployed.

**Resolution path:** Implement RFC-22's attestation-based auth on relay write paths; reads remain open. See `c10-relay-authorization-gap.md`.

---

## Critical — Requires Specification Before Launch Claims

### C02. .fair Attribution Integrity for Automated Nodes

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

### C03. Governance Equity vs. Economic Equity

**From:** Historical Context §4.2, Concerns & Resolutions §5

**The concern:**
Streams 1–4 provide economic equity for all participants. Governance equity is a separate and unresolved question.

The Network of Souls governance model — trust-weighted leadership, compute as vote — applies disproportionately to Stream 5 users. The 90% who only transact participate in a system whose direction is set by the 10% running inference. Economic participation and governance participation are structurally different; treating one as a proxy for the other papers over this asymmetry.

**Current status:** Analysis complete. Three-layer governance structure identified; community governance resolved by Cultural DID specification; remaining gap is network-level influence and unspecified Foundation governance mechanism.

**What resolution requires:**
Explicit documentation stating: the system provides economic equity for all participants; governance influence scales with demonstrated expertise and trust investment. The acceptability of this asymmetry depends on how "leadership" in the Network of Souls translates into protocol-level decisions. That translation needs to be specified.

**Proposals filed (March 10):** Proposal 13 (Cultural DID Complete Specification) resolves the governance equity concern at the community layer — Cultural DID token context is contribution-weighted, not inference-weighted. Proposal 14 (Governance Equity vs. Economic Equity) maps the three-layer governance structure, identifies the specific documentation deliverables needed, and frames the Foundation governance mechanism as the most urgent unresolved decision.

---

### C04. Vetting and Early-Member Influence (Org DID)

**From:** Concerns & Resolutions §8

**The concern:**
The proposed Org DID vetting mechanism — covenant as standard, trust-graph attestation as mechanism, no central approval committee — is architecturally consistent. But early members accumulate outsized influence over what kinds of businesses are ever permitted on the network. This compounds over time.

**Current status:** Identified, partially addressed.

**What resolution requires:**
A deliberate position on whether this compounding effect is acceptable, or whether a counterbalance mechanism is needed. Options include: time-decay on attestation weight for vetting decisions, a rotating attestor pool, or explicit acknowledgment that early-member influence is a known property of the system rather than a flaw.

**Proposal filed (March 10):** Proposal 10 (Org DID Vetting and Early-Member Influence) in `current-proposals.md` proposes the Composite Attestation Model as a fourth position — requiring three simultaneous inputs (standing-weighted vouches, unweighted soft-loading evidence, and covenant compliance declaration) none of which can be gamed in isolation. The soft-loading floor is democratic and decoupled from trust graph depth. The covenant document is identified as the most urgent deliverable.

---

## Calibration — Open Design Questions, Not Structural Gaps

### C05. Gas Model Ceiling (Stream 2)

**From:** Historical Context §4.3, Concerns & Resolutions §3

**The concern:**
The three-tier gas model addresses graph distance well. But capital could achieve saturation of the opted-in pool through volume even without buying trust-graph position. If a well-funded business pays high gas to reach every opted-in user in a category repeatedly, volume becomes influence within a consent-based model — and the user experience degrades.

**What resolution requires:**
Either a per-recipient rate limit (not per-sender), or gas costs that scale with frequency to the same user — not just with graph distance. This keeps the consent model intact while preventing volume from functioning as a proxy for influence.

**Proposal filed (March 10):** Proposal 11 (Gas Model Ceiling — Stream 2) in `current-proposals.md` recommends frequency-scaled gas (Mechanism C) as the primary mechanism with a defined multiplier curve, plus a user-configurable sovereign rate limit overlay. Adds cluster-aware gas computation (depends on attestation layer) and .fair compliance as a gas gate.

---

### C06. Declaration Granularity Standards (Stream 2)

**From:** Historical Context §4.3, Concerns & Resolutions §3

**The concern:**
Local profile matching (business sees match count, not the profile) is the correct privacy model. But match quality depends on declaration granularity. Coarse categories ("specialty coffee, vinyl, local restaurants") resist inference attacks. Fine-grained declarations ("Ethiopian natural process, within 2km, Tuesday mornings") start to reconstruct a detailed profile — even if it stays on the user's node.

**What resolution requires:**
A .fair-equivalent standard for permissible declaration categories, or explicit guidance on declaration granularity. Who governs this, and what enforcement looks like, needs to be specified before Stream 2 is live.

**Proposal filed (March 10):** Proposal 12 (Declaration Granularity Standards — Stream 2) in `current-proposals.md` recommends k-anonymity threshold enforcement (Option B) as the primary mechanism with sensitive category floors at the protocol level. Adds a `DeclarationEntry` type system with Ed25519 signing and `sensitivity` enum. Together with Proposal 11, defines the complete privacy envelope for Stream 2.

---

## Open Specification — Cultural DID Primitive

### C07. Cultural DID — RESOLVED

**Resolved:** March 17, 2026
**See:** `resolved-concerns/c07-cultural-did-specification.md`

All seven open specification questions answered in RFC-07 (upstream `docs/rfcs/RFC-07-cultural-did.md`). Founding member minimum, token context formula, governance weight ceiling, removal process, dissolution semantics, and Cultural-Org DID relationship all specified.

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

---

## 8. Dark Graph Clustering

**From:** Trust Accountability Framework §2, Presence Boundary Enforcement #344
**Filed:** March 15, 2026

When bad actors are attested and their trust distance from the legitimate network grows, they cluster rather than disappear — forming self-reinforcing parallel trust networks. Within their cluster, standing looks valid; from outside, they are disconnected. The network degrades their experience organically (no legitimate presences, no commercial reach, boring feed) but doesn't eliminate them.

**Open questions:** Is this a bug or a feature? Should dark graphs be detectable at protocol level? Can they be weaponized by bridging one member in first? What is the rehabilitation path? How do we distinguish organized bad actors from legitimate disconnected communities?

**What resolution requires:** Graph topology analysis primitives (bridge count, internal density), clear governance level (protocol vs. application vs. user), rehabilitation mechanisms, and Cultural DID distinction (organic community clusters vs. organized fraud clusters).

See `c08-dark-graph-clustering.md` for full analysis.

**Related:** #344 (presence boundary), Proposals 01/02 (resolved), c03 (governance equity)

---

### C11. isValidDID Format Inconsistency

**Flagged:** March 23, 2026 (first identified March 13, 2026)
**Priority:** MEDIUM — latent bug, blast radius widening with DFOS adoption
**Source:** `packages/auth/src/providers/keypair.ts:223` and `:49`

Two persistent format bugs in `packages/auth` that have survived every sprint since March 13:

- **Bug 1 — `isValidDID()` (line 223):** Validates only 16-char hex suffix (`suffix.length !== 16`). Rejects soft DIDs (44-char nanoid since #371) and preliminary DIDs (base58 pubkey ~44 chars). Any code calling `isValidDID()` on a valid identity returns `false`.
- **Bug 2 — `createDID()` (line 49):** Generates `did:imajin:{16-char hex prefix}` — truncated. Server generates `did:imajin:{full base58 pubkey}`. Different DID strings for the same keypair.

Blast radius is limited today (chain-based resolution bypasses `isValidDID()`), but `getPublicKeyPrefixFromDID()` at line 238 calls it as a guard and any `@imajin/auth` consumer will silently reject valid identities. Widening as DFOS adoption spreads.

**Resolution:** `isValidDID()` accept all three formats (suffix 16–50 chars, URL-safe charset); `createDID()` deprecated or updated to full base58. See `c11-isvaliddid-format-inconsistency.md`.

---

## New — March 27 Extraction from Resolved and Active Proposals

### C12. Consent Primitive Remains Unspecified — PARTIALLY RESOLVED

**Extracted from:** P18 (Consent Primitive), F6 (Architecture Doc TODO)
**Priority:** HIGH — blocks Stream 2 and Stream 3 launch claims
**Filed:** March 27, 2026
**Updated:** April 3, 2026

Consent is one of four named protocol-level primitives (Identity, Attribution, Consent, Settlement). The architecture doc lists it as a one-sentence TODO. RFC-19's consent screen handles app-level authorization, but per-transaction consent — a signed declaration attached to each exchange — does not exist.

**What's shipped since March 30:**
- **DID consent preferences** in registry (`apps/registry/app/api/preferences/`) — per-DID globalMarketing, autoSubscribe toggles
- **Per-scope interest channels** — fine-grained consent per app scope (events, learn, coffee, etc.)
- **Unsubscribe flow** — RFC 8058 one-click unsubscribe with HMAC token verification + CAN-SPAM compliance
- **Interest signals** — attestation types automatically create interest records (e.g., `ticket.purchased` → events interest)
- **RFC-22 consent-and-sign redirect** — consent screen is now the primary cross-platform auth flow

**What's still missing:**
- No `ConsentDeclaration` type as a protocol primitive
- No `consent.given` / `consent.revoked` attestation types in the controlled vocabulary
- Settlement routes do not check for consent
- Stream 2 opt-in remains a database flag, not a signed protocol record
- Per-transaction consent for Stream 3 automated settlement not designed

**Assessment:** The email/notification infrastructure implements app-level consent (preferences, unsubscribe). RFC-22's consent-and-sign redirect implements cross-platform consent. But the protocol-level primitive — a signed declaration attached to each exchange — still does not exist. The gap is narrowing but the structural piece is not yet specified.

**Resolution requires:** `ConsentDeclaration` type, `consent.given`/`consent.revoked` attestation types, settlement route enforcement, Stream 2 opt-in migration from DB flag to attestation.

**Related:** F6, P18, C02 (.fair signing), RFC-19 §consent, RFC-22 §consent-and-sign

---

### C13. Org DID Covenant Document Does Not Exist

**Extracted from:** P10 (Org DID Vetting)
**Priority:** HIGH — must exist before first Org DID claim
**Filed:** March 27, 2026

The Org DID vetting model requires a covenant document — a behavioral contract that every Org DID must sign at claim time. This document is identified as P10's "most urgent deliverable" because once the first businesses are admitted, the covenant is retroactively fixed by those admissions. Writing it after admission is too late.

Additionally, three attestation types required for Org DID vetting (`org.founding`, `org.checkin.soft`, `org.claim.vouch`) do not exist in the attestation type vocabulary.

**Resolution requires:** Draft covenant document (Ryan drafts, community comment period), three new attestation types added to `packages/auth/src/types/attestation.ts`, Org DID claim processing endpoint.

**Related:** C04 (Org DID vetting), RFC-08

---

### C14. Foundation Governance Mechanism Unspecified

**Extracted from:** P14 (Governance Equity)
**Priority:** MEDIUM — must be specified before network-level influence accumulates
**Filed:** March 27, 2026

The whitepaper separates Imajin Inc. from the MJN Foundation but does not specify Foundation governance: who votes, how weight is allocated, whether it connects to Network of Souls participation. Three governance layers are identified — community (resolved by Cultural DID/RFC-07), network-level (Network of Souls, partially spec'd), and Foundation (entirely unspecified).

The relationship between Network of Souls influence and Foundation governance is the core unresolved governance equity concern. Without specification, early-adopter concentration risk is unaddressed.

**Resolution requires:** Three documentation deliverables: (1) three-layer governance mapping in whitepaper, (2) Cultural DID Stream 5 independence statement, (3) Foundation governance mechanism spec with transition path from founding governance to target mechanism.

**Related:** C03 (governance equity), P14, RFC-07, RFC-17

---

### C15. Agent Authority Scope and Forge Gap

**Extracted from:** P24 (Agent Fair Attribution), resolved P06 (.fair Integrity)
**Priority:** MEDIUM — blocks Stream 3 launch with attribution integrity
**Filed:** March 27, 2026

Agent DIDs can generate `.fair` manifests but there is no mechanism to verify authority scope. The `FairEntry` type cannot distinguish human from agent contributions (`contributorType` field missing). No `principalSignature` countersignature requirement exists — an agent can forge attribution claims without the principal human's approval.

P06 (resolved) left two decisions open: Cultural DID treasury signing and agent scope encoding. Neither has been implemented. RFC-19 specifies agents-as-userspace-apps but does not address `.fair` attribution integrity for agent-generated content.

**Resolution requires:** `contributorType` on `FairEntry`, `principalSignature` validation in `packages/fair/src/validate.ts`, agent sub-identity columns on `auth.identities` (`principal_did`, `image_id`), and authority scope encoding in agent DID derivation.

**Related:** C02 (.fair automated nodes), P24, resolved P06, RFC-19 §agents

---

### C16. Family DID Identity Primitive Missing

**Extracted from:** P25 (Family DID)
**Priority:** LOW — governance model exists, identity container needed before 4×5 matrix is complete
**Filed:** March 27, 2026

RFC-17 specifies family governance defaults (custodial default, age-graduated rights) but there is no Family DID identity primitive: no `auth.family_identities` table, no formation endpoint, no family-scoped keypair infrastructure. The 4×5 matrix (Actor/Family/Community/Business × 5 primitives) is missing its fourth scope at the identity layer.

Related gaps: threshold signature tooling for multi-guardian custody, family fork/merge semantics, and the community formation trigger (2 families connecting → community DID).

**Resolution requires:** 7 decisions from Ryan (P25 §7), `auth.family_identities` schema, formation endpoint, and family-scoped keypair generation.

**Related:** P25, RFC-17, pitch deck matrix

---

## Resolved — For Reference

The following concerns were raised and are considered addressed. Full documents in `resolved-concerns/`.

| Concern | Resolution | Document |
|---------|-----------|----------|
| **C01 — Social Graph Portability** | Trust relationships are now attestation records on chain (PRs #444, #447, #453). Portability is mathematical, not contractual. | `resolved-concerns/c01-social-graph-portability.md` |
| **C07 — Cultural DID Specification** | All seven open questions answered in RFC-07 upstream. Spec complete. | `resolved-concerns/c07-cultural-did-specification.md` |
| **C09 — Migration System Integrity** | Per-service migration tracking, build-fail-on-error, drift detection in CI. Root cause (silent divergence) addressed. | `resolved-concerns/c09-migration-system-integrity.md` |
| **F1 — Attestation Data Layer** | `auth.attestations` table live via migration 0002; typed, signed attestations shipping. | (Resolved March 15) |
| **F2 — Identity Tier Cross-Service** | Tier column migrated to `auth.identities` (#319); session route reads directly from auth schema. | (Resolved March 15) |
| **F3 — Greg's proposals in upstream** | PR #282 merged; proposals in `docs/proposals/`. | (Resolved March 13) |
| **F4 — Node attestation design pattern** | Incorporated into Proposal 8 (Attestation Data Layer). | (Resolved March 13) |
| **F5 — Three new RFCs not in proposals** | Proposals 15/16/17 + Settlement Roadmap filed upstream. | (Resolved March 13) |
| **F7 — Architecture doc contradicts P2** | Cross-schema query removed; tier now in `auth.identities`. | (Resolved March 15) |
| Presence ≠ Accountability (Unit) | Unit reframed as attention function; structural accountability lives in the stack | `historical-context.md` |
| Personal AI as participation requirement | Stream 5 is additive; base economy requires no AI | `historical-context.md` |
| Advertising as revenue (Stream 2) | Structural contradiction resolved by changing data model to Declared-Intent Marketplace | `historical-context.md` |
| Businesses as nodes (same trust dynamics) | Org DID proposed as structurally distinct primitive with reduced privilege and mandatory transparency | `historical-context.md` |
| BBS analogy at scale | Partially resolved; trust graph and portability provide structural accountability at scale | `historical-context.md` |
