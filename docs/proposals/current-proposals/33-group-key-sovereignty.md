## 33. Group Key Sovereignty — From Dead Keys to Cryptographic Self-Custody

**Author:** Greg Mulholland
**Date:** April 7, 2026
**Priority:** HIGH → **ELEVATED April 22** — blast radius grew; two new RFCs now depend on this primitive
**Matrix cells:** All group scopes (org/community/family) x Identity + Attestation
**Related issues:** #587 (Group Identities), #537 (Event DID sub-identity delegation — *closed April 8 by a proposal-filing PR, not a code fix*)
**Related RFCs:** RFC-11 (Embedded Wallet — multi-sig, quorum, social recovery), RFC-22 (Federated Auth), **RFC-27 Multi-Agent Coordination (April 20) — new blocker**, **RFC-28 Universal Real-World Registry (April 21) — new blocker**
**Related concerns:** C04 (Org DID vetting), C13 (covenant), C24 (Bilateral attestation — "group-key signing" still listed as a gap)
**Connects to:** P10 (Org DID Vetting), P14 (Governance Equity), P25 (Family DID), P32 (Mooi), **P37 (RFC-27 peer agents), P38 (RFC-28 registry), P40 (bus migration timing — load-bearing for P33 sequencing)**

---

### April 22, 2026 — Status Sharpening

**Zero phases shipped. The gap is live and has widened. The 1-day Phase 1 fix is still 1 day; the blast radius of not doing it has grown.**

**Verified April 22 against upstream code (428 commits since P33 filed):**
- **`decryptPrivateKey` does not exist** anywhere in the codebase. Grep returns only P33's own proposal text.
- **`signAsGroup` / `signAsDid` do not exist.**
- **`auth.key_shares` table does not exist.** No Shamir / threshold primitives.
- **Group DFOS chains** — no evidence `storeDfosChain()` runs for group DIDs on creation.
- **MEMORY.md C24 gap list (re-verified April 22):** *"Gaps: enforcement, group-key signing, legacy null-status records."* "Group-key signing" still listed.

**Misleading surface — #537 is closed, the gap is not:**

Issue #537 ("Entity DIDs need real identities") was auto-closed on April 8 by commit `cf0ecaa2` — which is **Greg's own April 7 PR filing this proposal** (commit message: *"Phase 1 also resolves #537 and unblocks institution.verified"*). The PR filed the proposal document; no code fix landed. The issue tracker reports "completed"; upstream code reports unresolved.

The actual pattern used for event-attributed attestations today is **node-DID-signs-on-behalf-of-event**. Verified at `apps/events/app/api/events/[id]/tickets/[ticketId]/check-in/route.ts:67–74`: `issuer_did: nodeDid` pulled from `relay_config.imajin_did`, not from the event DID. This is a workaround for dead keys, not the architectural fix.

**What has widened the gap since P33 was filed:**

1. **PR #750 scope-aware writes merged** — 13 routes now flow `actingAs` correctly but still sign with the platform key. More code writes *as the group* while cryptography is *as the platform*. The mismatch §1 identified covers 13 additional routes.
2. **RFC-27 Multi-Agent Coordination (April 20)** — agents get their own peer DIDs (`scope: 'actor', subtype: 'agent'`). For agents to sign their own attestations (required by the peer model), the `signAsDid` primitive P33 specifies is a prerequisite. P37 blocker.
3. **RFC-28 Universal Real-World Registry (April 21)** — public stubs need signing capability once claimed (claim-acceptance, commission attestations, migration events). Another load-bearing consumer of the same primitive.
4. **@imajin/bus epic #759 (23 sub-issues, 47 emit sites migrating)** — every attestation emission routes through the bus envelope. P33 Phase 1 is now implicitly a bus-routing decision. Sequencing choices: before bus (retrofit later), during bus (cleanest, couples P33 to P40 timing), after bus (middleware retrofit, sovereignty gap persists through migration window).
5. **Identity tier attestations added to vocabulary** (`identity.verified.preliminary/hard/steward/operator`) — each attribution to a node/org DID inherits the dead-key problem.
6. **Fee model v3 gas operations** — group-initiated gas operations should be group-signed. When gas ships, the dead-key gap blocks correct gas-operation attribution.

**§7 Open Questions — April 22 status:**

| Q | Status |
|---|---|
| Q1: Phase 1 pre-fundraise? | Still open; unshipped 15 days later. Sovereignty claim remains cryptographically false for groups. |
| Q2: Unify signAsGroup / signAsDid? | Moot until either exists. |
| Q3: Threshold defaults per scope? | Moot — no threshold infrastructure. |
| Q4: Recovery share opt-in? | Moot until Phase 2 scaffolding exists. |
| Q5: DFOS chain for groups — Phase 1 or 2? | Moot — no group chains created. |
| Q6: base58 vs hex DID format? | **Still open.** C11 (isValidDID) unchanged — `publicKey.slice(0, 16)` still in `packages/auth/src/providers/keypair.ts:52` after 428 commits. |

**Load-bearing open question for Ryan (new April 22):**

> **Is Phase 1 implemented before, during, or after the @imajin/bus migration (#759)?**
> - **Before:** ship `decryptPrivateKey` + `signAsGroup` + routing now, retrofit into 47 emit sites during bus migration. Lowest latency closing the sovereignty gap; highest migration cost.
> - **During (recommended):** bus envelope gets a `signAs` hook as part of migration. 47 sites inherit correct signing on day one of bus. Couples P33 to P40 timing but is the cleanest story.
> - **After:** middleware in the bus pipeline detects group-DID-attributed events and re-signs. Lowest migration cost; sovereignty gap persists through the bus migration window (23 sub-issues worth of time).
>
> The bus migration is already a massive refactor. A `signAs` hook at envelope-level is a cross-cutting concern that belongs in the bus, not sprinkled across call sites.

**Severity framing update:**
- **When filed (April 7):** §1 called the gap "foundational." Phase 1 = 1 day of work.
- **At April 22:** 13 more scope-aware routes + 2 new RFCs (RFC-27, RFC-28) now depend on this primitive. The 1-day fix is still 1 day; the cost of *not* doing it grew.
- **Demo/investor liability:** "Humans own their identity, payments, and data" — with group keys dead, this is cryptographically false for every group DID. The story tells investors sovereignty; the code says node-custody.

Sections below preserve the original substance unchanged — the spec is still correct; urgency and sequencing are what shifted.

---

### 1. The Problem — Group Keys Are Dead Keys

The forest infrastructure shipped in the April 3–7 sprint (#587, #592, #593, #597) is architecturally excellent. Group identities work. Scope-aware services work. Controllers can act on behalf of groups across all 12 userspace services. But there is a foundational gap:

**Group Ed25519 keypairs are generated, encrypted, stored, and never used.**

The current flow (`apps/auth/app/api/groups/route.ts`):

1. Server generates Ed25519 keypair via `generateKeypair()` (noble/ed25519)
2. Private key is encrypted with AES-256-GCM using `GROUP_KEY_ENCRYPTION_SECRET` (env var) + PBKDF2 (100K iterations)
3. Encrypted key is stored in `auth.stored_keys`
4. **No `decryptPrivateKey` function exists anywhere in the codebase**

The group key is write-only. It is never retrieved, never decrypted, never used to sign anything.

**All attestations — including ones attributed to group DIDs — are signed by the platform key (`AUTH_PRIVATE_KEY`).** The attestation endpoint (`/api/attestations/internal`) uses a single server-side key for all signatures. The `issuer_did` field is metadata; the cryptographic signature is always the platform's.

This means:
- `group.created` — signed by platform key, attributed to caller's personal DID
- `group.member.added` — signed by platform key, attributed to admin's personal DID
- `scope.onboard` — signed by platform key, `issuer_did` set to group DID but signature is platform's

**The sovereignty promise breaks here.** The platform thesis is "humans own their identity, payments, and data." But group identity is entirely platform-dependent:

- If the node operator loses `GROUP_KEY_ENCRYPTION_SECRET`, all group private keys are unrecoverable
- If `GROUP_KEY_ENCRYPTION_SECRET` is compromised, all group private keys are exposed
- If the node goes offline, no group can sign anything (because it never could)
- Group attestations are not self-certifying — they're platform-certifying
- Groups have no DFOS chains — no key rotation, no proof history, no portability

For Mooi: if Borzoo's node goes down, the Mooi community identity is inert. Not frozen — it was never alive. The key exists in a table but has never signed a single attestation.

---

### 2. What Exists Today (Build From, Don't Rebuild)

The current infrastructure is solid foundation, not wrong direction:

| Component | Status | Where |
|-----------|--------|-------|
| Group keypair generation | Working | `apps/auth/app/api/groups/route.ts` via `generateKeypair()` |
| Group key encryption | Working (but one-way) | Same file, `encryptPrivateKey()` using AES-256-GCM + PBKDF2 |
| `stored_keys` table | Working | `auth.stored_keys` — one key per DID, encrypted ciphertext + salt |
| `groupControllers` table | Working | Roles (owner/admin/member), `allowedServices`, soft-delete |
| Controller validation | Working | `requireAuth()` validates `X-Acting-As` against controllers |
| Attestation emission | Working (platform-signed) | `packages/auth/src/emit-attestation.ts` → `/api/attestations/internal` |
| DFOS chain infrastructure | Working (for individuals) | `auth.identity_chains`, `/api/identity/[did]/rotate`, `storeDfosChain()` |
| Key rotation flow | Working (for individuals) | `/api/identity/[did]/rotate` — requires `session.sub === did` |
| Ed25519 primitives | Working | `packages/auth/src/crypto.ts` — sign, verify, generateKeypair |
| RFC-11 vision | Documented | Multi-sig (family), quorum (cultural), social recovery (trust graph) |

**The gap is not infrastructure — it's the bridge between key storage and key use.**

---

### 3. Proposed Architecture — Phased Key Sovereignty

Three phases, each independently valuable, each building on the last. Ryan can ship Phase 1 in a day. Phase 2 is the sovereignty unlock. Phase 3 is the long game.

#### Phase 1 — Activate Dead Keys (Server-Delegated Signing)

**Goal:** Group keys actually sign things. Server-mediated, but cryptographically correct.

**What to build:**

1. **`decryptPrivateKey(encryptedKey, salt)`** — the missing inverse of `encryptPrivateKey()`. Same AES-256-GCM + PBKDF2 derivation, decrypt instead of encrypt. Add to `apps/auth/app/api/groups/route.ts` (or better, extract to `apps/auth/lib/group-keys.ts`).

2. **`signAsGroup(groupDid, payload)`** — internal utility that:
   - Looks up `stored_keys` for the group DID
   - Calls `decryptPrivateKey()` with `GROUP_KEY_ENCRYPTION_SECRET`
   - Signs with the group's Ed25519 key via `packages/auth/src/crypto.ts:signSync()`
   - Returns signature
   - **Never exposes the decrypted key beyond function scope** (zeroize after use)

3. **Update attestation emission for group-attributed attestations:**
   - When `issuer_did` is a group DID, call `signAsGroup()` instead of signing with `AUTH_PRIVATE_KEY`
   - Attestations: `scope.onboard`, `group.created` (if issuer should be group), any future group-issued attestations
   - The `issuer_did` now corresponds to the actual signing key

4. **DFOS chain for group DIDs:**
   - On group creation, call `storeDfosChain()` for the group DID (same as individual identity creation)
   - This makes the group identity verifiable and portable

**Trust model:** The node still holds the group key. This is the same trust model as a traditional platform — but now the cryptography is correct. Attestations are verifiable against the group's public key, not the platform's. DFOS chain means the group has proof history.

**Scope:** ~1 day of work. `decryptPrivateKey` is the mirror of existing code. `signAsGroup` is a wrapper. Attestation routing is a conditional. DFOS chain creation is a function call.

#### Phase 2 — Controller-Held Key Shares (Threshold Signing)

**Goal:** The node no longer holds group secrets. Controllers collectively hold the key. k-of-n threshold required to sign.

**What to build:**

1. **Shamir Secret Sharing at group creation:**
   - Generate keypair as today
   - Split private key into `n` shares (one per founding controller) with threshold `k` (configurable, default: majority)
   - Encrypt each share to the respective controller's public key (Ed25519 → X25519 via `ed2curve` or use `crypto_box_seal`)
   - Store encrypted shares in a new `auth.key_shares` table: `(group_did, controller_did, encrypted_share, share_index)`
   - **Delete the combined private key** — the server never stores it after splitting
   - Delete the `GROUP_KEY_ENCRYPTION_SECRET`-encrypted key from `stored_keys`

2. **Threshold signing protocol:**
   - When a group signature is needed, collect `k` partial signatures from online controllers
   - Each controller decrypts their share client-side, produces a partial signature, submits it
   - Server combines partial signatures into a valid Ed25519 signature
   - **No single party (including the server) ever holds the full private key**

3. **New `key_shares` table:**
   ```sql
   CREATE TABLE auth.key_shares (
     group_did TEXT NOT NULL,
     controller_did TEXT NOT NULL,
     encrypted_share TEXT NOT NULL,    -- encrypted to controller's Ed25519-derived X25519 key
     share_index INTEGER NOT NULL,
     threshold INTEGER NOT NULL,       -- k required
     total_shares INTEGER NOT NULL,    -- n total
     created_at TIMESTAMPTZ DEFAULT NOW(),
     PRIMARY KEY (group_did, controller_did)
   );
   ```

4. **Share redistribution on controller changes:**
   - When a controller is added: re-split with new `n`, new shares to all controllers
   - When a controller is removed: re-split with new `n-1`, revoke old shares
   - This requires `k` existing controllers to participate (they reconstruct, re-split, re-distribute)

**Trust model:** No single point of failure. The node operator cannot sign as the group unilaterally. Controller departure triggers resharing. The group key survives node migration — controllers carry their shares.

**Scope:** ~1–2 weeks. Shamir implementation exists in npm (`shamir-secret-sharing`, `secrets.js`). The complexity is in the share redistribution protocol and the UX for collecting partial signatures.

**Per-scope defaults (from RFC-11 vision):**
- **Community (Cultural DID):** Quorum — majority of governing members (e.g., 4-of-7)
- **Org:** Board threshold — 2-of-3 or 3-of-5 depending on org size
- **Family:** All-or-majority — 2-of-2, 2-of-3, or 3-of-5

#### Phase 3 — Social Recovery + DFOS Key Rotation for Groups

**Goal:** Groups can recover from key loss via trust graph attestation. Groups can rotate keys with full DFOS chain history.

**What to build:**

1. **Group key rotation via DFOS:**
   - Extend `/api/identity/[did]/rotate` to accept group DIDs
   - Require `k`-of-`n` controller authorization (not `session.sub === did`)
   - New key shares distributed to controllers
   - Old key revoked on DFOS chain
   - All services that cached the group's public key get invalidation signal

2. **Social recovery:**
   - If fewer than `k` controllers are available (lost keys, departed without resharing):
   - `m` trusted connections (from the group's trust graph) attest to a new keypair
   - Trust-weighted threshold: connections with higher standing count more
   - Once threshold met, new keypair inherits the DID, old shares invalidated
   - Recovery event recorded as DFOS chain operation

3. **Cross-node group migration:**
   - Group controllers can collectively sign a migration attestation
   - DFOS chain proves the group's identity to the new node
   - No data loss — the chain IS the identity

**Scope:** Post-fundraise (Phase 3 on roadmap). Depends on DFOS federation (Phase 2/3) and relay auth (C10).

---

### 4. Migration Path — Zero Breaking Changes

Each phase is backward-compatible:

| Phase | What Changes | What Doesn't |
|-------|-------------|--------------|
| Phase 1 | Attestations signed by group key instead of platform key. DFOS chains created for groups. | Controller model, forest config, scope-aware services, `requireAuth()` — all unchanged |
| Phase 2 | Key storage moves from `stored_keys` to `key_shares`. Signing requires controller participation. | Everything above, plus: attestations are still verified the same way (Ed25519 against group pubkey) |
| Phase 3 | Key rotation adds DFOS chain operations. Social recovery adds trust graph dependency. | All existing attestations remain valid (chain is append-only) |

**Phase 1 is fully internal** — no client changes, no UX changes, no schema migrations beyond adding DFOS chain rows for group DIDs. The group's public key is already in `auth.identities`. Attestation verification doesn't change (verify against group pubkey instead of platform pubkey — same `verifySync()` call).

---

### 5. Security Considerations

**Phase 1 risks:**
- `GROUP_KEY_ENCRYPTION_SECRET` is a single point of compromise. Mitigate: rotate the env secret periodically and re-encrypt stored keys.
- Server holds plaintext briefly during signing. Mitigate: zeroize immediately after `signSync()`.
- This is still server-custodied — explicitly acknowledge this as a stepping stone, not the end state.

**Phase 2 risks:**
- Share redistribution is a complex protocol. If done wrong, controllers can be locked out. Mitigate: always keep one "recovery share" encrypted to the node operator as a fallback (opt-in, transparent to controllers).
- Threshold UX: collecting `k` partial signatures is inherently slower than server signing. Mitigate: for low-stakes operations (notifications, routine attestations), allow a delegated session token signed by the group key during a threshold ceremony, valid for a limited time.
- Shamir over finite fields: standard Ed25519 Shamir implementations exist and are well-tested. Don't roll custom crypto.

**Phase 3 risks:**
- Social recovery can be Sybil-attacked if trust graph is sparse. Mitigate: trust-weighted thresholds (RFC-11's model).
- Key rotation invalidates cached public keys across federated nodes. Mitigate: DFOS chain is the source of truth; services should resolve current key from chain, not cache.

---

### 6. Relationship to Existing Work

| Existing | How This Proposal Relates |
|----------|--------------------------|
| RFC-11 (Embedded Wallet) | RFC-11 envisions multi-sig (family), quorum (cultural), social recovery. This proposal provides the implementation path. |
| #537 (Event DID sub-identity delegation) | Phase 1 resolves this: event DIDs can sign their own attestations once `signAsGroup` / `signAsDid` exists. The pattern is identical — decrypt stored key, sign, zeroize. |
| P29 (Attestation Completeness) | Phase 1 directly unblocks `institution.verified`: once event/group DIDs can sign, the attestation can be cryptographically issued by the event DID. |
| `AUTH_PRIVATE_KEY` (platform key) | Remains the signer for platform-level attestations (node identity). Group attestations get their own signatures. Clear separation of platform vs. group authority. |
| `stored_keys` table | Phase 1 uses it as-is (add decrypt). Phase 2 migrates group entries to `key_shares`. Individual user entries in `stored_keys` are unaffected. |
| Fee model v3 (gas fees) | Gas operations (attestations, config changes) that are group-initiated should be signed by the group key, not the platform key. Phase 1 makes this possible. |

---

### 7. Open Questions for Ryan

1. **Phase 1 priority:** Is activating group signing worth doing before the fundraise, or is it post-fundraise work? Phase 1 is ~1 day and makes the "self-certifying identity" claim truthful for groups — relevant to investor demos.

2. **Event DID signing (#537):** The same `decryptPrivateKey` + `signAsDid` pattern solves both group and event signing. Should these be unified into a single `signAsDid(did, payload)` utility, or kept separate?

3. **Threshold defaults per scope:** RFC-11 envisions different models per scope type. Should the threshold be configurable at group creation, or hardcoded per scope (community: majority, org: 2-of-3, family: all)?

4. **Recovery share opt-in:** Phase 2 suggests an optional node-operator recovery share. Is this acceptable (pragmatic fallback) or does it undermine the sovereignty claim (node operator can always reconstruct)?

5. **DFOS chain for groups — Phase 1 or Phase 2?** Creating DFOS chains for group DIDs at creation is trivial (call `storeDfosChain()`). But it creates a commitment: once a chain exists, the protocol must maintain it. Is the chain creation worth doing before threshold signing is ready?

6. **`base58` vs `hex` DID format:** Group DIDs use `didFromPublicKey()` which produces `did:imajin:{base58(publicKey)}`. Individual DIDs from `createDID()` still truncate to 16-char hex (C11). Should group creation wait for C11 resolution, or are the two formats intentionally different?

---

### 8. Why This Matters Beyond Groups

The `decryptPrivateKey` + `signAsDid` pattern is not group-specific. It unlocks:

- **Event DID signing** — resolves #537, unblocks `institution.verified` (P29)
- **Agent DID signing** — agents can sign their own attestations (P24)
- **Any server-custodied DID** — the pattern is generic: look up key, decrypt, sign, zeroize

Phase 1 is a 1-day investment that makes the entire identity system cryptographically honest. Phase 2 is the sovereignty unlock that makes the investor story true. Phase 3 is the long-term vision that makes groups as sovereign as individuals.

The platform that doesn't lock you in is the platform you never need to leave. That promise must extend to groups, not just individuals.
