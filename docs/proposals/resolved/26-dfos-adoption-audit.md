## STATUS: FULLY IMPLEMENTED
**Resolved:** 2026-03-22
**Evidence:** PRs #437, #440, #441, #442, #443, #444, #445, #446, #447 — all merged March 22. P26 epic (#415) shipped same day as this proposal was filed.
**Outcome:** Every service now has chain-aware identity. All three phases completed in a single sprint. Build timeline notes: "P26 complete — all 10 chain-integration issues shipped."
**Implementation:** Fully shipped in code.

| Phase | Issues | What shipped |
|-------|--------|-------------|
| Foundation | #417, #420 | `chainVerified` on Identity + `institution.verified` door-check attestation |
| Trust Boundaries | #416, #418, #419 | Chain-verified registry, .fair chain proof, chain-verified settlement |
| Federation | #421, #422, #423, #424 | Pod membership attestations, signed messages, learn attestations, external chain onboarding |

**Key implementation notes:**
- Services do not verify chains directly — they ask `@imajin/auth` via `chainVerified` flag. Only three services touch the chain at trust boundaries: registry, .fair, events.
- External DFOS onboarding: `POST /api/identity/present-chain` — presents chain, gets `did:imajin` alias + `tier: 'preliminary'` session. Trust is fresh start, not inherited.
- Chain provider abstraction (`lib/chain-providers.ts`) makes this pluggable for future chain protocols.
- Open questions #1 and #2 (canonical DID, dual-DID display) addressed in P27.
- DFOS relay LIVE at `registry.imajin.ai/relay/` — `@metalabel/dfos-web-relay` v0.3.0 with PostgresRelayStore.

---

# Proposal 26 — DFOS Adoption Audit: Chain-Backed Identity Across All Services

**Filed locally:** 2026-03-22
**Author:** Ryan Veteze (Jin) — received and filed by Tonalith
**Ryan's designation:** P25 (renumbered P26 here — our P25 is Family DID)
**Status:** Draft
**Depends on:** #395 (DFOS DID Bridge), PRs #412/#413/#414
**Related:** #155 (Registry Resolution), #255/RFC-10 (Sovereign User Data), #405 (DFOS Phase 2), Discussion #252/RFC-07 (Cultural DID)
**Matrix cells:** All scopes × Discovery + Attestation + Attribution

---

## Context

This document was written by Ryan (Jin) on March 21, 2026, the same day the DFOS DID Bridge Phase 1+2 merged (PR #407). It is an architectural audit of what DFOS chain-backed identity means for every service beyond auth — and a roadmap for how to get there.

DFOS Phase 1+2 delivered the cryptographic foundation: `packages/dfos`, `auth.identity_chains` table, chain creation at login. Phase 3 (relay, MCP, gas) is next. This proposal addresses what happens in between: all the services that still think identity is just a Postgres row.

---

## Problem

DFOS identity chains are built. Auth can create, verify, rotate, and resolve them. But the rest of the platform doesn't know they exist.

Every other service — registry, profile, connections, events, pay, media, learn — still operates purely on `did:imajin` identifiers stored in Postgres. Identity is sovereign in auth, but the moment data crosses a service boundary it becomes platform-local again.

For DFOS to deliver on its promise (portable, self-certifying, federated identity), every service that touches identity needs to understand that a `did:imajin` might also be a `did:dfos` — and that the chain is the source of truth, not the database row.

---

## Current State

### How services authenticate today

| Pattern | Services | How it works |
|---------|----------|-------------|
| HTTP proxy to auth | connections, www, events (partial) | `fetch(AUTH_SERVICE_URL/api/session)` with cookie. Gets back `{ did, handle, type }`. No chain awareness. |
| `@imajin/auth` package | learn, media, profile | `requireAuth(request)` verifies JWT directly. No HTTP call. No chain awareness. |
| `@imajin/auth` crypto | registry, pay | Uses `verify()`, `canonicalize()` for signatures. Registry verifies node attestations. Pay resolves DIDs for settlement. |

### What auth knows that nobody else does

- Whether a `did:imajin` has a DFOS chain (`identity_chains` table)
- The `did:dfos` linked to each `did:imajin`
- Chain integrity (cryptographic verification) — now via chain-aware middleware (PR #413)
- Key roles (auth/assert/controller) after #401 — LIVE in `key_roles` JSONB column
- Chain history (full append-only log)

---

## Service-by-Service Audit

### 1. Registry — CRITICAL

**Current:** Nodes register with a `NodeAttestation` containing `nodeId`, `publicKey`, `buildHash`, `hostname`, `signature`. Registry verifies the signature against the public key and checks the build hash against approved builds.

**Gap:** No concept of DFOS chains. Node identity is a bare public key, not a chain-backed DID. External DFOS identities can't register nodes.

**What needs to change:**
- Accept DFOS chain as node identity proof (alongside or replacing build attestation)
- Store `did:dfos` on node records
- Resolve `did:dfos` → endpoint (the "DNS for DIDs" story)
- Advertise which DID methods a node accepts
- Verify chain on heartbeat (detect key rotation, node migration)

**New flow:** Node presents DFOS chain log → registry verifies chain → extracts DID + public key → provisions subdomain → stores chain reference. On heartbeat, re-verify chain (detect updates).

**Scope:** Medium-large. New column on `nodes` table, chain verification in register + heartbeat routes, new resolution endpoint (`/api/node/resolve/dfos/:dfosDid`).

**Issue scope:** `feat(registry): DFOS chain-backed node registration`

---

### 2. Profile — HIGH

**Current:** Profiles reference `did:imajin` as the identity key. Public profile pages show handle, name, avatar. No chain information.

**Gap:** No way to see or share your DFOS identity. No chain status. External systems can't verify a profile's identity.

**What needs to change:**
- Store and display `did:dfos` on profiles
- Chain status indicator (bridged / unbridged / verified)
- Public endpoint: `/api/profile/:handle/did` → returns both `did:imajin` and `did:dfos`
- Profile export includes DFOS chain (for portability — RFC-10)

**Scope:** Small-medium. New column, API extension, UI addition.

**Issue scope:** `feat(profile): surface DFOS identity + chain status`

---

### 3. Connections — HIGH (Cultural DID dependency)

**Current:** Pods and groups use `did:imajin` for membership. Owner/member DIDs stored in connections DB.

**Gap:** No chain-backed membership. Adding/removing members isn't recorded in any verifiable log. Cultural DIDs (RFC-07) need chain-backed governance.

**What needs to change:**
- Pod membership changes → chain updates (when DFOS chains exist)
- Cultural DID formation → creates a collective DFOS chain (new chain type)
- Membership attestations signed by chain keys, not just session tokens
- Cross-node pod membership (member on different node, verified by chain)

**Scope:** Large. This is where Cultural DIDs live. Depends on the collective chain primitive (not just identity chains — may need DFOS content chains or a new operation type).

**Issue scope:** `feat(connections): chain-backed pods + Cultural DID foundation`

---

### 4. Events — MEDIUM

**Current:** Tickets reference `buyerDid` (did:imajin). Check-in creates attestations signed by event key.

**Gap:** Ticket attestations use DB-stored keys, not chain-verified keys. Tickets aren't portable outside Imajin.

**What needs to change:**
- Ticket attestations reference `did:dfos` when available
- Event identity itself could be chain-backed (event DID → DFOS chain)
- Check-in countersignatures (#402) use chain keys — countersignatures LIVE as of PR #426
- Ticket portability: .fair manifest includes `did:dfos` for creator + buyer

**Scope:** Medium. Mostly wiring existing chain verification into attestation flows.

**Issue scope:** `feat(events): chain-backed ticket attestations`

---

### 5. Pay — MEDIUM

**Current:** Settlement uses `@imajin/auth` resolver to look up DIDs. Attestations emitted on payment.

**Gap:** Settlement signatures use DB keys. No chain verification on payment parties. Cross-network payments impossible without chain identity.

**What needs to change:**
- Verify payer/payee chain before settlement (opt-in, like `requireAuth({ verifyChain: true })`)
- Settlement attestations include `did:dfos` for portability
- Future: accept payment from external `did:dfos` (cross-network settlement)

**Scope:** Small-medium. Mostly adding chain lookup to existing flows.

**Issue scope:** `feat(pay): chain-aware settlement + portable attestations`

---

### 6. Media / .fair — MEDIUM

**Current:** .fair attribution uses `did:imajin` for creator/contributor DIDs. Assets stored under `did:imajin`-derived paths.

**Gap:** .fair manifests are only valid within Imajin. External systems can't verify attribution because they don't know `did:imajin`.

**What needs to change:**
- .fair manifests include `did:dfos` alongside `did:imajin`
- `<FairEditor />` shows DFOS identity when available
- Asset delivery can verify requester via chain (for trust-graph access control)
- Future: content chains (DFOS content operations) for asset provenance

**Scope:** Small. Mostly adding `dfosDid` to attribution records.

**Issue scope:** `feat(fair): portable attribution with did:dfos`

---

### 7. Learn — LOW

**Current:** Enrollment and progress tracked by `did:imajin`. Course completion issues no verifiable credential.

**Gap:** Course completion isn't a portable credential. Can't prove "I completed this course" outside Imajin.

**What needs to change:**
- Enrollment attestation includes `did:dfos`
- Course completion → chain-backed credential (verifiable by anyone with the chain)
- Future: learning credentials as DFOS content operations

**Scope:** Small. Attestation enrichment, mostly.

**Issue scope:** `feat(learn): chain-backed enrollment + completion credentials`

---

### 8. Chat / Input — LOW (for now, HIGH for federation)

**Current:** Chat v2 schema is now live (v1 tables removed, PR #436). No message signing.

**Gap:** Messages aren't signed. Can't verify who sent what. Federation (#156) requires signed messages.

**What needs to change:**
- Message signing with chain keys (opt-in for now)
- Federation: verify sender chain before accepting relayed messages
- Whisper transcriptions (input service) → attribution via chain

**Scope:** Medium-large for federation. Small for basic signing.

**Issue scope:** `feat(chat): signed messages + federation prep`

---

## Recommended Priority

### Phase 1: Foundation (now → next sprint)
1. **Registry** — chain-backed node registration (unlocks federation)
2. **Profile** — surface DFOS identity (users can see/share their chain)

### Phase 2: Portability (after Phase 1)
3. **.fair/Media** — portable attribution
4. **Pay** — chain-aware settlement
5. **Events** — chain-backed attestations

### Phase 3: Federation (after relay — #405)
6. **Connections** — chain-backed pods + Cultural DID
7. **Chat** — signed messages + federation
8. **Learn** — verifiable credentials

---

## The Reverse Flow: External DFOS → Imajin

None of the above addresses the inbound story: someone with an existing `did:dfos` wanting to join the Imajin network.

**Proposed flow:**
1. User presents DFOS chain log to auth
2. Auth verifies chain cryptographically
3. Auth creates a `did:imajin` linked to the `did:dfos` (reverse bridge)
4. Registry recognizes the `did:dfos` as a valid network participant
5. All services see both DIDs — `did:imajin` for internal ops, `did:dfos` for portable identity

This is essentially "Log in with DFOS" — the sovereign equivalent of "Log in with Google." The chain IS the credential. No password, no OAuth, no platform dependency.

**Issue scope:** `feat(auth): external DFOS identity onboarding — "Log in with your chain"`

---

## Open Questions

1. **Dual DID display:** When both `did:imajin` and `did:dfos` exist, which do we show users? Both? Context-dependent?
2. **Chain as authority:** When DB and chain disagree (key mismatch, stale data), which wins? Chain should win, but the migration path matters.
3. **Soft DIDs:** Email-only users (`did:email:*`) can't have chains. Do they need a path to chain-backed identity? Or is the soft→hard upgrade sufficient?
4. **Performance:** Chain verification on every request is expensive. Where do we verify (every request? login only? periodic?) and where do we trust the DB cache?
5. **Cultural DID chain type:** Does DFOS support collective chains, or do we need to design a new operation type for multi-signer governance?

---

## Tonalith Notes

This proposal arrives after a major sprint (March 21–22) that shipped:
- `packages/cid` — DAG-CBOR content addressing (#400)
- Key rotation endpoints + `key_roles` column (#401)
- Countersignature attestations + `cid/author_jws/witness_jws` fields (#402)
- Chain-aware middleware (PR #413)
- Chain resolution endpoints (PR #412)

The audit's Phase 1 items (Registry, Profile) are the clearest next targets. The `@imajin/llm` package (also shipped this sprint) already includes `createAttestationTools` and `createProfileTools` — suggesting the agent layer may drive adoption before the services themselves are wired.

**Cross-references to existing proposals:**
- P13 (Cultural DID) / RFC-07 — §3 Connections is the Cultural DID implementation path
- P19 (Solana/Imajin Overlap) — `did:dfos` is the chain layer P19 anticipated; DFOS now live
- P22 (Identity Archaeology) — service-level DFOS adoption enables the read-side attestation queries P22 specifies
- P25 (Family DID) — §3 Connections + collective chain type question is directly relevant to family governance

---

## References

- #395 — DFOS DID Bridge epic
- #155 — Registry DID-to-endpoint resolution
- #255 / RFC-10 — Sovereign User Data
- #252 / RFC-07 — Cultural DID
- #405 — DFOS Phase 2 (relay, MCP, gas)
- #402 — Countersignature-based attestations (LIVE — PR #426)
- PR #412 — Resolution endpoints (LIVE)
- PR #413 — Chain-aware middleware (LIVE)
- PR #426 — Key rotation + multi-device (LIVE)
