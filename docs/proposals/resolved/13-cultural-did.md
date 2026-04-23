## STATUS: SPEC ADOPTED
**Adopted:** 2026-03-17
**Evidence:** `docs/rfcs/RFC-07-cultural-did.md` in upstream main (HEAD 23b9f2a). RFC-07 is authored as Greg's work (`@anonymous_observer`, March 9, 2026) and incorporates the specific answers from this proposal to all seven open specification questions.
**Outcome:** All key decisions adopted — minimum 5–7 founding members, token context threshold (performance qualifier not financial barrier), trust-weighted governance (not one-person-one-vote), four membership tiers (Governing/Active/Participant/Observer), governance weight ceiling with automatic redistribution, tiered visibility model (roster private to governing members), profit motive structurally excluded. Open questions remain: exact threshold values, dissolution mechanics, treasury multi-sig, cross-node Cultural DIDs.
**Implementation:** In spec only — attestation infrastructure (auth.attestations) is live which was the critical dependency; Cultural DID formation/governance code not yet built.

---

## 13. Cultural DID — Complete Specification

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/cultural-did-specification.md`
**Related upstream:** Discussion #252 (Cultural DID), #271 (Progressive Trust), #273 (Trust Accountability)
**Addresses:** Outstanding Concern 7 (Cultural DID — Open Specification Questions) — all seven questions answered

### Executive Summary

The Cultural DID is the fourth identity primitive: entities defined by shared practice rather than legal structure — art collectives, music scenes, mutual aid networks, intentional festivals, open-source creative projects. Discussion #252 is live. What was missing was specific, implementable answers to seven open specification questions. This document answers all seven with full analysis, cross-references to the prior proposals in this series, and code-level specifications ready for implementation tickets.

**Critical dependency:** The Cultural DID governance model depends entirely on the Attestation Data Layer (Proposals 7/8). Token context cannot be computed without `auth.attestations`. Phase 1 of Cultural DID implementation cannot begin until the attestation infrastructure is live. This is a technical requirement, not a preference.

### 1. Membership Tiers

| Tier | Description | Access |
|------|-------------|--------|
| Governing Member | Token context above formation threshold; active governance participation | Full governance weight, treasury access, dissolution vote |
| Active Member | Hard DID (Established) + minimum attestation count within Cultural DID | Participate in governance review, nominate Governing Members |
| Participant | Hard DID (Preliminary) + invited or vouched | Full cultural access, .fair attribution, event participation |
| Observer | Soft DID or un-vouched Hard DID | Public-facing content and events only |

Tier transitions are **computed states** derived from attestation history — not manual elections. A Person DID whose token context rises above the Active Member threshold is automatically eligible for promotion, confirmed by a Governing Member attestation.

### 2. Q1 — Founding Member Count and Token Context Threshold

**Minimum founding members: 5.**

Below 5 (2–3 founders) the Cultural DID is vulnerable to bad-faith formation by a small aligned group who accumulate governance control before genuine membership exists. 5 achieves quorum diversity (with a 33% ceiling, no single founder can block without 2 others) while remaining achievable early in the network's life. Above 7 creates formation barriers that exclude the communities Imajin most wants to reach.

**Token context threshold for formation:** Each founding Person DID must have token context ≥ 100 (proposed starting value — see Q2 for computation). This ensures founding members have demonstrated participation before forming a Cultural DID.

### 3. Q2 — Token Context Calculation

Token context is a **standing score computed from behavioral history** — a read-only query over `auth.attestations`, `.fair` records, and pod membership history. It is never stored as a value; always computed on demand. Consistent with Ryan's "standing is computed, not assigned" principle.

```
token_context(did) = (
  attestation_count(did)     × 1.0   +   // raw attestation volume
  fair_contributions(did)    × 3.0   +   // weighted — attribution = meaningful contribution
  trust_graph_depth(did)     × 2.0   +   // connections within the Cultural DID specifically
  activity_recency(did)      × 1.5       // decay function — recent activity weighted higher
) × community_context_multiplier
```

- **Attestation count:** all positive attestation types (event.attendance, vouch.given, checkin.verified, etc.)
- **.fair contributions:** count of `.fair` manifests where the DID appears in `attribution[]`
- **Trust graph depth:** BFS depth from the Cultural DID's membership pool specifically (community context, not global)
- **Activity recency:** linear decay over 12 months — full weight at 0 months, zero weight at 12 months of inactivity
- **Community context multiplier:** a node-specific parameter Cultural DIDs can set at formation (default 1.0; allows communities with different participation patterns to calibrate)

Stream 5 participation (inference fees, Network of Souls queries) is **not an input**. Token context is contribution-weighted, not inference-weighted.

### 4. Q3 — Governance Weight Ceiling and Redistribution Trigger

**Ceiling: 33% of total governance weight** among active Governing Members.

With a 33% ceiling, no single Governing Member can unilaterally control outcomes (majority requires >50%). A single Governing Member can prevent quorum from acting against them — this asymmetry is intentional: it is easier to block a bad decision than to force a good one. Correct governance posture for a community body.

**Redistribution trigger:** When any Governing Member's computed token context would push them above 33% of total, the excess weight is redistributed proportionally to other Governing Members. The redistribution is automatic and computed — not a governance vote.

**Edge case — below minimum Governing Members:** If Governing Member count drops below 5, governance weight ceilings are relaxed to allow the remaining members to function. The Cultural DID enters a grace period (see Q5, Scenario C).

### 5. Q4 — Governance Removal for Values Misalignment

The removal mechanism is behavioral rather than ideological — specific observable acts, not values judgments. The Cultural DID's founding charter can add community-specific removal criteria, but the base process is:

1. A Governing Member issues a `governance.flag` attestation citing a specific behavioral category from the removal criteria list
2. The flagged member is notified privately. They receive 14 days to submit a `governance.response` attestation
3. A quorum of Governing Members — **excluding the flagged member and the flagger** — reviews both attestations. Minimum: 3 participating Governing Members (or all remaining if fewer than 5 after exclusions)
4. Removal requires weighted majority of the reviewing quorum. The flagged member's governance weight is **suspended during review** — if the vote fails, they retain full standing
5. Outcome is recorded as `governance.removal` (approved) or `governance.flag.dismissed` (rejected) — both are permanent signed records

**Behavioral disqualification categories for Cultural DID removal:**
- Systematic extraction of community resources without contribution
- Harassment or sustained harm to members (corroborated by multiple attestation sources)
- Unauthorized use of Cultural DID identity or attribution
- Breach of the founding charter's declared behavioral commitments

The founding charter is the right place for values-based criteria specific to the community's domain.

### 6. Q5 — Founding Member DID Revocation or Compromise

**Scenario A — Keypair compromised, member still active:** Key rotation through social recovery (Embedded Wallet RFC #268). The new keypair inherits the DID. All attestations — including Cultural DID governance weight — continue uninterrupted. The key rotation event is recorded as a system attestation. No governance weight change.

**Scenario B — Governing Member DID revoked (Trust Accountability Category C flag):**
- Governance weight immediately zeroed and removed from computation
- Revocation recorded as `governance.member.revoked` against the Cultural DID
- The Cultural DID does not dissolve — it loses one governance anchor
- Attribution records naming the revoked DID are not altered — signed manifests remain permanently valid
- If active Governing Member count drops below 5, enter 90-day grace period (Scenario C)

**Scenario C — Cultural DID drops below minimum Governing Members:**
- 90-day grace period begins
- Remaining Governing Members can nominate Active Members for promotion to Governing Member
- Each promotion requires weighted majority of remaining Governing Members
- If count is not restored to 5 within 90 days, the Cultural DID enters **dormant state**
- Dormant Cultural DID: no governance actions, no treasury operations, attribution records remain permanent and valid
- Reactivation: 5 new Governing Members can petition for reactivation from the Active Member pool

### 7. Q6 — Cultural DID + Org DID Relationship

Yes — a Cultural DID can hold an Org DID relationship. A music scene Cultural DID that runs a record label. An artist collective with a gallery. A festival community that operates a production company. The architecture keeps them as **separate entities with a declared relationship**, not merged into a single primitive.

**The relationship is attested, not structural:**

```
cultural.org.relationship attestation:
  issuer_did:  [Cultural DID]
  subject_did: [Org DID]
  type:        'cultural.org.relationship'
  payload:     { relationship_type: 'operator' | 'partner' | 'fiscal_sponsor', declared_scope: string }
  signature:   [Cultural DID treasury key or Governing Member quorum signature]
```

**Privacy model:** The Org DID's business operations are transparent (mandatory for Org DIDs). The Cultural DID's internal membership and deliberation remain private. The relationship is public — which Cultural DID is connected to which Org DID, and in what declared capacity.

**Accountability propagation:** The Org DID's founding Person DID anchors are separate from the Cultural DID's Governing Members — unless the same Person DIDs hold both roles. Negative attestations on the Org DID do not automatically propagate to the Cultural DID (the relationship is declared, not structural ownership). However, a Pattern of Org DID misconduct by founding Person DIDs who are also Cultural DID Governing Members will affect their Cultural DID governance weight through the Trust Accountability Framework's standing penalties.

### 8. Q7 — .fair Attribution Records on Cultural DID Dissolution

Signed `.fair` manifests are permanent provenance records. Dissolution must not erase, invalidate, or make unverifiable any attribution records naming the Cultural DID.

**Dissolution process:**

1. A Governing Member issues `governance.dissolution.proposal` with written rationale and proposed attribution transfer distribution
2. Proposed distribution specifies how Cultural DID attribution shares transfer to individual Person DIDs. Default: proportional to governance weight at dissolution time. Quorum can vote for an alternative distribution
3. **High quorum bar:** weighted majority of **all** active Governing Members. Higher threshold than routine governance — dissolution is irreversible
4. If approved, dissolution event recorded as `cultural.dissolved` — signed by all Governing Members who voted in favour
5. Attribution resolution: `fair.attribution.resolution` attestations are issued alongside existing manifests — **not modifying original signed manifests** (which would invalidate their signatures), but issuing resolution records naming the individual Person DIDs who now hold the attribution shares

**The dissolved state is permanent and publicly visible.** The Cultural DID identity record does not disappear — it is marked as dissolved with a timestamp and reference to the dissolution attestation. Any future query about attributed work returns: (a) the original signed manifest, (b) the Cultural DID's record marked as dissolved, and (c) the resolution record naming the current attribution holders.

**Contested dissolution:** If the high-quorum bar is not met:
- Cultural DID enters a Dispute Resolution period (maximum 60 days)
- A mediator — an Established DID outside the Cultural DID, nominated by both sides — issues a non-binding `governance.mediation.report`
- After the report, a second dissolution vote is held
- If the second vote fails, dissolution is blocked for 90 days and can be re-initiated after that window
- During Dispute Resolution, governance is suspended except for emergency removal of members posing active harm

### 9. New Attestation Types Required

The Cultural DID specification requires the following additions to the controlled vocabulary defined in Proposals 7/8:

| Type | Issuer | Description |
|------|--------|-------------|
| `governance.flag` | Governing Member | Initiates removal review against another Governing Member |
| `governance.response` | Flagged member | Response attestation during removal review |
| `governance.removal` | Reviewing quorum | Records approved removal outcome |
| `governance.flag.dismissed` | Reviewing quorum | Records rejected removal — member retains standing |
| `governance.member.revoked` | System | Records loss of Governing Member due to Trust Accountability revocation |
| `governance.dissolution.proposal` | Governing Member | Initiates dissolution process |
| `cultural.dissolved` | Governing Member quorum | Records approved dissolution |
| `fair.attribution.resolution` | System (post-dissolution) | Resolution record mapping Cultural DID shares to individual Person DIDs |
| `cultural.org.relationship` | Cultural DID (treasury or quorum) | Declares relationship to an Org DID |
| `cultural.org.relationship.removed` | Cultural DID (treasury or quorum) | Records end of Cultural-Org DID relationship |

### 10. Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Minimum founding members: 5, or adjustable per community? | Determines formation barrier | 5 as protocol-level minimum; Cultural DIDs cannot form below 5 |
| Token context formation threshold: 100, or to be calibrated? | Gate for founding member qualification | Start at 100; calibrate after first Cultural DIDs form |
| Community context multiplier: who sets it and within what bounds? | Allows communities to weight participation differently | Cultural DID sets at formation; range 0.5–2.0; unchangeable after formation |
| Does the Cultural DID treasury key require quorum authorization for each signing act, or is it a delegated key? | Determines operational complexity of treasury operations | Delegated key with quorum authorization at key creation — same model as Proposal 6 |
| Should Cultural DID membership rosters be private by default or public by default? | Core privacy/transparency tradeoff | Private by default; Cultural DID can opt into public roster |
| Can a Cultural DID be reactivated from dormant state after more than 90 days? | Long-dormant communities may want to reconvene | Yes — no time limit on reactivation, but requires 5 new Governing Members from the remaining Active Member pool |

**Detecting resolution in the repo:**
- New migration adding Cultural DID tables or columns to existing schema
- `governance.flag`, `cultural.dissolved`, `fair.attribution.resolution` added to attestation type vocabulary
- Cultural DID formation flow in auth or a new `apps/cultural/` service
- Token context computation function referencing `auth.attestations`, `.fair` records, and trust graph depth
- Discussion #252 gains implementation status label or linked PR

---

