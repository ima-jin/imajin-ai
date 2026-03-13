## 17. Intent-Bearing Transactions and Contribution Pools — RFC-05

**Authors:** Ryan Veteze, Jin
**Date:** March 3, 2026 (rfc-05-intent-bearing-transactions.md:5)
**Source:** `apps/www/articles/rfc-05-intent-bearing-transactions.md`
**Status upstream:** Draft
**Depends on:** RFC-01 (.fair attribution), RFC-02 (distribution contracts), RFC-04 (settlement protocol)
**Connects to:** Proposals 6 (.fair signing), 11 (Gas Model Ceiling), 16 (Distribution Contracts)

### Abstract (rfc-05-intent-bearing-transactions.md:12–14)

> *"This RFC extends the .fair protocol with two capabilities: intent declarations (money that carries purpose and constraints) and contribution pools (community-funded infrastructure with attributed rewards and mandatory redistribution). Together, these enable a new economic primitive: value that moves with meaning, accumulates through attribution, and redistributes by design."*

### Part 1 — Intent Declarations

**Motivation** (rfc-05-intent-bearing-transactions.md:22–24): Current payment systems move money but don't carry meaning. A $20 tip and a $20 grant and a $20 investment all look the same on the ledger. *"In a sovereign network, the reason money moves matters as much as the movement."*

**Schema extension to `.fair` manifest** (rfc-05-intent-bearing-transactions.md:28–41):

```json
{
  "fair": "0.2.0",
  "chain": [...],
  "intent": {
    "purpose": "infrastructure | living | grant | sponsorship | charitable",
    "directive": "human-readable description of intended use",
    "constraints": ["no-advertising", "open-source-only", "local-only", "no-surveillance", "attributed-only"],
    "pool": "pool_id (optional)"
  }
}
```

**Constraint enforcement model** (rfc-05-intent-bearing-transactions.md:60): *"Constraint enforcement is trust-graph-mediated. Violating a constraint doesn't block the transaction — it affects the violator's trust score. The network self-corrects through reputation, not gatekeeping."*

**Auditability** (rfc-05-intent-bearing-transactions.md:64–70): Every intent-bearing transaction is permanently auditable. The `.fair` manifest travels with the funds through every subsequent settlement — the full intent chain is traceable across all hops.

#### Greg's Position on Intent Enforcement

The trust-graph-mediated enforcement model is philosophically consistent but operationally weak at launch. Before the attestation layer (Proposals 7/8) is live and trust scores are meaningful, constraint violations have no teeth. Greg's position: intent constraints should be enforced in two phases:
1. **Phase 1 (pre-attestation layer):** constraints are logged and publicly auditable — violations are visible but don't trigger automatic consequences
2. **Phase 2 (post-attestation layer):** constraint violations trigger `flag.yellow` attestations against the violator's DID, which affect standing computation

The `constraints` field also has an intersection with the Gas Model Ceiling (Proposal 11): an Org DID that has constraint violations logged against it should pay higher gas to reach opted-in users — this is the `.fair` compliance gate proposed in Proposal 11 §6.1.

### Part 2 — Contribution Pools

**Motivation** (rfc-05-intent-bearing-transactions.md:78–80): *"Traditional funding models force a choice: donate (no returns) or invest (securities law). Contribution pools are a third path: community-funded infrastructure where attributed rewards flow back proportionally, with mandatory redistribution above thresholds."*

**Contribution rounds** (rfc-05-intent-bearing-transactions.md:124–130):

| Round | Timing | Weight |
|-------|--------|--------|
| 1 (Bootstrap) | Pre-revenue | 1.2× |
| 2 (Growth) | Early revenue | 1.1× |
| 3+ (Scale) | Established | 1.0× |

Weight multipliers are intentionally small — *"20% acknowledgment, not 10x returns. The goal is fair recognition, not wealth concentration."*

**Attribution staking** (rfc-05-intent-bearing-transactions.md:132–148): Pool funds are staked against the platform's `.fair` attribution chains. Rewards are proportional to attributed platform revenue — not speculation, not dividends, but participation in the value the platform creates.

**Mandatory redistribution — the anti-hoarding mechanism** (rfc-05-intent-bearing-transactions.md:152–175): When accumulated rewards exceed the redistribution threshold, the contributor *must* declare a distribution chain. Self-allocation is permitted but capped. Recipients must be valid DIDs in the trust graph. Circular chains are detected and rejected. *"Failure to declare within grace period → rewards pause (not lost)"* (line 175).

**Why this isn't securities — Howey test analysis** (rfc-05-intent-bearing-transactions.md:177–191):

| Howey factor | Contribution Pools |
|-------------|-------------------|
| Investment of money | Contribution to infrastructure you use |
| Common enterprise | Open network, no central management |
| Expectation of profit | Attributed rewards from usage, not speculation |
| From efforts of others | From attribution graph *including your own participation* |
| Accumulation | Mandatory redistribution above threshold |
| Transferable | Non-transferable, no secondary market |

**⚠️ Legal review required before implementation** (rfc-05-intent-bearing-transactions.md:191).

### Greg's Position on the Six Open Questions (rfc-05-intent-bearing-transactions.md:220–232)

**Q1 — Attribution decay as new modules enter** (line 222): Pool stakes should track dynamic attribution, not lock to a snapshot. Locking to a snapshot rewards early entrants whose code may have been superseded — dynamic attribution is more honest about current value. Greg's position: dynamic attribution with a floor — stakes cannot fall below 50% of their initial weight, preventing early contributors from being entirely displaced by later work.

**Q2 — Inactive contributors** (line 224): Rewards for dormant DIDs should accumulate with a decay threshold. Greg's position: accumulate for 24 months; after 24 months of DID inactivity, rewards begin redistributing to the active pool at 10% per month — consistent with the activity recency decay in the Cultural DID token context formula (Proposal 13 §3).

**Q3 — Negative attribution for removed bad actors** (line 226): This is the most architecturally complex question. If a `.fair` chain participant is removed (Trust Accountability Category C flag), retroactively zeroing their attribution would invalidate signed manifests. Greg's position: soft decay model — the removed DID's attribution weight decays from the removal date forward; historical signed manifests are not altered; pool rewards attributable to that DID's historical work stop accruing from the removal date.

**Q4 — Pool-to-pool staking** (line 228): Recursive attribution is powerful but creates cycle detection requirements across pools. Greg's position: permit pool-to-pool staking with a maximum depth of 2 (pool A stakes in pool B, pool B cannot stake in pools that stake back in pool A). Same cycle detection model as distribution contracts.

**Q5 — Governance of pool parameters** (line 230): Who adjusts round weights, redistribution thresholds, self-allocation caps? Greg's position: pool operator for pool-specific parameters (round weights, redistribution threshold); protocol constants for safety floors (maximum self-allocation cap at 60%, minimum redistribution threshold). Cultural DIDs operating pools should be able to set more restrictive parameters than the protocol defaults — but not less restrictive.

**Q6 — Tax implications** (line 232): Attributed rewards above reporting thresholds in relevant jurisdictions will require tax documentation. Greg's position: the `.fair` manifest chain is the tax documentation — every attribution event is a signed, timestamped, permanently auditable record. The execution engine should emit structured tax records per contributor per settlement period.

### New Code-Level Gap Identified

The `intent` field proposed in this RFC does not exist on `FairManifest` in `packages/fair/src/types.ts` (confirmed: file ends at line 41 with no `intent` field). This is a direct extension to the same type that P3 identifies as lacking a `signature` field. Both gaps must be resolved in the same PR — the manifest type needs both `signature` and `intent` added together to avoid two separate migrations of the same type.

**New problem flagged: P5 — FairManifest missing `intent` field** — see `problems.md` update.

### Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Does `intent` enforcement upgrade from logged-only to attestation-triggered automatically when Phase 1 attestation layer is live? | Enforcement model transition | Yes — automatic upgrade; constraints become `flag.yellow` triggers without a separate governance decision |
| Is the micro-founder layer (from RFC-02) the same as pool Round 1 contributors, or a separate primitive? | Avoids duplicating the early-contributor recognition mechanism | Same primitive — micro-founders are Round 1 pool contributors whose contribution type is `financial_contribution` instead of code or content |
| What is the protocol-level self-allocation cap: 60% (as specified in RFC-05 line 170), 40%, or governance-adjustable? | Anti-hoarding effectiveness | 60% as protocol floor; Cultural DID pools can set lower cap for their community |
| Does a pool have a DID (`did:imajin:pool:xxx` — rfc-05 line 88)? If so, can a pool be a `.fair` attribution recipient? | Pool as first-class network citizen | Yes — pool DID is required; pools can receive `.fair` attribution and redistribute it |

**Detecting resolution in the repo:**
- `intent` field added to `FairManifest` in `packages/fair/src/types.ts` (alongside P3's `signature` field)
- Pool creation and contribution endpoints in `apps/pay/` or new `apps/pools/`
- Redistribution threshold monitoring and distribution chain declaration UI
- Howey test legal review documented in `docs/decisions/` or equivalent

### Roadmap Placement — 2026-03-13

Split across phases in Ryan's .fair Hardening Roadmap:
- **Phase 0** — `intent?` field added to `FairManifest` type (tracked under #317, no crypto required)
- **Phase 2** — `intent` field enforcement: logged but not yet attestation-triggered
- **Phase 3** — Contribution pools (`apps/pools/` or `apps/pay/`), mandatory redistribution, full intent enforcement

Ryan noted this "needs issue" for the Phase 3 distribution scope. The Phase 0 type addition is covered under P5 / #317.

---

