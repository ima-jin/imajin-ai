### 6. Declaration Granularity Standards (Stream 2)

**From:** Historical Context §4.3, Concerns & Resolutions §3

**The concern:**
Local profile matching (business sees match count, not the profile) is the correct privacy model. But match quality depends on declaration granularity. Coarse categories ("specialty coffee, vinyl, local restaurants") resist inference attacks. Fine-grained declarations ("Ethiopian natural process, within 2km, Tuesday mornings") start to reconstruct a detailed profile — even if it stays on the user's node.

**What resolution requires:**
A .fair-equivalent standard for permissible declaration categories, or explicit guidance on declaration granularity. Who governs this, and what enforcement looks like, needs to be specified before Stream 2 is live.

**Proposal filed (March 10):** Proposal 12 (Declaration Granularity Standards — Stream 2) in `current-proposals.md` recommends k-anonymity threshold enforcement (Option B) as the primary mechanism with sensitive category floors at the protocol level. Adds a `DeclarationEntry` type system with Ed25519 signing and `sensitivity` enum. Together with Proposal 11, defines the complete privacy envelope for Stream 2.

---

## Open Specification — Cultural DID Primitive

