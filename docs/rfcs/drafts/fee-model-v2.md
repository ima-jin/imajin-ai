# Fee Model v2 — Three-Party Settlement Fees

**Status:** DRAFT
**Date:** March 29, 2026
**Supersedes:** Original 1% split model (0.4% node / 0.4% protocol / 0.2% user credit), RFC-12 exchange rate strategy (USD → CHF peg)
**Related:** P31 (Fee Governance), RFC-12 (MJN Token Economics), FAQ dual-token model

---

## Summary

Settlement fees are composed of three independent, bounded, configurable rates:

| Participant | Range | Default | Set by |
|-------------|-------|---------|--------|
| Protocol | 0.25% – 2% | 1.0% | Governance (Foundation → trust graph) |
| Node | 0.25% – 2% | 0.5% | Node operator |
| User credit | 0.25% – 2% | 0.25% | Node operator (from gross, not node margin) |

**Default total fee:** 1.75%
**Maximum total fee:** 6% (theoretical; market competition prevents this)
**Minimum total fee:** 0.75% (0.25% × 3)

## How It Works

On a **$100 transaction** at default rates:

| Line item | Amount | Recipient |
|-----------|--------|-----------|
| Protocol fee | $1.00 | Protocol treasury |
| Node fee | $0.50 | Node operator |
| User credit | $0.25 | Buyer (as virtual MJN credit) |
| **Seller receives** | **$98.25** | |
| **Total fee** | **$1.75** | |

The buyer pays $100, the seller receives $98.25, and the buyer accumulates $0.25 in MJN credit on their DFOS chain.

## Why Three-Party

**Protocol fee is the floor.** Non-negotiable revenue to fund protocol development, managed by governance within structural bounds. This is the number in the pitch: "1%."

**Node fee is market-driven.** Node operators compete on margin. A node charging 0.25% attracts more traffic than one charging 2%. Federation creates a competitive market for settlement infrastructure — this is the economic incentive to run a node.

**User credit is an accumulation incentive.** Every transaction plants seeds. Credits are chain entries on the user's DFOS chain. At token launch, chain replay = mint proof. The more you transact, the more MJN you hold before the token exists.

## Governance

Only the **protocol fee** is governance-controlled:
- Set by Foundation board initially, transitioning to trust-graph-weighted voting
- Bounded: 0.25% floor (starvation prevention), 2% ceiling (capture prevention)
- Adjustments are chain-recorded attestations — auditable by any participant
- Annual review cycle, emergency proposal with supermajority

**Node fee** and **user credit rate** are set by node operators:
- Bounded by the same 0.25% – 2% range (enforced by protocol)
- Nodes advertise their rates — users choose which node to transact through
- Market competition is the governance mechanism for node fees

## Fee Enforcement

The **protocol fee** is enforced at the settlement layer:
- Solana contract holds the protocol rate (or reads from governance state)
- Settlement transactions must include the protocol fee transfer
- Non-compliant settlements are rejected

**Node fee** and **user credit** are enforced by the node software:
- Kernel validates that node fee + user credit are within bounds
- Compliance suite verifies correct fee accounting
- Nodes that don't comply fail conformance testing

## Comparison to Original Model

| | Original (1% split) | v2 (Three-party) |
|---|---|---|
| Total fee | 1.0% | 1.75% (default) |
| Protocol revenue on $1M volume | $4,000 | $10,000 |
| Node incentive | $4,000 (fixed) | Market-driven |
| User benefit | $2,000 (fixed) | Node-configurable |
| Competitiveness vs Stripe (2.9%+30¢) | Very competitive | Still competitive |
| Node competition | None (fixed rate) | Rate competition |
| Governance complexity | All three rates | Protocol rate only |

## Comparison to Alternatives

| Platform | Fee |
|----------|-----|
| Stripe | 2.9% + 30¢ |
| PayPal | 3.49% + 49¢ |
| Square | 2.6% + 10¢ |
| Shopify Payments | 2.4% – 2.9% + 30¢ |
| **Imajin (default)** | **1.75%** |
| **Imajin (minimum)** | **0.75%** |

## Gas Fees

Non-economic chain operations (attestation writes, identity updates, chain appends) are metered by gas.

| Property | Value |
|----------|-------|
| Default rate | 1¢ per operation |
| Recipient | 100% to node |
| Bounds | TBD (governance-set range) |
| Rate changes | Same asymmetric rule: decreases instant, increases require 24h notice |

Gas is the node's base revenue for compute. Protocol does not take a cut — settlement fees fund the protocol, gas funds the node. This separation avoids double-dipping and encourages maximum chain activity (more chain entries = richer trust graph = more mint proofs at token launch).

**Storage:** Materialized Postgres table in the relay (`gas_balances`), updated on each operation. DFOS chain is the source of truth — table is a working index, rebuildable from chain replay. Migration path: Postgres now → optional Solana settlement when MJN token launches (Year 3+). No external dependencies for basic network operations.

**Open:** Gas rate governance model (central bounds + node discretion, annual vote, or threshold-triggered review). Candidate for Greg's analysis.

### Gas Integrity Model

Gas charges cannot be forged or inflated. The trust chain:

1. **User signs their operation** ("write this attestation")
2. **Relay countersigns the gas charge** ("I processed this, charged 1¢")
3. **Gas charge entry references:** operation CID + relay DID + rate + timestamp
4. **Rate schedule is itself a signed chain entry** — the relay's published rates are on-chain with timestamps

**Why bogus fees can't be inserted:**

- **Relay can't charge without a user operation.** The gas charge references a user-signed operation CID. No operation = no valid charge.
- **User can't be overcharged silently.** User's client compares the charge against the relay's published rate schedule. Discrepancy = flagged.
- **Peering relays can audit.** During replication, other relays verify that gas charges match the originating relay's rate schedule at time of operation.
- **Rates can't be backdated.** Rate schedule changes are chain entries with timestamps. A relay can't retroactively claim a higher rate was in effect.
- **Same bilateral pattern as attestations.** Neither party can unilaterally fabricate a record. The relay can't charge you without your signed operation, and you can't use the relay without accepting its published rate.

## Fee Obligations

The party initiating the economic action bears the fee:

| Action | Fee bearer | Fee type |
|--------|-----------|----------|
| Selling an item | Seller | Settlement |
| Purchasing a ticket | Event organizer (on sale) | Settlement |
| Sending a tip | Recipient | Settlement |
| Creating an attestation | Initiator | Gas |
| Identity operation | DID owner | Gas |
| $0 transactions | N/A — no fee | Attestation only (no credit) |

## Rate Change Rules

- **Decreases** take effect immediately
- **Increases** require 24h notification period before taking effect
- **No frequency limit** — nodes can change rates as often as they like
- Node rates are advertised via the registry for discoverability

## Revenue Streams

Settlement fees are one revenue stream. The full model:

### Protocol-Level (scales with network)

| Stream | Mechanism | When |
|--------|-----------|------|
| Settlement fees | 1% of all economic transactions | Day 1 |
| Registry fees | App registration, compliance certification, annual renewal | Post-launch |
| Handle fees | `@name` claims, premium/vanity handles | Post-launch |

### Studio-Level (open-core model)

| Stream | Mechanism | When |
|--------|-----------|------|
| Vertical app licensing | Events, market, coffee etc. as white-label deployable apps | Year 1 |
| Professional services | Setup, customization, integration for orgs deploying Imajin | Year 1 |
| Platform licensing | Full kernel licensed to organizations running their own instance | Year 1–2 |
| Managed hosting | "Run your own node, we operate it" — node-as-a-service | Year 1–2 |

### Ecosystem-Level (longer term)

| Stream | Mechanism | When |
|--------|-----------|------|
| App marketplace cut | Third-party userspace apps registered via kernel | Year 2+ |
| Compliance certification | Apps pay to certify against conformance suite | Year 2+ |
| Premium support | SLA-backed support for commercial node operators | Year 2+ |

### MJN Token (Year 3+)

| Stream | Mechanism | When |
|--------|-----------|------|
| Protocol treasury | Foundation holds MJN | Post-mint |
| Node staking/bonding | Nodes stake MJN for priority or reputation | Post-mint |

**Key insight:** The 1% protocol fee does not need to fund the company alone. Studio revenue (licensing, services, managed hosting) is the primary Year 1 revenue driver. The ag contact (via Debbie's brother) is a licensing/services play, not a protocol fee play. Settlement fees are the long-term scalable layer; studio operations are the near-term economic engine.

## Dual-Token Model

Supersedes RFC-12 exchange rate strategy. See also: FAQ ("What's the difference between MJN and MJNx?")

### MJN — Equity / Governance

| Property | Value |
|----------|-------|
| Type | Equity, governance, long-term alignment |
| How you get it | Earned through usage — never purchased directly |
| Chain | DFOS (virtual, pre-launch) → Solana (Year 3) |
| Gas | Priced in MJN (0.1 MJN per operation, governance-adjustable) |
| User credit | Settlement credit accumulates as MJN |
| Starter balance | 100 MJN on account creation |
| Convertible | MJN ↔ MJNx at current rate |

### MJNx — Stable Unit / Commerce

| Property | Value |
|----------|-------|
| Type | Utility, payment, daily commerce |
| Peg | **1 MJNx = 1 CHF** (Swiss Franc) |
| How you get it | Fiat deposit, commerce revenue |
| Chain | Off-chain (database) |
| Settlement | All platform commerce prices in MJNx |
| Convertible | MJNx ↔ fiat at 1:1 CHF; MJNx ↔ MJN at current rate |

### Why CHF

- Most historically stable fiat currency. Neutral, low inflation.
- Not USD — sovereignty-first protocol shouldn't tether to the Fed.
- Regulatory signal — Switzerland is the crypto-friendly jurisdiction (Ethereum Foundation, Solana Foundation, etc.)
- Practically stable against USD/EUR/CAD day-to-day.

### Conversion Rates

| Direction | Pre-token | Post-token |
|-----------|-----------|------------|
| Fiat → MJNx | 1:1 (CHF deposit) | 1:1 (CHF deposit) |
| MJNx → Fiat | 1:1 (CHF withdrawal) | 1:1 (CHF withdrawal) |
| MJNx → MJN | Founding supporter ratio (20:1 / 25:1 / 30:1) | Market rate |
| MJN → MJNx | Inverse of supporter ratio | Market rate |

### How It Flows

A $25 CAD event ticket (≈18.50 CHF at current rates):

1. Buyer pays $25 CAD via Stripe
2. Platform records 18.50 MJNx settlement
3. Settlement fees (at defaults):
   - 0.185 MJNx → protocol (1%)
   - 0.0925 MJNx → node (0.5%)
   - 0.04625 MJNx → buyer as **~1.16 MJN** credit (0.25%, converted at 25:1)
4. Seller receives 17.18 MJNx (withdrawable as CHF → local currency)
5. Buyer's 1.16 MJN funds future gas ops and becomes a mint proof at token launch

**The protocol only speaks MJN internally.** Fiat translation is always at the edges. Users see local currency prices; the settlement engine records MJNx; governance and gas operate in MJN.

## Open Questions

1. **Gas rate governance:** What mechanism governs the gas rate bounds? Central authority sets range + annual/quarterly vote? Threshold-triggered review? Market-only with caps? (Candidate for Tonalith analysis.)
2. **Gas rate bounds:** What's the floor/ceiling for gas? 0.1¢ – 10¢? Needs modeling against expected operation volumes.
3. **Fee enforcement location:** Protocol fee in Solana contract (immutable) vs. kernel code (upgradeable)? Same question from P31, still open.
4. **Notification mechanism for rate increases:** How does the 24h notice period work technically? Chain announcement? Registry update with timestamp?

## Resolved

- ✅ **Fee bearer:** Seller / action initiator absorbs the fee from gross
- ✅ **Credit accumulation:** No cap
- ✅ **Rate visibility:** Nodes advertise rates via registry
- ✅ **Rate changes:** Unlimited frequency. Decreases instant, increases 24h notice
- ✅ **$0 transactions:** No fee, no credit entry. Attestation only.

---

*Draft for discussion. Will become an RFC once model is confirmed.*
