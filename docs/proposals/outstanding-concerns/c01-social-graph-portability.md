### 1. Social Graph Portability (Exit Guarantee)

**From:** Historical Context §4.6, Concerns & Resolutions §7

**The concern:**
The sovereignty floor rests on portable identity. But DID portability and social graph portability are different things.

- Cryptographic key portability is solid — you take your keypair anywhere.
- Trust graph portability is unspecified: can you take your accumulated trust relationships, reputation, and attestations when you leave a node?

If you take your keys but start over socially, exit costs are substantially higher than the framing suggests. Higher exit costs mean weaker operator accountability — the threat to leave is less credible.

**What resolution requires:**
An explicit architectural answer to: *are trust relationships stored on the node or on the DID?*

- If **node-stored**: portability is keys-only, exit costs are high, the sovereignty claim is weakened.
- If **DID-stored or protocol-level**: true portability holds, the sovereignty claim is fully load-bearing.

This should be the next architectural specification priority before the sovereignty guarantee is published as a core feature.

**Code finding (March 10):** Trust graph IS node-stored. Confirmed in `packages/trust-graph/src/schema.ts` — pod membership lives in `connections.pod_members`, a Postgres table on the node. RFC-001 (`docs/rfcs/RFC-001-identity-portability.md`, status: Draft) proposes exporting `connections.json` as part of a full portable identity context package — this is the active resolution path. Implementation tickets not yet created. Track RFC-001 progress.

**Proposals filed (March 10):** Proposal 5 (BaggageDID) and Proposal 7 (Cryptographic Trust Layer) in `current-proposals.md` address this concern directly. Proposal 8 (Attestation Data Layer — Full Architecture) extends Proposal 7 with two additional unaddressed risks: node dark / orphaned attestation history (§4.1) and cascading revocation when an issuer DID is compromised (§4.2). BaggageDID closes the departure event gap specifically. Cryptographic Trust Layer is the architectural prerequisite — BaggageDID must be built on top of the attestation layer, not on unsigned DB records.

---

