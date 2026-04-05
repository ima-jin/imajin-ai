## STATUS: SUBSTANTIALLY RESOLVED
**Resolved:** 2026-03-22
**Evidence:** PRs #444 (chain-backed pod membership), #447 (external chain onboarding), #441 (registry chain resolution), #453 (DFOS relay live). P27 thesis adopted: "Trust relationships are attestation records on the chain, verifiable by anyone with the chain and the issuer's public key. Portability is mathematical, not contractual."
**Outcome:** The original question — "are trust relationships stored on the node or on the DID?" — is now answered architecturally and in code. Pod membership changes emit `pod.member.added`/`pod.member.removed` attestations on-chain. A user migrating to a new node presents their chain; the new node verifies it mathematically with no call back to the origin node. Standing recomputes locally from chain data.
**What remains open:** Cultural DID Phase B (collective chain governance for communities) — still needs a DFOS protocol proposal for multi-signer chains. Federation itself (DFOS relay propagation across multiple nodes) is the remaining runtime dependency — relay is live but only one node.
**Implementation:** Core architecture in code; full federation runtime requires multiple nodes running relay.

---

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

