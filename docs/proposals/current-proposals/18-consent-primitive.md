## 18. Consent Primitive — Unspecified Protocol Primitive

**Author:** Ryan Veteze (identified, not yet specified)
**Source:** `apps/www/articles/grounding-03-ARCHITECTURE.md:149–151`
**Status upstream:** TODO — explicitly unspecified in the architecture document
**Related upstream:** MJN Whitepaper, Discussion #255 (Sovereign User Data), Discussion #268 (Embedded Wallet)
**Connects to:** Proposal 6 (.fair signing), Proposal 17 (intent-bearing transactions)

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
