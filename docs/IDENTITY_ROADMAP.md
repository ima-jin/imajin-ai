# Identity & Attestation Hardening Roadmap

*Generated March 13, 2026 — cross-referencing Greg's proposals, open issues, and current code.*

---

## Current State

### What Exists

**`packages/auth/`** — Solid crypto foundation:
- `crypto.ts` — Ed25519 via `@noble/ed25519` (sign, verify, keypair generation, hex encoding)
- `sign.ts` — `sign()` wraps payloads in `SignedMessage<T>` with `from`, `type`, `timestamp`, `signature` + `canonicalize()` for deterministic JSON
- `verify.ts` — Full message verification with timestamp checks, challenge-response
- `types/node.ts` — `NodeAttestation` for build integrity (signed, typed, complete)
- `types.ts` — `Identity` type with `tier?: "soft" | "hard"` (binary, no middle ground)

**`apps/auth/`** — Auth service:
- `auth.identities` table: `id` (DID), `type`, `publicKey`, `handle`, `name`, `avatarUrl`, `metadata`
- **No `tier` column** — tier lives in `profile.profiles.identity_tier` (wrong service)
- Keypair registration, challenge-response login, magic links, onboarding flow
- Session route crosses service boundary to read tier from profile

**`apps/connections/`** — Social layer:
- Pods (groups with membership), invites, invite codes
- No trust graph, no attestations, no standing computation

### What Does NOT Exist

- ❌ `auth.attestations` table — no identity attestation storage
- ❌ Standing computation — "standing is computed, not assigned" but there's nothing to compute from
- ❌ Three-tier model — only `soft` and `hard`, no `preliminary`/`established`
- ❌ Vouch system — no mechanism for sponsoring onboarding
- ❌ Flag system — no consequence model for bad behavior
- ❌ Trust graph package — `packages/trust-graph/` doesn't exist
- ❌ Consent primitive — architecture doc says "TODO"
- ❌ BaggageDID — no departure artifacts

---

## The Gaps (Greg's Pressure Tests)

### Code-Level Bugs (Fix NOW)

| Problem | File | Fix |
|---------|------|-----|
| **P1** — Fail-open tier default | `apps/auth/.../session/route.ts:50` | `\|\| 'hard'` → `\|\| 'soft'` |
| **P4** — Silent exception suppression | `apps/auth/.../session/route.ts:53` | Add `console.error` to catch block |

### Architectural Gaps

| Gap | Greg Proposal | Severity |
|-----|--------------|----------|
| **Tier in wrong service** | P2, Proposal 9 | High — compounds with every new tier |
| **No attestation table** | Proposals 7, 8 | Critical — blocks trust model, flags, standing, BaggageDID, .fair signing enforcement |
| **Binary tier model** | Proposal 1 | High — no graduated trust, no onboarding period |
| **No consequence model** | Proposal 2 | Medium — no flags, no vouch accountability |
| **No trust graph** | #23 | Medium — connections exist but not queryable as a graph |
| **No consent primitive** | Proposal 18 | Medium — architecture doc TODO |
| **No social portability** | Proposal 5 | Low (pre-federation) — BaggageDID needed before multi-node |
| **Attestation naming collision** | Proposal 7 §1 | Low — `NodeAttestation` ≠ identity attestation, but same word |

---

## Build Strategy: Five Phases

### Phase 0 — Immediate Security Fixes *(ship today, no dependencies)*

One PR, three changes, zero risk.

| Task | File | Notes |
|------|------|-------|
| Fix fail-open default: `\|\| 'hard'` → `\|\| 'soft'` | `apps/auth/.../session/route.ts:50` | P1 — one line |
| Add error logging to catch block | `apps/auth/.../session/route.ts:53` | P4 — one line |
| Add `tier` column to `auth.identities` | Migration | `TEXT NOT NULL DEFAULT 'soft'` |
| Dual-write tier to auth + profile | Session/registration routes | Bridge path per Proposal 9 Option C |
| Cut session route to read from `auth.identities` | `apps/auth/.../session/route.ts` | Eliminates cross-schema query |

**Decisions needed:**
- Tier column values: `soft` / `preliminary` / `established` (go ahead and add three now, even though we only use two initially?)
- Keep `profile.profiles.identity_tier` for display, or deprecate?

---

### Phase 1 — Attestation Data Layer *(the foundation — blocks everything)*

This is the equivalent of .fair Phase 1. Without attestations, you can't compute standing, can't do vouching, can't do flags, can't build the trust model. Everything else in this roadmap depends on this.

**Greg proposals addressed:** 7 (Cryptographic Trust Layer), 8 (Attestation Data Layer)
**Shares dependency:** #316 (`@imajin/auth` signing utilities) — same keystone as .fair signing

| Task | Location | Notes |
|------|----------|-------|
| Create `auth.attestations` table | Migration | Schema from Proposal 7 §3 — see below |
| Controlled type vocabulary (initial set) | `packages/auth/src/types/attestation.ts` | Start minimal, expand per phase |
| `POST /api/attestations` endpoint | `apps/auth/` | **Signature verification at ingestion** — reject invalid |
| `GET /api/attestations/:did` endpoint | `apps/auth/` | Query attestations for a DID |
| Standing computation function | `apps/auth/` or `packages/trust-graph/` | Query over attestations → tier output |
| Tier computation trigger | On-write | Recompute standing when new attestation written |

**Attestation schema:**

```sql
CREATE TABLE auth.attestations (
  id           TEXT PRIMARY KEY,           -- att_xxx
  issuer_did   TEXT NOT NULL,              -- who signed it
  subject_did  TEXT NOT NULL,              -- who it's about
  type         TEXT NOT NULL,              -- controlled vocabulary
  context_id   TEXT,                       -- event/org/interaction ID
  context_type TEXT,                       -- 'event' | 'org' | 'interaction' | 'system'
  payload      JSONB DEFAULT '{}',         -- type-specific public metadata
  signature    TEXT NOT NULL,              -- Ed25519 by issuer_did
  issued_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,               -- optional decay
  revoked_at   TIMESTAMPTZ                -- for revocation
);
```

**Initial attestation types (MVP set):**

| Type | Issuer | When |
|------|--------|------|
| `event.attendance` | EventDID / system | Ticket scanned / event check-in |
| `vouch.given` | Established DID | Sponsors a Preliminary DID |
| `vouch.received` | System | Acknowledgment of vouch |
| `flag.yellow` | Established DID / governance | Low-severity flag |
| `flag.cleared` | Governance | Flag resolved |

**Decisions needed from you:**

| Decision | Options | Greg's Position |
|----------|---------|----------------|
| Schema: `auth.attestations` or new `trust` schema? | Same schema vs separate | `trust` schema — semantically distinct |
| Encrypted payload for MVP? | Yes / defer | Yes (before sensitive data) |
| Bilateral root record on join? | Required / defer | Required — one extra signature |
| Standing cache model | On-write / TTL cache / on-demand | On-write trigger |
| Node dark protection model | BaggageDID only / continuous export / personalDID-held log | Option 3 — personalDID-held log |
| Cascading revocation | Hard cascade / soft decay | Soft decay |

**My take:** For MVP, I'd simplify:
- `auth.attestations` (not a new schema — keep it close to identities)
- Skip encrypted payload for now (add before flags contain sensitive narratives)
- Skip bilateral root for MVP (add when multi-node)
- On-write trigger for standing (simplest, most consistent)
- Defer node-dark protection (pre-federation, single node)
- Soft decay for revocation (less disruptive)

---

### Phase 2 — Progressive Trust Model *(three tiers, vouching, onboarding)*

Turn the attestation layer into a real trust system. This is where the binary soft/hard gap becomes a graduated pathway.

**Greg proposals addressed:** 1 (Progressive Trust), 2 (Trust Accountability)

| Task | Location | Notes |
|------|----------|-------|
| Three-tier permissions | All service middleware | `soft` → `preliminary` → `established` |
| Vouch flow | `apps/auth/` or `apps/connections/` | Established DID sponsors Preliminary |
| Onboarding milestones | `apps/auth/` | Configurable: N interactions, N events, N days |
| Standing threshold for Established | Config | Governance-configurable, starts with a sensible default |
| Permission middleware update | `@imajin/auth` middleware | Each API checks caller's standing tier |
| Flag system (yellow/amber/red) | `apps/auth/` attestation types | Behavioral, not ideological |
| Vouch chain accountability | Standing computation | Vouched person flagged → voucher standing reviewed |
| Demotion path | Standing computation | Established → Preliminary on sufficient flags |

**Permission matrix (from Proposal 1):**

| Action | Soft (Visitor) | Preliminary (Resident) | Established (Host) |
|--------|:-:|:-:|:-:|
| Attend events, hold tickets | ✅ | ✅ | ✅ |
| Enroll in courses | ✅ | ✅ | ✅ |
| Full profile | ❌ | ✅ | ✅ |
| Use apps (coffee, links, etc.) | ❌ | ✅ | ✅ |
| Wallet / transact | ❌ | ✅ | ✅ |
| Message direct connections | ❌ | ✅ | ✅ |
| Vouch for others | ❌ | ❌ | ✅ |
| Create events / Cultural DIDs | ❌ | ❌ | ✅ |
| Extended trust graph visibility | ❌ | ❌ | ✅ |

---

### Phase 3 — Trust Graph & Consent *(the social layer)*

Build the queryable trust graph and the consent primitive.

**Issues addressed:** #23 (trust graph), #21 (consent middleware)
**Greg proposals addressed:** 18 (Consent Primitive)

| Task | Location | Notes |
|------|----------|-------|
| `packages/trust-graph/` | New package | `extendTrust`, `revokeTrust`, `trustDistance`, `trustRadius` |
| Trust-bound access control | All services | "Only people within N hops can query this" |
| Sybil scoring | Trust graph | Diverse connections score higher |
| Consent declaration type | `@imajin/auth` or attestation types | `consent.given`, `consent.revoked` |
| Consent middleware | `packages/mjn-middleware/` | `X-MJN-*` headers on content-serving routes |
| Stream 2 opt-in → signed consent | Migration | Replace DB flag with `consent.given` attestation |
| Connections ↔ trust graph wiring | `apps/connections/` | Pods/invites feed into trust graph |

---

### Phase 4 — Advanced Identity *(federation, portability, governance)*

These are the pieces needed for multi-node federation and community governance.

**Greg proposals addressed:** 5 (BaggageDID), 10 (Org DID Vetting), 13 (Cultural DID), 14 (Governance Equity)

| Task | Location | Notes |
|------|----------|-------|
| BaggageDID | `apps/auth/` or `packages/trust-graph/` | Departure artifacts — signed, encrypted context envelope |
| Org DID vetting | `apps/auth/` | Composite attestation model: vouches + soft-loading + covenant |
| Covenant document | `docs/` | Behavioral disqualification list — must exist before first Org DID |
| Cultural DID governance | New service or `apps/connections/` | Token context, founding members, governance weight |
| `did:mjn` method | `apps/auth/`, `packages/did-mjn/` | Multibase-encoded public keys (#19) |
| Foundation governance documentation | Whitepaper / docs | Three-layer governance model explicitly stated |

---

## Issue ↔ Proposal Cross-Reference

| Issue | Greg Proposal(s) | Phase | Status |
|-------|-----------------|-------|--------|
| **#316** — Auth signing utilities | Proposal 7 | 1 (blocker, shared with .fair) | NEW |
| **#19** — `did:mjn` DID method | — | 4 | Open |
| **#21** — Consent middleware | Proposal 18 | 3 | Open |
| **#23** — Trust graph | Proposals 1, 2, 7 | 3 | Open |
| **#24** — Node registry heartbeat | — | 4 | Open |
| **#27** — Government identity attestation | — | 4+ | Open |
| **#35** — Trust-gated inference | Proposals 1, 7 | 3 | Open |
| **#152** — Public profile + trust indicators | Proposal 1 | 2 | Open |
| **#246** — Check-ins (Foursquare-style) | Proposal 10 (soft-loading) | 3-4 | Open |

### Issues That Need Creating

| What | Phase | Content |
|------|-------|---------|
| **P1+P4: Fail-open fix + logging** | 0 | One-line security fix + observability |
| **Tier migration to auth.identities** | 0 | P2 — move tier to auth, three-tier column |
| **auth.attestations table + API** | 1 | The attestation data layer foundation |
| **Progressive trust: three-tier model** | 2 | Vouch flow, onboarding milestones, standing computation |
| **Flag system: yellow/amber/red** | 2 | Behavioral consequence tiers |

---

## Dependency Graph

```
Phase 0: Security Fixes + Tier Migration
    └── No blockers — ship now

Phase 1: Attestation Data Layer
    ├── Depends on: #316 (@imajin/auth signing utilities)
    └── Depends on: Phase 0 (tier column in auth.identities)

Phase 2: Progressive Trust Model
    ├── Depends on: Phase 1 (attestations exist to compute standing from)
    └── Depends on: Phase 0 (three-tier column values)

Phase 3: Trust Graph + Consent
    ├── Depends on: Phase 1 (attestations feed trust graph)
    └── Depends on: Phase 2 (trust tiers govern access)

Phase 4: Advanced Identity
    ├── Depends on: Phase 1 + 2 + 3 (full attestation + trust + consent stack)
    └── Federation-dependent (multi-node)
```

---

## Shared Dependencies with .fair Roadmap

The two roadmaps converge at **#316 — `@imajin/auth` signing utilities**. This is the single keystone blocking both:

- .fair Phase 1 (manifest signing)
- Identity Phase 1 (attestation signing)

**Build #316 first. Everything else flows from there.**

Additionally, .fair Phase 1's settlement enforcement ("reject unsigned manifests") benefits from Identity Phase 1's attestation layer — settlement can record a `transaction.settled` attestation as proof of payment.

```
                    #316: @imajin/auth signing
                         /              \
                        /                \
          .fair Phase 1                Identity Phase 1
       (manifest signing)           (attestation table)
              |                           |
       .fair Phase 2                Identity Phase 2
       (settlement)              (progressive trust)
              \                          /
               \                        /
                    Full Protocol
            (signed manifests + standing +
             trust-gated settlement)
```

---

## Suggested Build Order

1. **Phase 0 PR** — P1 fix (`|| 'soft'`), P4 fix (logging), tier column migration. Ship today.
2. **#316** — `@imajin/auth` signing utilities (shared keystone). Already issued.
3. **Phase 1 PR** — `auth.attestations` table, controlled vocabulary, signed ingestion, standing computation.
4. **Phase 2** — Three-tier model, vouch flow, flag system.
5. **.fair Phase 1** can run in parallel with Identity Phase 1 once #316 ships.

---

*This document lives alongside `docs/FAIR_ROADMAP.md`. Together they cover the two foundational systems Greg's proposals pressure-test.*
