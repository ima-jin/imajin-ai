# RFC-05: Intent-Bearing Transactions and Contribution Pools

**Status:** Draft  
**Authors:** Ryan Veteze, Jin  
**Created:** 2026-03-03  
**Requires:** RFC-01 (.fair attribution), RFC-02 (runtime modules), RFC-04 (settlement protocol)

---

## Abstract

This RFC extends the .fair protocol with two capabilities: **intent declarations** (money that carries purpose and constraints) and **contribution pools** (community-funded infrastructure with attributed rewards and mandatory redistribution).

Together, these enable a new economic primitive: value that moves with meaning, accumulates through attribution, and redistributes by design.

---

## 1. Intent Declarations

### 1.1 Motivation

Current payment systems move money. They don't carry meaning. A $20 tip and a $20 grant and a $20 investment all look the same on the ledger.

In a sovereign network, the *reason* money moves matters as much as the movement. A contributor who says "this is for infrastructure, not advertising" should have that intent honored and auditable.

### 1.2 Schema

Extend the `.fair` manifest with an optional `intent` field:

```json
{
  "fair": "0.2.0",
  "chain": [...],
  "intent": {
    "purpose": "string",
    "directive": "string",
    "constraints": ["string"],
    "pool": "pool_id (optional)"
  }
}
```

| Field | Description | Required |
|-------|-------------|----------|
| `purpose` | Category: `infrastructure`, `living`, `grant`, `sponsorship`, `charitable` | Yes |
| `directive` | Human-readable description of intended use | No |
| `constraints` | Conditions the recipient must honor | No |
| `pool` | If this transaction enters a contribution pool | No |

### 1.3 Constraints

Constraints are strings representing conditions on how funds may be used:

- `no-advertising` — funds may not be spent on advertising
- `open-source-only` — funds must support open-source projects/services
- `local-only` — funds must flow to locally-operated nodes
- `no-surveillance` — funds may not support data collection services
- `attributed-only` — funds may only flow through .fair-attributed chains

Constraint enforcement is trust-graph-mediated. Violating a constraint doesn't block the transaction — it affects the violator's trust score. The network self-corrects through reputation, not gatekeeping.

### 1.4 Auditability

Every intent-bearing transaction is permanently auditable. The `.fair` manifest travels with the funds through every subsequent settlement. If Alice contributes $20 with `purpose: infrastructure`, and that $20 eventually settles to an inference provider, the full chain is traceable:

```
Alice → pool_platform → settlement_batch_47 → did:inference:provider
  intent: infrastructure
  constraint: open-source-only ✓
```

---

## 2. Contribution Pools

### 2.1 Motivation

Traditional funding models force a choice: donate (no returns) or invest (securities law). Contribution pools are a third path: community-funded infrastructure where attributed rewards flow back proportionally, with mandatory redistribution above thresholds.

This is not investment. There is no equity, no ownership stake, no secondary market, no speculative expectation. Contributors fund infrastructure they use, and the attribution graph determines how value flows back.

### 2.2 Pool Structure

```json
{
  "id": "pool_xxx",
  "name": "Imajin Platform Fund",
  "did": "did:imajin:pool:xxx",
  "created_at": "2026-03-03T00:00:00Z",
  "total_contributed": 0,
  "contributors": [],
  "attribution_stake": {},
  "redistribution_threshold": 1000.00,
  "round": 1,
  "round_weight": 1.2
}
```

### 2.3 Contributing

Any DID may contribute to a pool. Contributions are recorded with:

- Amount
- Timestamp
- Round (determines weight)
- Intent (optional — purpose, constraints)

```
POST /api/pool/:id/contribute
{
  "from_did": "did:imajin:alice",
  "amount": 50.00,
  "intent": {
    "purpose": "infrastructure",
    "constraints": ["open-source-only"]
  }
}
```

### 2.4 Contribution Rounds

Early contributors accept more risk. Rounds acknowledge this with modest weight multipliers:

| Round | Timing | Weight | Meaning |
|-------|--------|--------|---------|
| 1 (Bootstrap) | Pre-revenue | 1.2x | Platform doesn't exist yet |
| 2 (Growth) | Early revenue | 1.1x | Platform is proving itself |
| 3+ (Scale) | Established | 1.0x | Platform is functioning |

Rounds are declared by pool operators, not automated. Weight multipliers are intentionally small — 20% acknowledgment, not 10x returns. The goal is fair recognition, not wealth concentration.

### 2.5 Attribution Staking

The pool's funds are *staked against* the platform's `.fair` attribution chains. As the platform processes transactions (query settlements, ticket sales, tips), each `.fair` manifest identifies who contributed value.

The pool earns attributed rewards proportional to the value the platform creates:

```
Platform revenue this month: $5,000 (through .fair settlements)
Pool total: $10,000
Pool reward rate: 5% of attributed platform revenue

Pool rewards this month: $250

Alice contributed $500 (5% of pool, round 1 @ 1.2x)
Alice's effective share: 6% (5% × 1.2)
Alice's reward: $250 × 6% = $15.00 → credited to cash balance
```

### 2.6 Mandatory Redistribution (Distribution Chains)

**When accumulated attributed rewards exceed the redistribution threshold, the contributor MUST declare a distribution chain.**

This is the anti-hoarding mechanism. You cannot simply accumulate. Above the threshold, you must state where your rewards flow:

```json
{
  "did": "did:imajin:alice",
  "pool": "pool_platform",
  "distribution_chain": [
    { "to": "did:imajin:local-food-bank", "share": 0.30 },
    { "to": "did:imajin:open-source-fund", "share": 0.30 },
    { "to": "did:imajin:alice", "share": 0.40 }
  ]
}
```

Rules:
- Distribution chain is required when accumulated rewards exceed threshold
- Self-allocation is permitted but capped (e.g., max 60% to self)
- Recipients must be valid DIDs in the trust graph
- Circular chains are detected and rejected (A→B→A)
- Chain is public and auditable
- Can be updated at any time
- Failure to declare within grace period → rewards pause (not lost)

### 2.7 Why This Isn't Securities

This design intentionally avoids securities characteristics:

| Securities (Howey) | Contribution Pools |
|--------------------|-------------------|
| Invest money | Contribute to infrastructure you use |
| Common enterprise | Open network, no central management |
| Expectation of profit | Attributed rewards from usage, not speculation |
| From efforts of others | From attribution graph including your own participation |
| Accumulation | Mandatory redistribution above threshold |
| Transferable | Non-transferable, no secondary market |
| Ownership/equity | No ownership, no voting rights, no asset claims |

**⚠️ Legal Review Required:** While this design is structured to avoid securities classification, consult qualified counsel in relevant jurisdictions before implementation. This RFC is a technical specification, not legal advice.

---

## 3. Implementation Phases

### Phase 1: Intent Declarations
- Add `intent` field to `.fair` manifest schema
- Update settlement engine to log intent with transactions
- Intent-filtered transaction queries ("show me all infrastructure spending")

### Phase 2: Contribution Pools (Basic)
- Pool creation and contribution endpoints
- Reward calculation based on platform .fair revenue
- Balance crediting for pool rewards

### Phase 3: Distribution Chains
- Threshold monitoring
- Distribution chain declaration UI
- Circular chain detection
- Automated redistribution execution

### Phase 4: Contribution Rounds
- Round management for pool operators
- Weight application in reward calculations
- Round history and transparency

---

## 4. Open Questions

1. **Attribution decay:** As new modules enter the ecosystem, existing attribution weights shift. Should pool stakes track dynamic attribution or lock to snapshot at contribution time?

2. **Inactive contributors:** What happens to rewards for dormant DIDs? Accumulate? Redistribute to active pool after timeout?

3. **Negative attribution:** If a .fair chain participant is removed for bad behavior, how does this affect pool rewards that were calculated including their attribution?

4. **Pool-to-pool staking:** Can one contribution pool stake in another? Recursive attribution networks could be powerful or dangerous.

5. **Governance:** Who adjusts round weights, redistribution thresholds, self-allocation caps? Pool operator? Contributor vote? Trust-weighted consensus?

6. **Tax implications:** Attributed rewards above certain amounts may have tax consequences. The .fair manifest could serve as tax documentation. Jurisdictional analysis needed.

---

## 5. References

- RFC-01: .fair Attribution Manifests
- RFC-02: Runtime Modules
- RFC-03: Memory Attribution (HRPOS)
- RFC-04: Settlement Protocol
- Moloch DAO ragequit mechanism (precedent for exit rights)
- Howey Test, SEC v. W.J. Howey Co. (1946) — securities classification
- Imajin issues: #141, #143, #110, #111, #117

---

*Contributors fund infrastructure. Attribution determines rewards. Redistribution prevents accumulation. Money carries meaning. The network self-corrects through trust, not gatekeeping.*
