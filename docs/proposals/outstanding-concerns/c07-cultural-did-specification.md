### 7. Cultural DID — Open Specification Questions

**From:** Historical Context §6, Concerns & Resolutions §9

The Cultural DID proposal is architecturally sound and the governance model is coherent. The following specific questions require values and implementation decisions before specification is complete.

**Proposal filed (March 10):** Proposal 13 (Cultural DID Complete Specification) in `current-proposals.md` answers all seven questions:
- Minimum founding members: **5**; token context threshold: **≥ 100** (calibratable)
- Token context: weighted query over attestations + .fair contributions + trust graph depth + recency decay; **Stream 5 not an input**
- Governance weight ceiling: **33%** per Governing Member; automatic redistribution when exceeded
- Removal: behavioral process — governance.flag → 14-day response → quorum review (minimum 3, excluding flagger and flagged); permanent signed outcome
- Founding member compromise: three scenarios (key rotation, DID revocation, below-minimum count) each with specific handling including 90-day grace period and dormant state
- Cultural-Org DID relationship: **yes** — declared-and-attested connection between separate entities; accountability propagation is indirect
- Dissolution: high-quorum vote; `fair.attribution.resolution` attestations alongside original manifests (originals never modified); contested dissolution process with mediator

---

---

## Flagged Concerns — From Code Review

*These concerns were surfaced by reading the upstream codebase directly. They are not from external analysis — they are gaps between what the architecture proposes and what the code currently implements.*

