# .fair Hardening Roadmap

*Generated March 13, 2026 — cross-referencing Greg's proposals, open issues, and current code.*
*Updated March 13, 2026 — decisions locked, tickets consolidated.*

## Decisions Locked

| Decision | Answer | Greg's Position | Notes |
|----------|--------|----------------|-------|
| Unsigned manifests at settlement | **Reject** | Reject | No provisional manifests |
| Multi-contributor signing | **Owner-only MVP** | Owner-only MVP | Multi-party deferred to Phase 3 |
| Legacy manifests | **No legacy concept** | Legacy tag | Ryan overruled — we're pre-launch, no existing manifests worth preserving. Every manifest signed. |
| Edit behavior | **Resign on edit** | N/A | No version chain for MVP. Transaction table is the audit trail. |
| Platform signature | **Separate field** | N/A | Platform endorsement (✅) breaks on creator edit (⚠️). Creator resigns with own key. |
| Version chain / mutation history | **Deferred to Phase 2-3** | N/A | Tracked as future work, not MVP. |

---

## Current State of `@imajin/fair`

**What exists:**
- `packages/fair/src/types.ts` — `FairManifest`, `FairEntry`, `FairTransfer`, `FairAccess`, `FairIntegrity`
- `packages/fair/src/create.ts` — `createManifest()` (bare-bones, no signing)
- `packages/fair/src/validate.ts` — `validateManifest()` (structure + arithmetic only)
- `packages/fair/src/components/` — `FairEditor`, `FairAccordion` (UI)
- **No signing.** No verification. No templates. No intent field.
- Manifests are unsigned JSON objects — any service can claim any `owner` DID.

**What uses it:**
- `apps/media` — asset .fair attribution + access control
- `apps/events` — ticket .fair manifests
- `apps/pay` — `fair_manifest` JSONB column on transactions (stores but doesn't verify)

---

## The Gaps (Greg's Pressure Tests)

| Problem | Source | Severity |
|---------|--------|----------|
| **No signature field** on FairManifest | P3, Proposal 6 | Critical for Stream 3 |
| **No intent field** on FairManifest | P5, Proposal 17 | Blocks contribution pools |
| **No signing infrastructure** in `@imajin/auth` | Proposal 7 | Blocks everything crypto |
| **Validation is structural only** — no cryptographic verification | P3, Proposal 6 | Convention, not primitive |
| **One-size-fits-all editor** — tickets show photo fields | #314 | UX debt |
| **Conversation access type** missing from .fair spec | #305 | Chat media insecure |
| **No distribution contracts** — schema exists in RFC only | Proposal 16 | Blocks automated splits |
| **Agent DIDs can forge manifests** — no authority scope | Proposal 6 Q5 | Blocks Stream 3 |

---

## Build Strategy: Four Phases

### Phase 0 — Schema Hardening *(ship now, no dependencies)*

Extend `FairManifest` type and fix the editor. No crypto required — just making the type honest about what it will need.

**Issues addressed:** #314 (templates), #305 (conversation access), P5 (intent field)

| Task | Location | Notes |
|------|----------|-------|
| Add `signature?` field to `FairManifest` | `packages/fair/src/types.ts` | Optional for now — legacy manifests still valid |
| Add `intent?` field to `FairManifest` | `packages/fair/src/types.ts` | P3 + P5 in one PR per Greg's recommendation |
| Add `conversation` to `FairAccess.type` | `packages/fair/src/types.ts` | `"public" \| "private" \| "trust-graph" \| "conversation"` |
| Add `conversationDid?` to `FairAccess` | `packages/fair/src/types.ts` | For #305 |
| Define template schemas | `packages/fair/src/templates.ts` | `media`, `ticket`, `course`, `module`, `document`, `custom` |
| `FairEditor` accepts `template` prop | `packages/fair/src/components/` | Conditionally render sections per template |
| Handle autocomplete for contributors | `packages/fair/src/components/` | DID → @handle resolution (already partially built) |
| Update `validateManifest` for new fields | `packages/fair/src/validate.ts` | Validate `signature` structure if present, `intent.purpose` enum |
**Decisions needed:**
- Approve the `conversation` access type for chat media (#305)
- Confirm template list: `media`, `ticket`, `course`, `module`, `document`, `custom` — missing any?

---

### Phase 1 — Cryptographic Signing *(the foundation)*

This is the **single highest-priority .fair work**. Greg's right — without signing, .fair is a convention, not a primitive. Everything downstream depends on this.

**Issues:** #316 (auth signing utilities), #317 (.fair signing)
**Depends on:** Proposal 7 (Cryptographic Trust Layer) — specifically the `@imajin/auth` signing utilities

| Task | Location | Notes |
|------|----------|-------|
| `sign(payload, privateKey)` → Ed25519 signature | `packages/auth/src/crypto.ts` | Shared utility — used by attestations, .fair, distribution contracts |
| `verify(payload, signature, publicKey)` → boolean | `packages/auth/src/crypto.ts` | Same shared utility |
| `signManifest(manifest, privateKey)` → `SignedFairManifest` | `packages/fair/src/sign.ts` | Wraps auth signing with manifest-specific canonicalization |
| `verifyManifest(manifest)` → boolean | `packages/fair/src/sign.ts` | Resolves `owner` DID → public key, checks signature |
| Platform DID signing at creation | `apps/events/`, `apps/media/` | Platform signs .fair at event/asset creation |
| `platformSignature` field + ✅/⚠️ viewer | `FairAccordion` component | Show verified/modified status (#174) |
| Settlement enforcement | `apps/pay/` settlement routes | Reject unsigned manifests (after migration window) |
| Platform DID hardcoded in build | Build config | `did:imajin:c6e6c109...` per #174 spec |

**Decisions locked:** Reject unsigned. Owner-only signing. No legacy concept (pre-launch, nothing to migrate).

---

### Phase 2 — Settlement Integration *(making .fair DO something)*

Connect the signed manifests to actual money flow.

**Issues addressed:** #141 (settlement engine), #26 (essay manifests), #162 (auto-issue credentials)

| Task | Location | Notes |
|------|----------|-------|
| Wire events webhook → `/api/settle` with .fair | `apps/events/`, `apps/pay/` | Ticket purchase triggers settlement with signed manifest |
| Platform fee calculated + recorded | `apps/pay/` | Platform DID's share in every .fair chain |
| Balance UI shows .fair-attributed earnings | `apps/profile/` | Per-DID earnings breakdown |
| Essay .fair manifests | `apps/www/articles/` | Dog-food: all 20 essays carry .fair (#26) |
| Auto-issue attestation on settlement | `apps/pay/` → `auth.attestations` | Transaction completion = signed attestation (#162) |
| Coffee routing through pay | `apps/coffee/` → `apps/pay/` | Stop talking to Stripe directly |

**This is where .fair becomes real.** Phase 1 makes manifests trustworthy. Phase 2 makes them settle.

---

### Phase 3 — Advanced Primitives *(the protocol layer)*

These are the pieces that make .fair a general-purpose attribution protocol, not just "who gets paid for this event."

**Issues addressed:** #110 (runtime modules), #139 (ZERR integration), Proposal 15 (commit attribution), Proposal 16 (distribution contracts), Proposal 17 (intent/pools)

| Task | Location | Notes |
|------|----------|-------|
| Distribution contracts | New `packages/distribution/` or extend `@imajin/fair` | Programmable split rules per DID (#RFC-02) |
| Intent-bearing transactions | `packages/fair/src/types.ts` + `apps/pay/` | `intent` field enforcement (Phase 1: logged, Phase 2: attestation-triggered) |
| Contribution pools | `apps/pay/` or new `apps/pools/` | Community-funded infrastructure with attributed rewards |
| Runtime module manifests | Extend `FairManifest` with `module` type | For ZERR, inference, memory providers (#110, #139) |
| Attribution from commits | New package or `@imajin/fair` | PR merge → attribution object → .fair chain (#RFC-01/Proposal 15) |
| `derives_from` for forks | `FairManifest` extension | Attribution chain across derivative works |
| Multi-party signing | `packages/fair/src/sign.ts` | Async flow: manifest → distributed to contributors → all sign → settleable |
| Cultural DID treasury signing | Treasury child key + quorum auth | Per Greg's Proposal 6 Q3 recommendation |

**This is Year 2 territory for most of it**, but the type foundations should be laid in Phase 0.

---

## Issue ↔ Proposal Cross-Reference

| Issue | Greg Proposal(s) | Phase |
|-------|-----------------|-------|
| **#316** — Auth signing utilities | Proposal 6, 7 | 1 (blocker) | **NEW** |
| **#317** — .fair cryptographic signing | P3, Proposal 6, 7 | 1 | **NEW** |
| **#314** — .fair templates | *(UX)* | 0 | Open, updated |
| **#305** — Conversation access | *(UX)* | 0 | Open |
| **#141** — Settlement engine | Proposal 16, 17 | 2 | Open |
| **#26** — Essay manifests | *(dog-fooding)* | 2 | Open |
| **#110** — Runtime module .fair | Proposal 6 (agent signing) | 3 | Open |
| **#139** — ZERR integration | Proposal 6, 7 | 3 | Open |
| **#137** — Dykil .fair | Proposal 12 (declarations) | 3 | Open |
| **#162** — Auto-issue credentials | Proposal 7, 8 | 2-3 | Open |
| **#161** — Verifiable credentials | Proposal 7, 8 | 2-3 | Open |

### Closed / Consolidated

| Issue | Reason |
|-------|--------|
| **#20** — .fair manifest library | ✅ Shipped (types, create, validate). Signing → #317 |
| **#174** — Platform .fair trust | Rolled into #317 |
| **#177** — Media service | ✅ Shipped March 5. Remaining → #305 |

## Greg Proposals Not Yet Linked to Issues

| Proposal | What It Needs | Suggested Phase |
|----------|--------------|-----------------|
| **12** — Declaration Granularity | Needs issue — `packages/declarations/` or Stream 2 tracker | 3 |
| **15** — Attribution from Commits | Needs issue — PR merge → attribution objects | 3 |
| **16** — Distribution Contracts | Needs issue — `packages/distribution/` | 3 |
| **17** — Intent-Bearing Transactions | Type fix in Phase 0, settlement in Phase 2-3 | 2-3 |

---

## Dependency Graph

```
Phase 0: Schema Hardening
    └── No blockers — ship anytime

Phase 1: Cryptographic Signing
    ├── Depends on: @imajin/auth signing utilities (Proposal 7)
    │   └── Ed25519 sign/verify in packages/auth/
    └── Depends on: Phase 0 (signature field exists on type)

Phase 2: Settlement Integration
    ├── Depends on: Phase 1 (manifests are signed + verifiable)
    └── Depends on: Attestation table (Proposal 7/8) for credential issuance

Phase 3: Advanced Primitives
    ├── Depends on: Phase 1 + 2 (signing + settlement working)
    ├── Depends on: Embedded Wallet (Proposal 4) for agent DID scoping
    └── Depends on: Attestation layer for trust-gated enforcement
```

---

## Suggested Build Order (What to Build Next)

1. **Phase 0 PR** — Type extensions + templates + conversation access. One PR, no crypto, immediate UX improvement. Unblocks media team and chat media security.

2. **`@imajin/auth` signing utilities** — The keystone. `sign()` and `verify()` using Ed25519. Used by attestations, .fair, distribution contracts, declarations — everything. This is Proposal 7's Phase 1.

3. **Phase 1 PR** — `signManifest()` + `verifyManifest()` + platform signing on event creation + viewer badge. This is where .fair becomes a real protocol primitive.

4. **Phase 2** — Wire settlement. Events → pay with signed .fair. Platform fee flowing. Balance visible.

---

*This document should live alongside the proposals and be updated as phases complete.*
