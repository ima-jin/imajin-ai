# RFC + Bounty: Programmable Distribution Contracts

**Category:** RFC / Architecture / Bounty  
**Status:** Open for discussion  
**Related:** [RFC: .fair Attribution from Commit History](#) *(link when live)*  
**Attribution:** Financial contributors to this bounty are logged in the .fair chain. When the network generates value, the chain pays back.

---

## The Idea

Every sovereign presence on imajin can declare a distribution contract — a programmable, editable declaration of where incoming value flows the moment it arrives.

Not a donation button. Not a separate charitable giving app. Not a platform taking a cut and occasionally sending you a check.

The distribution logic is part of your sovereign presence. It's who you are, encoded. It runs automatically, every time, without you having to remember.

---

## Why This Exists

The WeR1 codebase — built by Geordie Rose's team in Johannesburg — already solved a version of this problem for DJ mixes. When a mix is played, every contributor to every track in that mix gets automatically compensated. The split logic runs at the moment of the transaction. No intermediary. No manual accounting. No forgotten payments.

imajin extends that primitive from music to everything.

Inference fees. Micro-transactions. Syndication revenue. Financial contributions from micro-founders. Royalties from content that travels through the trust graph. All of it hits the distribution contract. All of it routes instantly according to the owner's declared intent.

The distribution contract is the WeR1 primitive, generalized.

---

## What a Distribution Contract Looks Like

A draft data model — open for debate:

```json
{
  "profile_did": "did:imajin:abc123",
  "version": 3,
  "updated_at": "2026-03-01T10:00:00Z",
  "effective_at": "2026-03-01T10:00:00Z",
  "allocations": [
    {
      "label": "infrastructure",
      "recipient": "did:imajin:imajin-node-operator",
      "percentage": 15,
      "note": "Node hosting and maintenance"
    },
    {
      "label": "wer1-protocol",
      "recipient": "did:imajin:wer1",
      "percentage": 5,
      "note": "Distribution primitive attribution"
    },
    {
      "label": "rainforest",
      "recipient": "did:imajin:rainforest-foundation",
      "percentage": 10,
      "note": "Environmental contribution"
    },
    {
      "label": "mortgage",
      "recipient": "did:imajin:my-bank-account",
      "percentage": 40,
      "note": "Living expenses"
    },
    {
      "label": "retained",
      "recipient": "did:imajin:abc123",
      "percentage": 30,
      "note": "Held in profile wallet"
    }
  ],
  "overflow": "retained",
  "minimum_transaction": 0.001,
  "currency": "multi",
  "signature": "..."
}
```

Key properties:
- **Versioned** — every change is a new version, old versions preserved. The chain shows your full history of declared values.
- **effective_at** — changes don't apply retroactively. You declared this at this moment. The record is honest.
- **overflow** — where rounding errors and sub-minimum transactions accumulate before routing.
- **signed** — the contract is signed by your DID. Nobody can alter your distribution logic without your keys.

---

## The Micro-Founder Layer

Financial contributors to imajin — people who show up via Buy Me A Coffee, direct transfer, or eventually native imajin payments — are logged as micro-founders in the .fair attribution chain.

Their entry looks like this:

```json
{
  "type": "financial_contribution",
  "contributor_did": "did:imajin:...",
  "github": "optional-handle",
  "amount": 50.00,
  "currency": "USD",
  "contributed_at": "2026-03-15T09:00:00Z",
  "weight": null,
  "note": "Early contributor, pre-launch"
}
```

Weight is calculated the same way code contributions are weighted — with early contributions carrying more weight because the network was smaller and the risk was higher when they showed up.

When the network starts generating value, the attribution chain routes back to micro-founders the same way it routes to code contributors and content creators. Not equity. Not a loan. A stake in the chain, proportional to contribution, that pays forward as value flows.

The "I Need Help" essay is the mint event — the moment the micro-founder layer opens to the public.

---

## The Auditable Values Layer

Because every distribution contract is signed, versioned, and readable, the network can answer questions it has never been able to answer before:

- How much value has flowed to environmental causes through imajin this month?
- What percentage of inference fees are being directed to food security organizations?
- Which node operators are allocating the most to community infrastructure?

These aren't marketing claims. They're readable facts in the ledger. The network's values become legible in aggregate — not as a mission statement, but as the actual sum of what its participants declared and followed through on.

---

## Open Questions

**1. Minimum viable distribution**
What's the smallest transaction worth routing? Sub-cent micro-payments need to batch before routing or they'll disappear in fees. How do we handle accumulation and threshold-based release without creating a centralized holding layer?

**2. Recipient types**
The current model assumes recipients have imajin DIDs. Most charities, banks, and services don't. What's the bridge layer for routing to legacy financial infrastructure? Stripe Connect? Direct bank transfer? Crypto? Probably all of the above — but the adapter pattern from the syndication bounty applies here too.

**3. Contract versioning and disputes**
If someone disputes a payment that routed under a previous version of your contract, which version governs? The one in effect at the time of the transaction (`effective_at`) seems right, but needs explicit handling.

**4. Circular distributions**
What happens when profile A routes 10% to profile B, and profile B routes 10% back to profile A? The system needs cycle detection or a maximum routing depth.

**5. Tax and legal**
Programmable value routing across jurisdictions creates real tax complexity. This isn't a reason not to build it — it's a reason to design the contract schema to emit the right reporting data. Every transaction should be auditable enough to satisfy a tax authority.

**6. WeR1 integration boundary**
The WeR1 codebase handles distribution logic for audio. Where exactly does the imajin distribution contract hand off to WeR1 primitives, and where does it extend them? This needs a conversation with the WeR1 team before the architecture locks.

**7. Graceful degradation**
If a recipient DID is unreachable, does the transaction hold, reroute to overflow, or fail? The contract should declare this explicitly.

---

## Scope for the Bounty

### Tier 1 — Contract Schema and Validation
- Finalize the distribution contract schema (TypeScript types, JSON Schema validation)
- Versioning and signature verification
- Conflict and cycle detection
- Test suite covering edge cases

### Tier 2 — Execution Engine
- Transaction arrives at node → contract resolves → routing instructions emitted
- Accumulation and threshold-based release for sub-minimum transactions
- Versioned execution — transactions route under the contract in effect at time of transaction
- Audit log: every routing decision is a signed record

### Tier 3 — Recipient Adapters
- imajin-to-imajin routing (native)
- Legacy financial bridge (Stripe Connect as first target)
- Crypto routing (second target)
- Charity/nonprofit adapter (public registry of verified recipients)

### Tier 4 — Aggregate Queries
- "How much has flowed to environmental causes this month?"
- "What's my total contribution to infrastructure costs?"
- Privacy-preserving aggregation — amounts visible at category level, not individual transaction level, unless the profile opts into full transparency

---

## How to Participate

Comment below with thinking on any open question. Draft proposals welcome as PRs against `/docs/decisions/`.

Financial contributions to this bounty are logged in the .fair chain. You don't have to write code to have a stake in what gets built.

When this discussion stabilizes it becomes `ADR-002: Distribution Contract Protocol`.

---

## Attribution Note

This bounty exists because of Geordie and the WeR1 team in Johannesburg, whose distribution codebase for DJ mixes contained the primitive this entire system extends. The WeR1 attribution entry is hardcoded into the distribution contract schema above — `"label": "wer1-protocol"` — because that's what honoring the chain looks like in practice.

---

*Part of building imajin.ai — sovereign infrastructure for identity, payments, and presence. The essays: [imajin.ai/articles](https://imajin.ai/articles)*
