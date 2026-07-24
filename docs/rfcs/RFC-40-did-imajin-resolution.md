# RFC-40: `did:imajin` Resolution — Chain-Verified, Transport-Agnostic

**Status:** Draft
**Authors:** Ryan Veteze, Jin
**Created:** July 24, 2026
**Discussion:** TBD
**Related:** RFC-32 (Agent Protocol Interop — §4.7.4 names this as the biggest unlock), RFC-06 (Identity Portability), RFC-13 (Progressive Trust), RFC-22 (Federated Authentication), RFC-39 (Verifiable Skills — same verify-against-the-signed-record discipline)
**Tracking:** #1427 (honest-record promise), epic #965 (interop — resolution is shared infrastructure)
**Depends on / composes with:** DFOS resolution (`did:dfos`) — see §7 (open item for Brandon)

---

## Summary

For an external party to trust an Imajin action, it must be able to resolve `did:imajin:abc...` — with nothing but the DID string — into verification material (the public key / DID Document), and confirm the resolved material is authentic **without trusting whoever served it.**

Today we have most of the machinery (a public `GET /auth/api/identity/:did`, a `verifyChainLog()` chain verifier, a `did:imajin ↔ did:dfos` bridge) but it is shaped as a **hosted lookup**: the verifier trusts imajin.ai's database. That is the surveillance-era pattern wearing a decentralized-identity costume — "resolve without prior coordination" quietly becomes "trust our server."

RFC-40 specifies the sovereign version. The load-bearing move is to **separate transport from trust**:

- **Transport** (how a verifier obtains the bytes) may be anything — a hosted endpoint, DFOS gossip, `.well-known`, a cached copy. It is a dumb, untrusted pipe. It is *allowed* to be convenient, even centralized.
- **Trust** (whether the verifier believes the bytes) comes **only** from cryptographically verifying the DID's chain to its head. The transport can lie, stall, or be hostile; the verifier catches it because the chain either verifies or it does not.

This is the passport model from RFC-32 §4.7.0, one layer up: *any office can hand you a copy of the passport (transport); the tamper-proof chain is what makes it real (trust) — so it does not matter which office you asked.*

**Corollary (the elegant part): if resolution is chain-verified, revocation is free.** Key rotation and revocation are chain events. "Is this DID/key/delegation still valid right now?" is answered by reading the verified chain head — not by a separate trusted "is-revoked" API. This is the sovereign-correct resolution of RFC-32 §4.7.4(3).

---

## 1. Problem

RFC-32 §4.7.4 lists a public `did:imajin` resolver as the single biggest unlock for KYA-OS / AP2 / cross-org interop. The honest-record promise now in the README (#1427) makes it a public commitment, not just a nice-to-have. But "add a resolver" hides a thesis fork we must get right:

- A **hosted resolver** (`GET /:did` → DB row) unblocks external verifiers *fastest*, but it means every verification ultimately trusts imajin.ai. When there is one dominant hosted kernel that is *tolerable*; the moment there are many nodes — the whole federation thesis — it is a contradiction. Sovereignty cannot bottom out in "trust our server."
- A **naive chain-only resolver** is sovereign but has a bootstrap problem: verifying a chain requires *having* the chain log, and KYA-OS's premise is a verifier that arrives cold with only the DID string.

The resolution to both is the transport/trust split (§2). Neither pure option is correct; the correct design lets transport be convenient *because trust never depends on it.*

---

## 2. Position — Transport is a Pipe, Trust is the Chain

```
   DID string (did:imajin:abc...)
            │
            ▼
   ┌─────────────────┐   untrusted    ┌──────────────────────────┐
   │   TRANSPORT      │──────bytes────▶│   TRUST (verifier-side)   │
   │  (any source)    │                │  verifyChainLog(log)      │
   │  hosted / DFOS / │                │  → DID Document iff valid │
   │  .well-known /   │                │  → else REJECT            │
   │  cached / p2p    │                └──────────────────────────┘
   └─────────────────┘
```

- The transport returns a **chain log** (the signed key-event sequence) plus, optionally, a pre-rendered DID Document as a *hint*.
- The verifier **ignores the hint's authority** and re-derives the DID Document by verifying the chain log itself. The DID Document is an *output of verification*, never an input to trust.
- A malicious transport can withhold, delay, or serve a stale/forged log — all of which the verifier detects (forged → signature fails; stale → chain head mismatch once revocation is in the chain). It **cannot** cause the verifier to accept a false key.

**Design invariant:** *No Imajin service is a trusted third party in resolution.* imajin.ai may be the most convenient transport; it is never a required trust anchor.

---

## 3. The `did:imajin` Method

### 3.1 Identifier

`did:imajin:<method-specific-id>` where the id is the stable identifier already used across the platform (the `auth.identities.id`). The method spec defines:

1. **Resolve** — DID string → chain log → verified DID Document.
2. **Verify** — the deterministic procedure a cold verifier runs on the chain log.
3. **Revoke/rotate** — how key state changes are expressed as chain events (§5).

### 3.2 DID Document shape (verification output)

```json
{
  "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/ed25519-2020/v1"],
  "id": "did:imajin:abc...",
  "verificationMethod": [{
    "id": "did:imajin:abc...#key-1",
    "type": "Ed25519VerificationKey2020",
    "controller": "did:imajin:abc...",
    "publicKeyMultibase": "z..."
  }],
  "authentication": ["did:imajin:abc...#key-1"],
  "assertionMethod": ["did:imajin:abc...#key-1"],
  "service": [{
    "id": "did:imajin:abc...#chain",
    "type": "ImajinChain",
    "serviceEndpoint": "<transport hint — untrusted>"
  }],
  "imajin:chainHead": "<cid/hash of verified head>",
  "imajin:keyCount": 3
}
```

The DID Document is **derived** from `verifyChainLog()` output (which already returns `publicKeyHex`, `keyCount`, canonical DID). The `service` endpoint is a *hint* for the next verifier; it carries no authority.

### 3.3 Ed25519, not P-256

The resolution/proof spine is Ed25519 (the DFOS federation contract; RFC-32 §4.7.3). The DID Document verification methods are `Ed25519VerificationKey2020`. AP2's P-256 requirement lives only on the money leg, bridged by an attestation that binds the P-256 payment key to the Ed25519 principal DID — resolution never touches P-256.

---

## 4. Transport bindings (all untrusted, all interchangeable)

A verifier resolves by trying one or more transports; trust is identical regardless of which answered.

1. **HTTP hosted (convenience default).** Reshape the existing `GET /auth/api/identity/:did` to also return the **chain log**, not just the current key. Add a W3C DID Document view. Public, CORS-enabled (already is). This is the fast path and it is honest *because the verifier re-verifies the log.*
2. **DFOS relay / gossip.** For `did:imajin` DIDs bridged to `did:dfos` (`getChainByImajinDid`), the chain log is retrievable from the relay. This is the federated transport and the composition point with Brandon's wire (§7).
3. **`.well-known` discovery.** A documented resolver location (e.g. `GET /.well-known/did-imajin/:id` or a resolver metadata doc at `/.well-known/did-configuration`) so a cold verifier knows where to fetch without prior coordination.
4. **Self-carried (offline).** The passport case: the credential embeds its own chain log inline (DFOS UCAN `prf`-style). Zero fetch. Verifier validates offline. Strongest sovereignty; fattest credential.

> **Note:** RFC-32 §4.7.4(1) can be satisfied *incrementally* by shipping transport #1 first (fast KYA-OS legibility) **without compromising the thesis**, precisely because the verifier library (§6) re-verifies. The centralized-looking endpoint is safe the moment trust is chain-derived.

---

## 5. Revocation & rotation via the chain head (the free primitive)

Because trust = verifying the chain to its head, key state is whatever the head says:

- **Rotation** is already a chain event (`/rotate`, `identity_chains`, `KeyRoles`). The verified head yields the *current* key set; superseded keys are visibly superseded in the log.
- **Revocation** is a chain event that marks a key/delegation invalid. There is already a `relay_revocations` table on the DFOS/relay side — RFC-40 defines revocation as a **first-class chain entry** that any verifier observes when it verifies to the head, and that the relay indexes for fast lookup (index, not authority).
- **`credentialStatus` (RFC-32 §4.7.4(3))** resolves to "check the DID's chain head" — no separate trusted revocation service. A KYA-OS Verifier checking "is this delegation still valid" runs the same verify-to-head it already ran to resolve the key.

**Freshness caveat (honest):** offline / self-carried verification (transport #4) proves validity *as of the head the verifier has*. Detecting a revocation that happened *after* that snapshot requires a fetch (transport #1/#2). This is inherent to offline verification (same as OCSP-stapling vs live OCSP). The method spec must state the freshness model explicitly per transport; it must never imply offline = live-revocation-aware.

---

## 6. Reference verifier — `@imajin/did-resolve`

A library (new package, or into `@imajin/auth`) implementing: `DID string → try transports → verifyChainLog → DID Document | REJECT`. Requirements:

- **We dogfood it.** Every internal cross-service resolution goes through it (RFC-39 discipline — verify against the signed record, including our own).
- **It is the external reference implementation** a KYA-OS Verifier / edge proxy embeds. Publishable, dependency-light, Ed25519 only.
- **Transport-pluggable**: hosted / DFOS / well-known / inline all satisfy the same interface; trust code is shared and transport-independent.
- **Fails closed**: unknown transport, missing log, or verification failure → REJECT, never "assume valid."

---

## 7. DFOS composition — open item for Brandon

DID resolution overlaps Brandon's wire spec: DFOS already resolves `did:dfos`. RFC-40 must **compose with, not fork,** DFOS resolution. The bridge exists (`getChainByImajinDid`, `getIdentityByDfosDid`, `storeDfosChain`, `verifyClientChain`, `relay_revocations`).

Per the ⊃ conformance relationship (two-entity split): a conformant Imajin resolver **includes** DFOS resolution. Concretely:
- A `did:imajin` bridged to a `did:dfos` should resolve by delegating the chain-verification to the DFOS path where that is the source chain, then presenting the `did:imajin` canonical alias.
- Revocation must reconcile: is `relay_revocations` the canonical revocation surface for bridged DIDs, or does Imajin layer its own on top? (Open.)
- **Confirm with Brandon before building** that a `did:imajin` method does not collide with DFOS's resolution contract — this is a coordination item, not a solo build.

---

## 8. Non-goals

- Not P-256 / not a new curve (§3.3).
- Not a trusted revocation *service* (§5 — revocation is a chain event).
- Not a new identity registry — reuses `auth.identities`, `identity_chains`, the DFOS bridge.
- Not authorizing implementation. This RFC is the method spec; the build lands as an epic under #965 after the DFOS-composition question (§7) is answered.

---

## 9. Phasing

1. **Method spec + verifier interface** (this RFC + `@imajin/did-resolve` interface, no transport yet). Architecture-first.
2. **Transport #1 (hosted, chain-log-returning) + DID Document view** — reshape existing `GET /:did`; ship KYA-OS legibility with chain re-verification. Fast, honest.
3. **Revocation-as-chain-event** formalized; `relay_revocations` reconciled with the method (§5, §7).
4. **DFOS composition** (§7) — after Brandon sign-off.
5. **Transport #3/#4** (`.well-known` discovery, self-carried inline) — full cold + offline resolution.

Each phase is independently honest: no phase makes trust depend on transport.

---

## 10. Open questions

1. **`did:imajin` method registration** — register formally in the W3C DID method registry, or document + expose via `.well-known` first? (Registry = discoverability + legitimacy; costs nothing but process.)
2. **Freshness policy** — what maximum staleness does an Imajin node advertise as acceptable for offline-verified delegations before a live revocation check is required? (§5 caveat.)
3. **Revocation canonicality for bridged DIDs** — `relay_revocations` vs an Imajin-layer revocation log (§7).
4. **Transport discovery precedence** — when multiple transports are available, does the verifier prefer fastest (hosted) or most-sovereign (self-carried/DFOS)? Probably fastest-that-verifies, with policy override.
5. **Stiftung boundary** — the `did:imajin` *method spec* is protocol-surface; does it eventually live under the Swiss protocol entity (per the two-entity split) while the reference implementation stays in Imajin Inc.? (Consistent with RFC-20/21 conformance framing.)

---

## 11. Related work

- **RFC-32 §4.7** — names this resolver as the biggest interop unlock; RFC-40 is that gap, specified.
- **RFC-06** — Identity Portability & Backup Nodes: resolution is what makes a portable identity verifiable off its home node.
- **RFC-22** — Federated Authentication: the auth spine that already resolves DID → Ed25519 key to verify signed messages.
- **RFC-39** — Verifiable Skills: same "verify the working copy against the signed record" discipline, applied to capabilities instead of keys.
- **DFOS Specification** — `did:dfos` resolution, relay, `relay_revocations`; the wire we compose with (§7).

---

*"Any office can hand you a copy of the passport. The chain is what makes it real — so it doesn't matter which office you asked."*
