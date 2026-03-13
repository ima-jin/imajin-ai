## STATUS: RESOLVED
**Resolved:** 2026-03-13
**Evidence:** Settlement & Economics Hardening Roadmap (March 13) — Phase 2 "Distribution Contracts"; Ryan explicitly cites Greg's analysis for key decisions
**Outcome:** All major positions adopted in the Settlement Roadmap Phase 2:
- Q4 (Circular distributions): "max depth 5 hops, reject circular chains" ✅ adopted exactly
- Q7 (Graceful degradation): `on_failure` per allocation, `overflow` as default ✅ adopted
- Q1 (Minimum viable distribution): `overflow` accumulates locally ✅ adopted
- Q3 (Contract versioning): version at initiation governs ✅ adopted
- Package: new `packages/distribution/` (separate from pay/fair) ✅ adopted
Ryan notes "needs issue" — no upstream issue yet, but Phase 2 is the committed plan. Distribution contracts are the first production use case proposed for disbursing Supporter Pool returns (Proposal 20).
**Implementation:** Roadmap commitment — issue to be created. Depends on Settlement Phase 1 (signed manifests, #316/#317).

---

## 16. Programmable Distribution Contracts — ADR-002

**Author:** Ryan Veteze (RFC + Bounty, open for community input)
**Date:** March 2026 (committed in `e079b80`)
**Source:** `apps/www/articles/rfc-02-distribution-contracts.md`
**Status upstream:** Open for discussion — destined to become `ADR-002: Distribution Contract Protocol`
**Related upstream:** RFC-01 (attribution), RFC-05 (intent-bearing transactions)
**Connects to:** Proposal 6 (.fair signing), Proposal 15 (attribution from commits)

### The Idea (rfc-02-distribution-contracts.md:12–16)

> *"Every sovereign presence on imajin can declare a distribution contract — a programmable, editable declaration of where incoming value flows the moment it arrives... The distribution logic is part of your sovereign presence. It's who you are, encoded. It runs automatically, every time, without you having to remember."*

The primitive is generalised from the WeR1 codebase (rfc-02-distribution-contracts.md:22–28): *"When a mix is played, every contributor to every track in that mix gets automatically compensated. The split logic runs at the moment of the transaction. No intermediary. No manual accounting. No forgotten payments."* — now extended from music to everything.

### The Schema (rfc-02-distribution-contracts.md:36–79)

```json
{
  "profile_did": "did:imajin:abc123",
  "version": 3,
  "effective_at": "2026-03-01T10:00:00Z",
  "allocations": [
    { "label": "infrastructure", "recipient": "did:imajin:node-operator", "percentage": 15 },
    { "label": "wer1-protocol",  "recipient": "did:imajin:wer1",          "percentage": 5  },
    { "label": "rainforest",     "recipient": "did:imajin:rainforest",     "percentage": 10 },
    { "label": "mortgage",       "recipient": "did:imajin:my-bank-account","percentage": 40 },
    { "label": "retained",       "recipient": "did:imajin:abc123",         "percentage": 30 }
  ],
  "overflow": "retained",
  "minimum_transaction": 0.001,
  "currency": "multi",
  "signature": "..."
}
```

**Four non-negotiable properties** (rfc-02-distribution-contracts.md:82–85):
- **Versioned** — every change creates a new version; full history preserved
- **effective_at** — no retroactive changes; the record is honest about when intent was declared
- **overflow** — rounding errors and sub-minimum transactions accumulate before routing (not lost)
- **signed** — Ed25519 by the DID; nobody can alter your distribution logic without your keys

**Note:** The `signature` field is already in Ryan's schema. This RFC has already resolved the signing question that P3 flags for `.fair` manifests — within its own schema. The `.fair` manifest itself still lacks the field.

### The Micro-Founder Layer (rfc-02-distribution-contracts.md:91–112)

Financial contributors are logged as micro-founders in the `.fair` attribution chain with a structured record including `type: "financial_contribution"`, `contributor_did`, `amount`, `currency`, `contributed_at`, and `weight: null` (to be resolved by the same weighting mechanism as code contributions). Early contributions carry more weight because *"the network was smaller and the risk was higher when they showed up"* (rfc-02-distribution-contracts.md:108). The "I Need Help" essay (`essay-26`) is cited as the mint event — the moment the micro-founder layer opens to the public.

### The Auditable Values Layer (rfc-02-distribution-contracts.md:118–124)

Because contracts are signed, versioned, and readable, aggregate queries become possible: total value flowed to environmental causes this month; percentage of inference fees directed to food security; node operators allocating most to community infrastructure. *"These aren't marketing claims. They're readable facts in the ledger. The network's values become legible in aggregate."*

### Greg's Position on the Seven Open Questions (rfc-02-distribution-contracts.md:130–149)

**Q1 — Minimum viable distribution** (rfc-02-distribution-contracts.md:130–131):
The `overflow` field and `minimum_transaction` threshold already address this architecturally. The implementation question is: does the overflow accumulate locally (in the profile wallet) or in a protocol-level micro-payment batching layer? Greg's position: local accumulation is simpler and consistent with sovereignty. The overflow accumulates in the profile's retained balance and routes when the next transaction above `minimum_transaction` clears.

**Q2 — Recipient types without imajin DIDs** (rfc-02-distribution-contracts.md:133–134):
Legacy financial bridge (Stripe Connect) is the right first target. The adapter pattern from the syndication bounty applies: each payment rail is an adapter registered with the distribution contract execution engine. Recipients without DIDs are addressed by `did:external:{stripe_account_id}` or equivalent bridge DID format. Greg's position: a bridge DID namespace for external accounts, with the adapter layer handling the actual payment routing.

**Q3 — Contract versioning and disputes** (rfc-02-distribution-contracts.md:136–137):
`effective_at` already specifies the governing version per transaction. What needs explicit handling: (a) transactions initiated before `effective_at` but settled after; (b) batch settlements spanning a version change. Greg's position: the version in effect at the moment of transaction initiation governs, not settlement. Settlement batch should lock the distribution contract version at batch creation time.

**Q4 — Circular distributions** (rfc-02-distribution-contracts.md:139–140):
Cycle detection is required before execution. A→B→C→A creates an infinite loop in a naive execution engine. Greg's position: depth-first cycle detection before routing; maximum routing depth of 5 hops as a protocol constant; circular chains are rejected with a specific error code (not silently failed).

**Q5 — Tax and legal** (rfc-02-distribution-contracts.md:142–143):
Each routing decision should emit a structured log record with: source DID, destination DID, amount, currency, contract version, allocation label, timestamp. This is the data a tax authority would need. Greg's position: the audit log is a byproduct of the execution engine — not a separate reporting system. Every routing decision is a signed record (consistent with the Cryptographic Trust Layer proposal).

**Q6 — WeR1 integration boundary** (rfc-02-distribution-contracts.md:145–146):
This requires a direct conversation with the WeR1 team. Until that happens, the safest architectural position is: WeR1 handles distribution logic for audio specifically; imajin's distribution contract handles everything else and calls WeR1's execution logic as an adapter where audio is the asset type. Greg's position: WeR1's primitive should be wrapped as an adapter in Tier 3 of the bounty scope — not merged into the core contract schema.

**Q7 — Graceful degradation** (rfc-02-distribution-contracts.md:148–149):
The contract should declare an `on_failure` field per allocation: `hold` (transaction waits), `overflow` (reroutes to overflow), or `fail` (entire transaction fails). Greg's position: `overflow` as the protocol default for unreachable recipient DIDs; `fail` as an option for allocations the sender considers non-negotiable (e.g., covenant-required distributions).

### New Code-Level Gap Identified

The distribution contract schema has a `signature` field in the RFC. No `DistributionContract` type exists anywhere in the current codebase — not in `@imajin/fair`, not in `@imajin/pay`, not in `apps/pay/`. The contract schema and execution engine are entirely absent. This is not a bug (P-list) — it is a missing feature. But it has a dependency: the `signature` field requires the same `@imajin/auth` signing utilities proposed in Proposals 7/8, which also don't exist yet. **The distribution contract cannot be implemented before Phase 1 of the attestation layer is live.**

### Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Does the distribution contract live in `@imajin/pay`, `@imajin/fair`, or a new `@imajin/distribution` package? | Service ownership and dependency structure | New `@imajin/distribution` package — distribution is a distinct concern from payment processing or attribution formatting |
| Is the WeR1 integration boundary a blocker for MVP, or can distribution contracts launch without audio settlement? | Timeline dependency on external team | Launch without audio settlement; WeR1 adapter is Tier 3 of the bounty scope |
| Should the micro-founder layer (financial contributions as attribution) be part of the distribution contract package or RFC-01 attribution? | Attribution ledger ownership | RFC-01 attribution — financial contributions are the same primitive as code contributions, weighted differently |
| `effective_at` governs which version applies — what is the dispute resolution mechanism when `effective_at` is contested? | Legal and operational risk | Sign and timestamp every version change; the signed record is the evidence |

**Detecting resolution in the repo:**
- New TypeScript types for `DistributionContract` in `@imajin/fair`, `@imajin/pay`, or a new package
- Distribution contract execution endpoint in `apps/pay/` or new `apps/distribution/`
- Signed audit log for every routing decision
- `ADR-002` document in `docs/decisions/`

### Roadmap Placement — 2026-03-13

Assigned to **Phase 3** in Ryan's .fair Hardening Roadmap. Ryan noted this "needs issue" — no upstream issue exists yet. Suggested home: new `packages/distribution/` or extended `@imajin/fair`. Depends on Phase 1 signing and Phase 2 settlement working end-to-end first.

---

