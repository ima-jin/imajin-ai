# RFC-21: Imajin Conformance Suite

**Status:** Draft
**Author:** Ryan Veteze
**Date:** 2026-03-29

---

## Summary

An executable specification for Imajin node compliance. The test suite IS the spec. Every rule, bound, and policy is expressed as an assertion. Reading the tests tells you the rules. Running the tests tells you if you comply.

## Relationship to Other Conformance Layers

| Layer | Owner | What it validates |
|-------|-------|-------------------|
| Protocol (DFOS) | Brandon / Clearbyte | Storage, replication, DAG sequencing |
| **Chain-Type (RFC-20)** | **Imajin** | **DAG → application state projectors** |
| **Node (this RFC)** | **Imajin** | **Economic rules, identity policy, trust, governance** |
| Userspace App (RFC-19) | Imajin | App registration, shell protocol, scope enforcement |

DFOS owns one layer: protocol. Everything above is Imajin. Brandon explicitly offloaded chain-type semantics to the application layer — "how a DAG is projected into application state is application semantics." RFC-20 and RFC-21 together form the **Imajin Conformance Suite**: RFC-20 validates that you read the data correctly, RFC-21 validates that you follow the rules of the network.

## Principle: Tests Are the Spec

No separate specification document. The conformance suite is the authoritative source of truth for Imajin network rules. If a rule isn't in a test, it isn't a rule. If a test asserts something, that's the rule.

Rationale: Specs drift from implementations. Tests don't — they either pass or fail. Anyone who wants to know "what are Imajin's rules?" reads the test assertions. Anyone who wants to build a compliant node runs the suite until it's green.

The tests are open source. The rules are public. Certification — running those tests against a production node, officially — is the commercial product.

---

## Test Categories

### 1. Settlement Conformance

Three-party fee model. Every economic transaction must calculate and distribute fees correctly.

```
TestSettlement_DefaultRates
  → $100 MJNx transaction
  → assert protocol_fee == 1.00 MJNx
  → assert node_fee == 0.50 MJNx
  → assert user_credit == 0.25 MJNx (converted to MJN at current rate)
  → assert seller_receives == 98.25 MJNx

TestSettlement_MinimumBound
  → node sets all rates to 0.25%
  → $100 transaction
  → assert total_fee == 0.75 MJNx
  → assert accepted

TestSettlement_BelowFloor_Rejected
  → node sets protocol fee to 0.1%
  → assert rejected
  → assert error contains "below minimum bound of 0.25%"

TestSettlement_AboveCeiling_Rejected
  → node sets node fee to 2.5%
  → assert rejected
  → assert error contains "exceeds maximum bound of 2%"

TestSettlement_ZeroTransaction_NoFee
  → $0 MJNx transaction (free event)
  → assert no fee entries generated
  → assert no user credit generated
  → assert attestation IS generated

TestSettlement_FeeBearer
  → seller initiates $100 sale
  → assert fee deducted from seller proceeds
  → assert buyer pays exactly $100 MJNx

TestSettlement_UserCreditConversion
  → 0.25 MJNx credit at 25:1 rate
  → assert buyer receives 6.25 MJN
  → assert MJN entry written to buyer's DFOS chain
```

### 2. Gas Conformance

Operations cost gas. Gas is denominated in MJN. The node charges, the user pays.

```
TestGas_OperationCharged
  → user submits attestation
  → assert gas entry created
  → assert gas_amount == current node gas rate
  → assert gas entry references operation CID

TestGas_BilateralSignature
  → gas charge entry
  → assert signed by user (operation signature)
  → assert countersigned by relay (gas charge signature)
  → assert gas entry references relay's published rate schedule

TestGas_InsufficientBalance_Rejected
  → user with 0 MJN balance submits operation
  → assert rejected
  → assert error contains "insufficient gas balance"

TestGas_StarterBalance
  → new DID created
  → assert MJN balance == 100

TestGas_RateMatchesSchedule
  → relay publishes rate of 0.1 MJN
  → user submits operation
  → assert gas charge == 0.1 MJN
  → relay charges 0.5 MJN
  → assert rejected (does not match published rate)

TestGas_BogusCharge_NoOperation
  → gas charge entry with no corresponding user operation
  → assert rejected
  → assert error contains "no matching operation"
```

### 3. Rate Change Conformance

Rates can change. Decreases are instant. Increases require notice.

```
TestRateChange_DecreaseInstant
  → node publishes rate decrease (0.5% → 0.3%)
  → transaction submitted immediately at new rate
  → assert accepted

TestRateChange_IncreaseRequiresNotice
  → node publishes rate increase (0.5% → 0.8%)
  → transaction submitted 1h later at new rate
  → assert rejected
  → assert error contains "rate increase notice period"

TestRateChange_IncreaseAfterNotice
  → node publishes rate increase (0.5% → 0.8%)
  → transaction submitted 25h later at new rate
  → assert accepted

TestRateChange_ScheduleOnChain
  → node publishes new rate
  → assert rate schedule entry exists on chain
  → assert entry signed by node DID
  → assert entry contains timestamp and new rates

TestRateChange_BackdatingRejected
  → node publishes rate increase with createdAt in the past
  → assert rejected by temporal guard (>tolerance drift)
```

### 4. Identity Conformance

DID lifecycle rules. Tiers, capabilities, progressive access.

```
TestIdentity_Creation
  → create new DID with Ed25519 keypair
  → assert DID format matches did:imajin:<base58>
  → assert genesis operation on DFOS chain
  → assert starter balance of 100 MJN

TestIdentity_SoftDID
  → create identity via event ticket purchase (no keypair)
  → assert DID created with soft tier
  → assert cannot sign operations
  → assert cannot initiate settlements
  → assert CAN receive attestations

TestIdentity_ProgressiveTrust
  → soft DID upgrades by adding keypair
  → assert tier changes to preliminary
  → assert can now sign operations

TestIdentity_KeyRotation
  → rotate key on established DID
  → assert new operations must use new key
  → assert old operations still verify with old key
  → assert old key cannot create new operations
```

### 5. Attestation Conformance

Attestation vocabulary and structural validation.

```
TestAttestation_KnownTypes
  → emit event.created attestation
  → assert accepted
  → assert stored on emitter's chain

TestAttestation_RequiredFields
  → emit ticket.purchased without transaction reference
  → assert rejected
  → assert error contains required field name

TestAttestation_BilateralRequired
  → emit connection.established with only one signature
  → assert rejected
  → assert error contains "bilateral attestation requires countersignature"

TestAttestation_BilateralAccepted
  → emit connection.established with both signatures
  → assert accepted
  → assert gas split between both parties

TestAttestation_ChainPlacement
  → emit attestation for DID A
  → assert attestation appears on DID A's chain
  → assert attestation referenceable by CID
```

### 6. Trust Conformance

Standing computation and trust graph rules.

```
TestTrust_InitialStanding
  → new DID with no attestations
  → assert standing == 0 (or base value)

TestTrust_StandingFromAttestations
  → DID with 5 attestations across 3 types from 4 unique counterparties
  → assert standing > 0
  → assert diversity component reflects 3 types
  → assert counterparty component reflects 4 unique DIDs

TestTrust_StandingDecay
  → DID with attestations all >1 year old, no recent activity
  → assert standing < equivalent DID with recent activity

TestTrust_SelfAttestationIgnored
  → DID attests to itself
  → assert attestation stored (valid chain entry)
  → assert standing NOT increased (self-attestation has zero trust weight)
```

### 7. Economic Conformance

MJN/MJNx balance management and credit lifecycle.

```
TestEconomic_CreditAccumulation
  → user makes 10 purchases totaling 1000 MJNx
  → assert MJN credit balance == sum of 0.25% of each transaction at conversion rate
  → assert each credit is a chain entry on user's DFOS chain

TestEconomic_CreditNoCap
  → user accumulates 10,000 MJN in credits
  → assert no rejection
  → assert balance reflects full accumulation

TestEconomic_GasDeduction
  → user with 100 MJN submits 50 operations at 0.1 MJN each
  → assert balance == 95 MJN

TestEconomic_ChainReplayConsistency
  → replay user's full DFOS chain
  → assert computed balance matches materialized balance
  → assert every credit and debit has a corresponding chain entry
```

---

## Suite Architecture

```
@imajin/node-conformance
├── tests/
│   ├── settlement/
│   │   ├── default-rates.test.ts
│   │   ├── bounds.test.ts
│   │   ├── zero-transaction.test.ts
│   │   └── fee-bearer.test.ts
│   ├── gas/
│   │   ├── charge.test.ts
│   │   ├── integrity.test.ts
│   │   ├── balance.test.ts
│   │   └── starter.test.ts
│   ├── rate-change/
│   │   ├── decrease.test.ts
│   │   ├── increase-notice.test.ts
│   │   └── schedule.test.ts
│   ├── identity/
│   │   ├── creation.test.ts
│   │   ├── tiers.test.ts
│   │   └── rotation.test.ts
│   ├── attestation/
│   │   ├── vocabulary.test.ts
│   │   ├── bilateral.test.ts
│   │   └── structure.test.ts
│   ├── trust/
│   │   ├── standing.test.ts
│   │   └── decay.test.ts
│   └── economic/
│       ├── credit.test.ts
│       ├── gas-deduction.test.ts
│       └── chain-replay.test.ts
├── fixtures/
│   ├── keypairs.json
│   ├── rate-schedules.json
│   └── chain-snapshots.json
└── runner.ts
```

### Running Conformance

```bash
# Test a node
npx @imajin/node-conformance https://your-node.example.com

# Test specific category
npx @imajin/node-conformance https://your-node.example.com --suite settlement

# Certification mode (generates signed report)
npx @imajin/node-conformance https://your-node.example.com --certify
```

### Certification

- Tests are open source. Anyone can run them.
- **Certification** is the commercial product: Imajin runs the suite against your production node, signs the result as an attestation on the registry chain, and your node displays a compliance badge.
- Certification has an expiry. Nodes must re-certify periodically (annually or on major protocol version changes).
- Certification is itself an attestation — verifiable by anyone, stored on chain.

---

## Sequencing

| Phase | Categories | When |
|-------|-----------|------|
| 1 | Identity + Settlement + Attestation | Pre-launch (minimum viable network) |
| 2 | Gas + Rate Change + Economic | Post-launch (when gas goes live) |
| 3 | Trust | When standing computation ships |
| 4 | Userspace App (via RFC-19/20) | When third-party apps register |

## Open Questions

1. **Test count target for Phase 1?** DFOS has 86+ tests. Aiming for similar density? Or start minimal and grow?
2. **Negative tests vs positive tests ratio?** The "reject bad input" tests are arguably more important than "accept good input" — they define the boundaries.
3. **Cross-node consistency tests?** Two nodes process the same transaction — do they arrive at the same state? Requires multi-node test harness.
4. **Versioning:** When rules change (e.g., fee bounds adjusted by governance), the test suite must version. Old nodes passing old tests ≠ current compliance.

## References

- RFC-20: Application Conformance Suite (chain-type projectors)
- RFC-19: Kernel/Userspace Architecture (app compliance)
- DFOS 0.6.0 conformance suite (protocol layer)
- Fee Model v2 draft (`docs/rfcs/drafts/fee-model-v2.md`)

---

*"The tests are the rules. If it's not in a test, it's not a rule. If it passes the tests, it's compliant."*
