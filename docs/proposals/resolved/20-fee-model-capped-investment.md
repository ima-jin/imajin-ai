## STATUS: SUPERSEDED
**Superseded:** 2026-03-27 (by RFC-19 Kernel/Userspace Architecture)
**Evidence:** RFC-19 (upstream `docs/rfcs/RFC-19-kernel-userspace-architecture.md`, v5) specifies a 1% settlement fee split (0.4% node operator / 0.4% protocol / 0.2% user as MJN credit), replacing P20's 0.75% three-way split. The user's 0.2% MJN credit — "the internet that pays you back" — is a new element not in P20. RFC-19's model is now canonical in the protocol spec.
**What was adopted from P20:** Two-track fee structure concept (mandatory + voluntary); early-adopter weighting (via RFC-12/RFC-17); `.fair` chain as fee ledger.
**What was not adopted:** 0.75% split percentage; Supporter Pool structure (10% equity); financial contribution cap detection; quarterly disbursement mechanics. These remain in legal review limbo.
**Outcome:** P20's core philosophical contribution (fees should end after a cap; early adopters should be rewarded) influenced RFC-19's user MJN credit model. But RFC-19's 1% split is structurally different and supersedes P20's fee arithmetic. Supporter Pool and securities analysis remain unimplemented pending legal review.
**Original adoption note (March 15):** `docs/design/FEE_MODEL.md` published upstream with 0.75% split. This doc may now be stale relative to RFC-19's 1% model.
---

## 20. Fee Model — Capped Micro-Investment and Voluntary Equity

**Author:** Ryan Veteze (design doc, internal spec)
**Analysis:** Greg Mulholland (Tonalith)
**Date:** March 13, 2026
**Source:** Internal design doc "Fee Model: Capped Micro-Investment + Voluntary Equity"
**Status upstream:** DRAFT — *do not implement until legal counsel approves two-track structure, securities classification, and corporate structure options*
**Connects to:** Proposal 16 (Distribution Contracts), Proposal 17 (Intent-Bearing Transactions / RFC-05), Proposal 4 (Embedded Wallet), Proposal 11 (Gas Model), Settlement Roadmap Phases 0–3
**New upstream issues needed:** Wire events → pay settle; platform DID in .fair chains; `financial_contribution` attestation type

---

### Overview

Ryan's Fee Model proposes treating mandatory platform fees as **capped micro-investment** rather than perpetual extraction. Every transaction carries a small fee (~0.75%) that accumulates toward a per-person cap ($100 example). Once capped, the fee drops to zero and the accumulated amount earns a proportional share of the Supporter Pool (10% of Imajin equity). A voluntary Track 2 allows additional investment through a compliant crowdfunding rail.

This is structurally novel and architecturally consistent with the platform's sovereignty values: **the fee ends**. No platform takes a cut of your life indefinitely.

---

### The Two-Track Structure

**Track 1 — Mandatory Membership Investment (not a security)**

| Property | Value |
|---|---|
| Fee rate | ~0.75% per transaction |
| Cap per DID | $100 (example — calibration needed) |
| Tracking mechanism | `.fair` `financial_contribution` attestation on each fee payment |
| Post-cap behavior | Fee drops to zero; DID redirects 0.25% to creator or optional cause |
| What cap earns | Proportional share of Supporter Pool (10% of Imajin equity) |
| Share dilution | Shares do not dilute downward — new contributors buy at current (higher) valuation |
| Disbursements | Quarterly, from platform profit, proportional to Supporter Pool share |
| Transferability | Non-transferable; no secondary market |

**Track 2 — Voluntary Investment (securities-compliant)**

- Additional contributions above cap, or at any time
- Processed through Reg CF or equivalent compliant crowdfunding rail
- Same Supporter Pool equity, current valuation
- Full securities registration and audit requirements
- Clean legal boundary from Track 1

---

### The .fair Fee Chain

Every transaction splits its fee via a `.fair` attribution chain:

```json
{
  "fair": "1.0",
  "attribution": [
    { "did": "did:imajin:creator",   "role": "creator",  "share": 0.9925 },
    { "did": "did:imajin:protocol",  "role": "protocol", "share": 0.0025 },
    { "did": "did:imajin:host",      "role": "host",     "share": 0.0025 },
    { "did": "did:imajin:dev",       "role": "dev",      "share": 0.0025 }
  ]
}
```

After a DID reaches its $100 cap, the `dev` share returns to the creator:

```json
{
  "attribution": [
    { "did": "did:imajin:creator",   "role": "creator",  "share": 0.9950 },
    { "did": "did:imajin:protocol",  "role": "protocol", "share": 0.0025 },
    { "did": "did:imajin:host",      "role": "host",     "share": 0.0025 }
  ]
}
```

**Note on Settlement Roadmap Phase 0:** The Settlement Hardening Roadmap uses a 3% platform fee for events (organizer 97%, platform 3%). Ryan's Fee Model proposes 0.75% total split across protocol/host/dev. These are at different levels of the stack:
- The 3% (Settlement Phase 0) is the platform's gross fee from the event organizer — this is before the protocol-layer split
- The 0.75% (Fee Model) is the protocol-layer distribution of whatever the platform collects
- Both can coexist: the platform takes 3% from events, routes 0.75% of all transactions (including its own revenue) through the fee chain

This needs explicit clarification from Ryan before implementation. Greg's position: the fee chain split should apply to all settlement events including the platform's own revenue, not just end-user transactions.

---

### Early Adopter Weighting

Consistent with RFC-02 (Proposal 16) micro-founder model:

| Round | Timing | Multiplier |
|-------|--------|-----------|
| Round 1 (Bootstrap) | Pre-revenue / first 100 contributors | 1.2× |
| Round 2 (Growth) | Early revenue / next 1,000 | 1.1× |
| Round 3+ (Scale) | Established | 1.0× |

Multipliers are small and intentional — early recognition, not speculation.

**Connection to Proposal 17 (RFC-05):** The Round 1/2/3 structure is identical to the Contribution Pools round model in RFC-05. The same primitive covers both: the round is determined by the attestation timestamp of the first `financial_contribution` event.

---

### Greg's Positions on the Seven Legal Questions

**Q1 — Is the mandatory capped fee a security under Canadian law?**

The Howey test analysis in Ryan's doc is correct as far as it goes. The three strongest arguments against security classification:
1. **Mandatory** — a fee condition of platform access, not a voluntary investment decision
2. **Capped** — no ability to put in more to get more out (eliminates the "investment of money" motivated by profit)
3. **Access-based** — comparable to a credit union membership share or co-op buy-in

Greg's position: the co-op corporate structure (Ontario Co-operative Corporations Act) makes this argument strongest. A co-op membership fee returning proportional surplus is well-established in Ontario law and does not constitute a security. *Require legal confirmation before implementing any disbursement.*

**Q2 — Does quarterly disbursement from profit constitute a dividend?**

Greg's position: under the co-op model, this is a **patronage return**, not a dividend. Patronage returns are distributed based on member usage/contribution, not share count. This is a meaningful legal distinction — co-op surplus distributions have different regulatory treatment than corporate dividends. The `.fair` attestation chain provides the patronage calculation basis (every fee payment is a timestamped, signed record of the member's contribution). *Frame disbursements as patronage returns in all legal filings.*

**Q3 — Reg CF vs. Canadian alternatives (Ontario Securities Commission)?**

Greg's position: both will be needed for different user populations. The OSC has its own crowdfunding exemptions under Ontario Securities Act. For a Canadian company with Canadian users, OSC exemptions should be the primary vehicle for Track 2 (avoiding U.S. securities jurisdiction for Canadian participants). Reg CF (U.S.) is still appropriate for U.S. participants. A dual-track registration strategy requires two compliant platforms but is well-precedented.

**Q4 — Can the Supporter Pool convert to MJN tokens without triggering a new securities event?**

Greg's position: the conversion is structurally an exchange (existing entitlement → tokens at defined ratio), not a new issuance. The key risk is whether the token itself constitutes a security at the time of conversion. If MJN is structured as a utility token (network access, not profit right), and the conversion is framed as a like-for-like exchange of one network participation right for another, the securities risk is lower. *The legal analysis of the token itself needs to precede the conversion plan.* The attestation record proves the original entitlement — the conversion audit trail is already designed in.

**Q5 — Does early-adopter weighting create different "classes" of security?**

Greg's position: round-based multipliers are time-differentiated pricing (like early-bird tickets), not separate classes of securities. All members hold the same type of entitlement — a Supporter Pool share — purchased at different historical valuations. The multiplier is a valuation adjustment at time of contribution, not a structural right difference. *Ensure the round timestamp is the determining factor, not a DID attribute or separate share class.*

**Q6 — Multi-stakeholder co-op in Ontario — governance requirements and international members?**

Greg's position: a multi-stakeholder co-op under the Ontario Act can accommodate multiple membership classes (e.g., user-members, producer-members, worker-members). International members can join — co-op law does not require members to be Canadian residents, though the co-op itself must be incorporated provincially. The governance requirements (annual meetings, member voting rights, board composition) are manageable and actually *reinforce* the platform's stated governance values. This structure is worth serious exploration.

**Q7 — Does non-transferability help or hurt the securities analysis?**

Greg's position: non-transferability helps but does not fully solve. The Howey test's "reasonable expectation of profit" element is evaluated at the time of the original transaction, not based on whether a secondary market exists. Non-transferability eliminates speculation risk (can't flip the share) and removes the "common enterprise" risk (no pooled investment for shared management), but a mandatory fee with profit-sharing could still meet Howey's other prongs. Non-transferability is a strong supporting factor, not a decisive one. *Pair it with the co-op structure and the mandatory (not voluntary) nature for the strongest argument.*

---

### Code-Level Gaps

| Gap | Phase | Notes |
|-----|-------|-------|
| No platform DID in .fair chains | Settlement Phase 0 | Platform must appear as a chain recipient before fee collection can begin |
| No `financial_contribution` attestation type | Settlement Phase 0 / Identity Phase 1 | Fee payments must be logged as signed attestations for Supporter Pool tracking |
| No cap detection in settlement engine | Settlement Phase 1+ | Engine must know each DID's cumulative `dev` fee total and modify chain after cap |
| No Supporter Pool ledger | Settlement Phase 2+ | Proportional share computation requires a persistent, auditable ledger |
| Post-cap chain modification | Settlement Phase 1+ | The settlement engine must dynamically generate the cap-modified .fair chain per DID |
| Optional cause redirect (post-cap) | Settlement Phase 2 | DID can optionally redirect 0.25% to a cultural DID, community treasury, or cause |

**The cap detection problem is non-trivial.** Each DID's cumulative `dev` fee total must be tracked across all services and transactions. The settlement engine must query this total before generating the .fair chain for each transaction. This requires either:
- A dedicated `dev_fee_accumulation` table per DID (simple but non-sovereign)
- Or computing the total from the `financial_contribution` attestation history (sovereign, auditable, but more expensive at query time)

Greg's position: use the attestation history. The `financial_contribution` attestation chain IS the cap tracker — querying it is O(attestation count per DID), which is bounded and auditable. This avoids a separate denormalized counter that could drift from the attestation record.

---

### Connection to Proposal 19 (Solana / Imajin DID Overlap)

The Fee Model's Track 2 (voluntary investment via MJN token purchase) is the economic mechanism that connects to Pathway 2 in Proposal 19. A user who purchases MJN tokens to get a preliminary DID (Pathway 2) is simultaneously:
1. Getting their identity issued (DID registration)
2. Making their first `financial_contribution` toward the Supporter Pool cap
3. Establishing their Round 1 micro-founder timestamp (if pre-revenue)

This makes Pathway 2 registration a compound act: identity issuance + first fee contribution. The `.fair` chain for the MJN purchase should carry both purposes:
- `intent.purpose: "identity-registration"` (from Proposal 17)
- `financial_contribution` attestation to the Supporter Pool record

---

### Connection to Proposal 16 (Distribution Contracts)

The quarterly Supporter Pool disbursement is a distribution contract problem. Each share holder's proportional return is computed from:
- Their share percentage (attestation-derived)
- Platform quarterly profit (requires a defined calculation)
- Their distribution contract (where does the return flow?)

The distribution contract automation (Settlement Phase 2) is what makes quarterly disbursements practical without manual accounting. Without distribution contracts, Supporter Pool returns require batch computation and individual transfers — operationally expensive.

**Greg's position:** The Supporter Pool disbursement should be the first production use case for distribution contracts. It is predictable, quarterly, and fully computable from attestation records — the ideal proof-of-concept for the Phase 2 contract execution engine.

---

### Roadmap Placement — 2026-03-13

| Phase | Work | Dependency |
|-------|------|-----------|
| **Phase 0** | Platform DID in .fair chains; `financial_contribution` attestation type | None — ship now |
| **Phase 0** | Cap detection query: sum `financial_contribution` attestations per DID | Attestation type must exist first |
| **Phase 1** | Signed .fair fee chains (fee chain is cryptographically valid) | #316 + #317 (signing utilities) |
| **Phase 2** | Distribution contracts for quarterly Supporter Pool disbursements | Phase 1 signed settlement |
| **Phase 3** | MJN token conversion event — Supporter Pool → token distribution | Legal review + MJN token structure |

**Legal gate:** No Phase 0+ implementation of the Supporter Pool mechanics (cap tracking, share computation, disbursements) should begin until legal counsel has reviewed the two-track structure. The fee chain itself (0.75% split as `.fair` attribution) can be implemented as part of Settlement Phase 0 without the Supporter Pool mechanics — it is just a normal `.fair` chain.

---

### Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|---|---|---|
| How does the 0.75% protocol-layer fee relate to the 3% platform gross fee in the Settlement Roadmap? | Avoids double-fee confusion | 0.75% applies to all settlement; 3% is the platform's gross take from events; they coexist at different layers |
| Is cap detection based on attestation history or a dedicated counter? | Audit integrity vs. query performance | Attestation history — the chain IS the ledger |
| What is the minimum payout threshold for quarterly disbursements? | Prevents spam micropayments for small shareholders | Define a minimum (e.g., $1) — accumulate below threshold, roll to next quarter |
| Who computes the quarterly profit figure, and is the formula public? | Trust and transparency | Formula must be public and deterministic — computed from signed settlement records, not a board decision |
| What happens to the Supporter Pool share of a DID that goes inactive or is removed from the network? | Anti-hoarding / bad actor removal | Same model as RFC-05 contribution pools: accumulate for 24 months, then decay to active pool |

---

*Legal review required before any Supporter Pool implementation. The fee chain (.fair attribution split) is safe to implement in Phase 0. Cap tracking and share computation must wait for legal clearance.*

---
