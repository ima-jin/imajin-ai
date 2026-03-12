### F6. Consent Primitive Marked TODO in Architecture Doc (March 11 Review)

**Flagged:** March 11, 2026
**Source:** `apps/www/articles/grounding-03-ARCHITECTURE.md:149–151`

The architecture document lists four protocol-level primitives (Identity, Attribution, Consent, Settlement). Three are specified. Consent is:

> *"TODO: Programmable consent per interaction. Not a terms-of-service checkbox. A signed declaration attached to each exchange that says exactly what the sender permits."*

This is a one-sentence TODO for a primitive that every other part of the protocol depends on. Without a specified consent model, `.fair` signing proves attribution but not consent; intent declarations (RFC-05) are sender-only; Stream 2 opt-in is a database flag rather than a signed protocol record; Stream 3 automated settlement has no receiver-declared consent record.

**Proposal filed (March 11):** Proposal 18 (Consent Primitive) in `current-proposals.md` proposes a `ConsentDeclaration` type, its place in `auth.attestations` as `consent.given` / `consent.revoked` attestation types, and the relationship to Stream 2 opt-in, Stream 3 settlement, and the Embedded Wallet's delegated key model.

---

