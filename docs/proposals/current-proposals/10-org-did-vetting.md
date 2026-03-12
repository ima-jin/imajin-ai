## 10. Org DID Vetting and Early-Member Influence

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/org-did-vetting.md`
**Related upstream:** Discussion #253 (Org DID), #248 (Org DID original), #273 (Trust Accountability)
**Addresses:** Outstanding Concern 4 (Vetting and Early-Member Influence)

### Executive Summary

The Org DID proposal correctly identifies that businesses require a structurally distinct identity primitive: typed, publicly transparent, less privileged than Person DIDs, and non-severably anchored to founding Person DIDs so accountability cannot be discarded. The proposed vetting mechanism — covenant as standard, trust-graph attestation as mechanism — is architecturally elegant.

The concern: early members of the network accumulate outsized and compounding influence over which businesses are ever permitted to enter. If the founding community is culturally or economically homogeneous, the vetting mechanism will systematically reflect that homogeneity — not through bad intent, but through the mathematics of trust graph depth and attestation weight.

This proposal presents an integrated **Composite Attestation Model** (Position 4) that draws on the attestation infrastructure to build a vetting system that is decentralized, community-accountable, and structurally resistant to founding-cohort capture.

### 1. The Compounding Dynamic

1. Network launches with a founding community
2. Founding members' attestations determine who becomes Established DIDs
3. Established DIDs vouch for Org DID claims with weight proportional to their standing
4. Founding members have the deepest trust graphs, most connections, highest standing
5. New members have lower attestation weight
6. The founding community's values are structurally embedded in the vetting mechanism

Even if attestation weight decays over time, the covenant document itself may embed founding cohort values. A covenant that explicitly names behavioral disqualifications can be governed fairly. A covenant that implicitly reflects founding cohort aesthetic preferences will exclude legitimate businesses without obvious mechanism for appeal.

### 2. The Founding Person DID Anchor as Accountability Infrastructure

The non-severable link between an Org DID and its founding Person DID(s) is the mechanism that gives Org DID accountability its teeth. Negative attestations on an Org DID propagate a standing penalty to founding Person DIDs. A Person DID that vouches for an Org DID's entry stakes their own standing on that business's future behavior.

A new attestation type is needed to record this relationship: `org.founding` — issued by the system at Org DID creation, recording which Person DIDs are founding anchors.

### 3. Soft-Loading as Pre-Vetting Evidence

The soft-loading model from Discussion #253 inverts standard business onboarding: don't ask businesses to join, let their customers accumulate a presence, then the business claims what their community already built.

**Critical distinction:** `org.checkin.soft` (a Person DID checking in at a location before any claim exists) is fundamentally different from `org.claim.vouch` (a Person DID explicitly endorsing an Org DID claim). A Person DID who checked in at a coffee shop three years ago did not consent to be counted as a vetting endorser. Soft-loading history is evidence of community use — it should **inform** the vetting decision, but must not **substitute** for explicit attestation.

### 4. Position 4 — The Composite Attestation Model (Recommended)

Three positions are available (attestation-only, decay-based, covenant-only). None resolves the problem cleanly. The Composite Attestation Model requires three simultaneous inputs — none of which can be gamed in isolation:

| Input | Mechanism | Capture Resistance |
|-------|-----------|-------------------|
| Person DID attestations | Standing-weighted `org.claim.vouch` from Established DIDs | Gaming requires acquiring Established DID standing first |
| Soft-loading evidence | Count of `org.checkin.soft` attestations from any DID level | Democratic — counts community use regardless of checker-in's standing |
| Covenant compliance declaration | Self-declaration against a behavioral disqualification list | Auditable — tests behaviors, not values |

**How the composite model addresses compounding influence:** Soft-loading attestations are issued by any Person DID — Preliminary or Established. A new member who has been a regular customer generates soft-loading evidence that counts on equal footing with a founding member's check-in. The soft-loading floor is **decoupled from trust graph depth**.

**Proposed claim threshold (example — to be calibrated):**
- Minimum 3 `org.claim.vouch` attestations from Established DIDs (weighted by standing)
- Minimum 15 distinct `org.checkin.soft` attestations (unweighted — any DID level counts)
- Covenant compliance self-declaration (binary — present or absent)

The bar should be achievable by a legitimate local business with real community relationships, and unachievable by a coordinated bad actor who has manufactured soft-loading data.

### 5. The Covenant Document — The Most Urgent Deliverable

The covenant document should appear in `docs/` or `apps/www/articles/` in the repo. It should contain:

- A **behavioral disqualification list** — explicit, auditable behaviors, not values statements
- Categories of clear disqualification: data brokers, surveillance advertisers, extractive labor platforms, predatory lending
- An explicit statement on data handling and .fair compliance requirements
- A version number and amendment process
- An explicit acknowledgment of what the covenant does **not** restrict (aesthetic preferences, market categories, business models not on the disqualification list)

**The covenant is the most urgent deliverable** — it must be written, reviewed, and ratified before the first Org DID claim is processed, because once the first businesses are admitted, the covenant is retroactively fixed by those admissions.

### 6. Connections to the Architecture Series

- Requires `auth.attestations` with `org.founding`, `org.checkin.soft`, and `org.claim.vouch` attestation types
- Founding Person DID accountability propagation requires standing computation in Proposal 7/8
- The cluster gaming vector in Stream 2 (Gas Model Ceiling) depends on `org.founding` attestation linkage to detect coordinated Org DID clusters

### 7. Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| What is the minimum `org.claim.vouch` threshold? | Determines entry bar for Org DIDs | 3 Established DIDs minimum, calibrated post-launch |
| What is the minimum soft-loading count? | Determines community evidence requirement | 15 distinct Person DIDs, any tier |
| Does soft-loading evidence expire? | Old check-ins from long-departed members may not reflect current community | Yes — 24-month decay window recommended |
| Who writes the first covenant document? | Founding team or community ratification? | Ryan drafts; community comment period before first Org DID claim |
| Can a Person DID lose their founding anchor status for an Org DID? | If accountability propagation becomes too burdensome | No — the anchor is permanent; the accountability is the value |

**Detecting resolution in the repo:**
- `org.founding`, `org.checkin.soft`, and `org.claim.vouch` attestation types in the controlled vocabulary
- Covenant document appears in `docs/` or `apps/www/`
- New migration for Org DID claim flow referencing composite attestation model
- `apps/auth/` or a new `apps/business/` service gains Org DID claim processing logic

---

