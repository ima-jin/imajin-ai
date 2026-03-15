# RFC-12: RFC: MJN Token Economics — reserve-backed utility token with fiat bridge

**Status:** Draft
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/269

---

## Summary

MJN is a reserve-backed utility token that serves as the settlement currency for the Imajin protocol. Users can freely convert between fiat and MJN through the Foundation clearinghouse. The token starts at a fixed exchange rate and evolves to a managed float as network volume grows.

This is not a speculative asset. This is a settlement instrument that happens to live on Solana.

## Core Model

### Dual-Currency Network

Every transaction on the Imajin network can settle in **fiat OR MJN**. Nobody is forced into crypto. The network works either way.

| Rail | Mechanism | Fees | Settlement Speed |
|------|-----------|------|-----------------|
| **Fiat** | Stripe / e-transfer | 2.9% + 30¢ (Stripe) | 2-day payout |
| **MJN** | Solana on-chain | ~$0.001 (gas, subsidized) | Instant |

MJN is better — lower fees, instant settlement, atomic .fair splits — but not required. The user chooses. Over time, the economic advantage of MJN drives organic adoption.

### Mint/Burn Reserve Model

```
Fiat in  → Foundation mints MJN → user's wallet
MJN in   → Foundation burns MJN → fiat to user's bank
                    ↕
         Foundation holds fiat reserves
         backing outstanding MJN supply
```

- **Mint on deposit:** User sends fiat (Stripe or e-transfer), Foundation mints equivalent MJN to their embedded wallet
- **Burn on withdrawal:** User redeems MJN, Foundation burns tokens and sends fiat to their bank
- **Reserves are auditable:** Outstanding MJN supply always backed by fiat reserves held by the Foundation
- **No fractional reserve:** 1:1 backing. Every MJN in circulation has fiat behind it.

### Exchange Rate Strategy

**Phase 1 — Fixed rate (launch)**
- 1 MJN = fixed USD value (e.g., $0.01 or $0.10 — TBD)
- Maximum stability. Merchants know exactly what they're accepting.
- Settlement currency should be boring. This is intentionally boring.
- Foundation revenue: spread on mint/burn + transaction micro-fees

**Phase 2 — Managed float (maturity)**
- Foundation adjusts rate gradually based on network economics
- Not pegged, not wild — like a central bank managing currency
- Rate adjustments are published transparently
- Reflects real network utility, not speculation
- Transition happens when network volume makes price discovery meaningful

**The rule:** The rate never moves fast enough to matter for a single transaction. If you're buying coffee with MJN, you don't check the exchange rate first. That's the target.

## How MJN Enters Circulation

### Primary: Earned Through Participation
- **.fair royalties** — your creative work earns MJN when consumed
- **Inference fees** — your presence earns MJN when queried
- **Contribution rewards** — active participation in Cultural DIDs
- **Network rewards** — node operators earn for infrastructure

### Secondary: Fiat Top-Up
- Users buy MJN directly through pay.imajin.ai
- Stripe charges their card, Foundation mints MJN
- Familiar UX — like loading a transit card or buying game credits

### Tertiary: DEX Liquidity (future)
- Foundation seeds SOL/MJN pool on Jupiter/Raydium
- Only after sufficient circulation exists
- Provides an additional on/off ramp, not the primary one

## Where MJN Gets Spent

### On-Network Settlement
- **Event tickets** — pay in MJN for lower fees, instant confirmation
- **Inference queries** — trust-gated presence queries cost MJN
- **.fair settlements** — attribution chain splits execute on-chain
- **Course enrollment** — learn.imajin.ai accepts MJN
- **Tipping** — coffee.imajin.ai micropayments

### Participating Businesses (Org DIDs)
- Org DIDs in your trust graph accept MJN at their businesses
- Coffee shop, bookstore, service provider — real-world commerce
- Merchant receives MJN, cashes out to fiat whenever they want
- Lower fees than credit card processing (no Stripe 2.9%)
- Instant settlement (no 2-day wait)

### Declared-Intent Marketplace (#114)
- Users spend MJN balance to access declared-intent categories
- Businesses burn MJN gas to reach opted-in users
- Signal strength (intent + conversion history) determines gas cost
- The marketplace runs on MJN natively

## Foundation Clearinghouse Role

The MJN Foundation operates as a **protocol clearinghouse**, not a bank.

### What the Foundation Does
- Holds fiat reserves backing outstanding MJN supply
- Mints MJN on fiat deposit
- Burns MJN on fiat withdrawal
- Sets and publishes exchange rate
- Operates gas subsidy pool for transaction fees
- Publishes reserve audits (quarterly minimum)

### What the Foundation Does NOT Do
- Hold user funds (MJN is in user's sovereign wallet)
- Control who can transact (permissionless within protocol rules)
- Lend against reserves (no fractional reserve, ever)
- Speculate on MJN price
- Restrict fiat withdrawal (always redeemable)

### Revenue Model
- **Mint/burn spread** — small percentage on fiat ↔ MJN conversion
- **Transaction micro-fees** — fraction of a cent per on-chain settlement
- **Gas pool margin** — Foundation subsidizes gas but retains small margin
- Transparent, published, auditable

## Regulatory Position

### Swiss Foundation (FINMA)
- MJN Foundation is a Swiss Stiftung — FINMA has clear frameworks for utility tokens
- Reserve-backed + non-speculative + clearinghouse model = favorable classification
- Not a deposit-taking institution (user funds in sovereign wallets)
- Not a money transmitter (protocol clearinghouse with published rates)
- The MJN-scoped wallet decision helps here — general-purpose Solana wallet would trigger broader regulations

### Why This Model Works
- **Full reserve:** No fractional lending, no systemic risk
- **Redeemable:** Always convertible back to fiat at published rate
- **Transparent:** Supply, reserves, and rate are all auditable
- **Non-speculative:** Fixed rate at launch, managed float later — not a trading vehicle
- **Protocol-specific:** MJN settles Imajin protocol transactions, not general-purpose payments

## Token Supply Mechanics

### Current State
- Token: `12rXuUVzC71zoLrqVa3JYGRiXkKrezQLXB7gKkfq9AjK`
- Network: Solana Mainnet
- Supply: 0 (nothing minted)
- Mint authority: Ryan (transfers to Foundation)

### At Launch
- Foundation receives mint authority
- Initial mint for gas subsidy pool
- Fixed rate published
- Fiat bridge activated via pay.imajin.ai

### Growth
- Supply increases as fiat flows in (mint on deposit)
- Supply decreases as fiat flows out (burn on withdrawal)
- Net supply reflects the real economic value locked in the MJN network
- No arbitrary inflation, no emission schedule — supply follows demand

## Open Questions

1. **Fixed rate value** — $0.01? $0.10? $1.00? Lower = more tokens in circulation, feels like micropayments. Higher = fewer tokens, feels like real money.
2. **Managed float trigger** — what network volume or user count triggers the transition from fixed to managed?
3. **Reserve auditing** — self-published or third-party audit? Frequency?
4. **Multi-currency fiat** — USD only at launch, or CAD/EUR/GBP from the start?
5. **Withdrawal limits** — any minimum/maximum for fiat redemption?
6. **Tax implications** — how do users report MJN earnings? Is the fiat ↔ MJN conversion a taxable event?
7. **Foundation capitalization** — initial fiat reserves to seed the gas pool and mint/burn operations
8. **Merchant settlement** — do Org DIDs receive MJN and convert themselves, or can they opt for automatic fiat conversion?

## Dependencies

- MJN token on Solana mainnet (exists)
- Embedded wallet (Discussion #268)
- Pay service fiat rails (exists: Stripe, e-transfer)
- Foundation incorporation (planned: Q1 2026)
- .fair attribution for royalty settlement (exists)
- Declared-intent marketplace (#114) for gas economics
- Org DID (Discussion #253) for merchant participation

## References

- MJN Whitepaper v0.2: `docs/mjn-whitepaper.md`
- Discussion #268: Embedded Wallet
- Discussion #252: Cultural DID (quorum treasury)
- Discussion #253: Org DID (merchant participation)
- #114: Declared-Intent Marketplace
- #256: Sovereign Inference (inference fee settlement)

---

## MJN Foundation — Formation Roadmap

The Foundation is a Swiss Stiftung (non-profit foundation under Swiss Civil Code Art. 80-89). This is the same vehicle used by Ethereum, Solana, Cardano, and Polkadot. Switzerland has the clearest regulatory framework for protocol foundations with token economics.

### Step 1: Formation (~CHF 30-50K, 4-8 weeks)

- Draft foundation deed (Stiftungsurkunde) — purpose, governance, initial board
- Minimum endowment: CHF 50,000 (~$55K USD)
- Notarize the deed with a Swiss notary
- Register with the Commercial Registry (canton of Zug or Zurich)
- Appoint initial Foundation Board (minimum 1 member, typically 3)
- Requires at least one Swiss-resident board member (can be a service provider)

### Step 2: FINMA Token Classification (1-3 months)

- Submit formal token classification request to FINMA
- FINMA categorizes tokens as: **utility**, **payment**, or **asset**
- MJN target classification: **utility token** (settlement currency for a specific protocol)
- Arguments in our favor: reserve-backed, non-speculative, MJN-scoped, fixed rate at launch, clear protocol utility
- If classified as payment token: heavier regulation but still workable under Swiss framework
- Deliverable: formal no-action letter or classification ruling from FINMA

### Step 3: Operational Setup

- Open Swiss bank account for the Foundation (crypto-friendly banks: SEBA, Sygnum, Hypothekarbank Lenzburg)
- Appoint statutory auditor (required for supervised foundations)
- Establish AML/KYC procedures for the fiat bridge
- Transfer MJN mint authority from Ryan to Foundation
- Set up Foundation governance: board meetings, decision protocols, transparency requirements

### Cost Estimate

| Item | Cost (CHF) |
|------|------------|
| Legal setup (Swiss blockchain law firm) | 20,000 - 40,000 |
| Foundation endowment (minimum) | 50,000 |
| FINMA classification (legal fees) | 10,000 - 20,000 |
| Ongoing compliance + audit (annual) | 10,000 - 20,000 |
| Swiss-resident board member service (annual) | 5,000 - 10,000 |
| **Total to launch** | **~CHF 100,000 - 150,000 (~$110-165K USD)** |

### Recommended Law Firms (Blockchain Specialization)

- **MME** (Zurich/Zug) — represented Ethereum Foundation, deep FINMA experience
- **Lenz & Staehelin** (Zurich/Geneva) — largest Swiss firm, strong regulatory practice
- **Walder Wyss** (Zurich) — crypto and fintech specialization
- **LEXR** (Zurich) — startup-focused, more accessible pricing

### Corporate Structure

```
MJN Foundation (Swiss Stiftung)
├── Owns: protocol spec, token treasury, mint authority
├── Governs: RFC process, token economics, rate adjustments
├── Contracts: Imajin Inc. for protocol development
│
Imajin Inc. (Canadian corporation)
├── Operates: imajin.ai (reference implementation, first node)
├── Builds: platform services, SDK, developer tools
├── Ryan Veteze — founder
├── Revenue: settlement fees, mint/burn spread, gas pool margin
```

### Timeline

| Milestone | Target |
|-----------|--------|
| Engage Swiss law firm | Q2 2026 |
| Foundation deed drafted | Q2 2026 |
| FINMA classification submitted | Q2-Q3 2026 |
| Foundation registered | Q3 2026 |
| Mint authority transferred | Q3 2026 |
| Fiat bridge operational | Q3-Q4 2026 |

### Why Switzerland

- **FINMA has clear token frameworks** — utility, payment, and asset classifications are published and tested
- **Neutrality** — Foundation cannot be captured by US or Chinese regulatory pressure
- **Precedent** — Ethereum, Solana, Cardano, Polkadot all chose Swiss Stiftung for the same reasons
- **The name draws from Japanese, built by a Canadian, governed from Switzerland** — sovereign infrastructure has no nationality
