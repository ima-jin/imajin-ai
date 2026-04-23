## 18. Consent Primitive — Unspecified Protocol Primitive

**Author:** Ryan Veteze (identified, not yet specified)
**Source:** `docs/articles/grounding-03-ARCHITECTURE.md:149–151` (relocated from `apps/www/articles/` post-kernel-merge)
**Status upstream:** TODO — explicitly unspecified in the architecture document (re-verified April 22, 2026 — line 151 is verbatim unchanged)
**Related upstream:** MJN Whitepaper v0.4, `@imajin/bus` epic #759, RFC-27 (Multi-Agent Coordination), RFC-28 (Universal Real-World Registry), Discussion #255 (Sovereign User Data), Discussion #268 (Embedded Wallet), PR #244 (Delegated App Sessions Phase 1 — merged)
**Connects to:** Proposal 6 (.fair signing), Proposal 17 (intent-bearing transactions), P37 (RFC-27 agent peer model), P38 (RFC-28 stub-claim commission), P40 (bus migration safety)

---

### April 22, 2026 — Status Sharpening

**Still open. The core P18 spec (ConsentDeclaration shape, attestation-type integration, Stream 2 migration) is untouched and still needed. What changes is the anchor layer and the non-confusion surface.**

**Re-verified April 22:**
- `grounding-03-ARCHITECTURE.md:151` is verbatim unchanged: *"TODO: Programmable consent per interaction..."* — still the one unspecified primitive among the four.
- `ATTESTATION_TYPES` at `packages/auth/src/types/attestation.ts:7–43` contains 34 entries; neither `consent.given` nor `consent.revoked` is among them.
- No `ConsentDeclaration` type exists anywhere in upstream outside Greg's own proposals.
- No settlement route checks for a consent record before processing.

**Explicit non-confusion — P18 is NOT satisfied by the consent-adjacent surfaces that shipped:**

1. **`app.authorized` / `app.revoked` attestations** (PR #244 Delegated App Sessions Phase 1, merged). From `apps/kernel/app/api/auth/authorize/route.ts:4–5`: *"Creates an app.authorized attestation when a user consents to an app's access request."* This is **OAuth-style delegated-app session consent** (user grants an app permission to act on their behalf). It satisfies C12's consent-UI surface. It is **not** P18's exchange-level consent primitive.
2. **`registry.did_preferences` / `registry.did_interests`** (shipped #538/#539, `apps/kernel/src/db/schemas/registry.ts:117, 128`) — per-DID per-scope channel-consent booleans (marketing/email/inapp/chat), lazy-populated from attestation activity. This is **notification-channel consent**. Same "adjacent layer, not this layer" pattern as P12.

**Neither shipped surface carries:** per-exchange scope, receiver-side declaration, travels-with-manifest, or settlement-gate behavior. P18's primitive remains absent.

**What complicates P18 since writing:**

- **@imajin/bus epic #759** (23 sub-issues #760–#782, 47 emit sites migrating to an event bus — see P40). The bus becomes the **natural attachment layer** for consent proofs at the event envelope. P18 should anchor to the bus, not to 47 scattered call sites. This shifts P18's implementation timing to post-bus.
- **RFC-27 Multi-Agent Coordination (peer agents)** — introduces a question P18 didn't anticipate: when an agent DID acts in the peer model, whose consent authorizes that action, and whose consent must the receiver verify? This is the mirror of P37 (which asks "who attested?") — P18-on-RFC-27 asks "who consented to being acted toward?"
- **RFC-28 Universal Real-World Registry** — the 90/10 stub-claim commission split (flagged in P38) implies consent to that split at claim-time. Without the P18 primitive, that consent is an unverifiable assumption. P18 and P38 are connected at this point.

**Load-bearing open question for Ryan (new April 22):**

> **Does the `@imajin/bus` event envelope include a consent-proof field, or is consent a separate middleware layer that reads from `auth.attestations`?**
>
> - If envelope-level: P18 ships alongside the bus migration as one of the consent-aware event types. `consent.given` / `consent.revoked` go into ATTESTATION_TYPES at the same time.
> - If middleware: P18 ships as a separate kernel middleware package; bus events carry a reference, middleware verifies against attestations.
> - If unspecified: the bus migration is consent-blind, and P18 needs to be specified *before* the bus lands to avoid retrofitting 47 sites twice.

**Revised anchor:** P18's natural implementation window is now **alongside the @imajin/bus migration**, not in isolation. Sections below preserve the original substance unchanged — the spec is still correct; only the sequencing and the "what it isn't" framing have shifted.

---

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

### Roadmap Placement — 2026-03-13

Assigned to **Phase 3** in the Settlement & Economics Hardening Roadmap. Ryan notes: "Medium — settlement doesn't prove both parties agreed."

The Settlement Roadmap explicitly identifies the absence of consent verification as a gap at the settlement layer. Stream 3 (automated node-to-node settlement) in the settlement roadmap cannot ship without a consent primitive — automated settlement without a signed consent record is the exact structural problem this proposal identifies.

The `consent.given` and `consent.revoked` attestation types should be added to the `auth.attestations` schema (#320) vocabulary when Phase 1 of the Identity Roadmap ships, making them available before the Phase 3 consent enforcement layer.

**Connection to Stream 2:** The current database-flag opt-in for Stream 2 (Declared-Intent Marketplace) should be migrated to a signed `consent.given` attestation when the attestation schema (#320) ships. This is a Phase 1 migration, not Phase 3 — it uses existing infrastructure once the table exists.
