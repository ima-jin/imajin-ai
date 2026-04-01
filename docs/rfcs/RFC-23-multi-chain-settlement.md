# RFC-23: Multi-Chain Settlement — Chain-Agnostic Payment Rails with Privacy Selection

**Status:** Draft
**Authors:** Ryan Veteze, Jin
**Created:** April 1, 2026
**Discussion:** TBD
**Supersedes:** RFC-04 (settlement protocol stub)
**Extends:** RFC-11 (embedded wallet), RFC-12 (MJN token economics)

---

## The Insight

Imajin chose Ed25519 for identity. Solana uses Ed25519 for wallets. That coincidence gave us embedded wallets for free (RFC-11). But Ed25519 is not Solana's property. Cardano uses Ed25519. Midnight uses Ed25519. The same keypair that is your DID, your Solana wallet, and your identity chain root is *also* a valid keypair on every Ed25519 chain in existence.

We didn't build a Solana app. We built a sovereign identity system that happens to be one derivation away from *every Ed25519 settlement chain simultaneously*.

On March 30, 2026, Charles Hoskinson launched Midnight — a $200M privacy-focused blockchain built on the thesis that public chains expose too much and private chains sacrifice verifiability. His selective disclosure model (prove claims without revealing data) is the same pattern as Imajin's attestation layer. His conclusion — that crypto failed mass adoption because of usability, not technology — is the same conclusion that drove Imajin's design.

The difference: Hoskinson built a chain. We built the application layer that doesn't care which chain settles the transaction.

This RFC proposes making that explicit.

---

## Summary

The Imajin settlement layer becomes chain-agnostic. One DID, one keypair, multiple settlement rails. The network selects the optimal rail per transaction based on the parties' preferences, privacy requirements, and cost. Users never choose a chain. They tap, pay, and the infrastructure routes.

## Design Principles

### 1. Identity Is the Root, Settlement Is a Leaf

The DID is the anchor. Settlement chains are interchangeable leaves hanging off the same identity tree. Your keypair derives wallet addresses on any Ed25519 chain. Your identity doesn't live on Solana or Cardano or Midnight — it lives on DFOS. The chains are just places where money moves.

```
            did:imajin:X (Ed25519 master key)
                        |
            ┌───────────┼───────────┐
            │           │           │
        Solana       Cardano    Midnight
        wallet       wallet     wallet
       (public)     (public)   (private)
            │           │           │
         MJN token   ADA/MJN    DUST/MJN
         settlement  settlement  settlement
```

### 2. The User Never Chooses a Chain

Chain selection is a routing decision, not a user decision. Like how email doesn't ask you which SMTP server to use.

The settlement router considers:
- **Privacy requirement** — does this transaction need selective disclosure? → Midnight
- **Speed requirement** — does this need instant finality? → Solana
- **Cost optimization** — which rail has the lowest fee right now?
- **Counterparty preference** — does the recipient have a preference?
- **Regulatory context** — does the jurisdiction require privacy or transparency?

Default: Solana (cheapest, fastest, existing infrastructure). Midnight when privacy is required or requested.

### 3. MJN Is the Unit of Account, Not the Chain

MJN tokens can exist on multiple chains simultaneously:
- **MJN on Solana** — SPL token, public, fast, cheap (current design)
- **MJN on Midnight** — shielded token, private transactions, selective disclosure
- **MJN on Cardano** — native token, access to Cardano DeFi ecosystem

Same value, same backing, same 1:1 fiat reserve (RFC-12). Different properties per chain. A cross-chain bridge (or the Foundation clearinghouse) handles movement between them.

The fiat rail (Stripe) remains the default for users who don't want to think about any of this.

### 4. Privacy as a Settlement Property, Not a Network Property

Current model: all transactions are public on Solana. Midnight's model: all transactions are private by default with selective disclosure.

Imajin's model: **privacy is per-transaction, not per-network.**

| Transaction Type | Default Rail | Privacy | Rationale |
|-----------------|-------------|---------|-----------|
| Event ticket purchase | Solana | Public | Price is public anyway, low stakes |
| Payroll settlement | Midnight | Private | Salary data is confidential |
| Marketplace purchase | Solana | Public | Normal commerce |
| Tip / donation | User choice | Either | Some want public support, some want anonymity |
| Medical service payment | Midnight | Private | Health data implications |
| Inter-business settlement | Midnight | Private | Competitive information |
| .fair royalty distribution | Solana | Public | Attribution is the point — transparency serves creators |

The `.fair` manifest records the attribution regardless of which rail settles. The chain is the plumbing. The manifest is the receipt.

## Architecture

### Settlement Router

New component in `@imajin/pay`:

```typescript
interface SettlementRequest {
  from: string;          // DID
  to: string;            // DID
  amount: number;        // in MJN or fiat
  currency: 'MJN' | 'USD' | 'CAD' | 'CHF';
  privacy: 'public' | 'private' | 'auto';
  fairManifest?: string; // CID of .fair manifest
}

interface SettlementResult {
  rail: 'solana' | 'cardano' | 'midnight' | 'stripe';
  txId: string;
  settled: boolean;
  fee: number;
  feeCurrency: string;
}

async function settle(request: SettlementRequest): Promise<SettlementResult> {
  const rail = await selectRail(request);
  return await executeOnRail(rail, request);
}
```

### Rail Selection Logic

```
privacy = 'private'     → Midnight (or fail if unavailable)
privacy = 'public'      → Solana (cheapest public rail)
privacy = 'auto'        → evaluate transaction type, amount, jurisdiction
currency = fiat          → Stripe (always, regardless of privacy)
```

### Key Derivation (extends RFC-11)

RFC-11 defined hierarchical key derivation for Solana. This extends the derivation tree:

```
Master Key (Ed25519, DID root)
├── m/44'/501'/0'    → Solana wallet (existing, RFC-11)
├── m/44'/1815'/0'   → Cardano wallet (CIP-1852)
├── m/44'/TBD'/0'    → Midnight wallet
└── m/imajin/0'      → Imajin-specific derivations
    ├── /0'          → spending key
    ├── /1'          → delegation key
    └── /2'          → app session keys
```

Same master key. Same backup file. Same recovery. The user backs up one thing and gets wallets on every chain.

### Cross-Chain MJN

MJN exists as a native asset on each chain:

| Chain | Token Standard | Properties |
|-------|---------------|------------|
| Solana | SPL Token | Public, fast (~400ms), ~$0.001 fee |
| Cardano | Native Token | Public, smart contracts, ~$0.20 fee |
| Midnight | Shielded Token | Private, selective disclosure, fee TBD |

**Movement between chains:**
- Foundation clearinghouse: burn on chain A → mint on chain B (centralized, instant, no slippage)
- Trustless bridge: lock on chain A → mint on chain B (decentralized, slower, requires bridge infrastructure)

Phase 1: Foundation clearinghouse only (simpler, auditable).
Phase 2: Trustless bridge when volume justifies the infrastructure.

### Selective Disclosure for Settlement

Midnight's selective disclosure maps directly to Imajin's attestation model:

**Current (Solana):** Transaction is public. Anyone can see Alice paid Bob 50 MJN.

**With Midnight:** Transaction is private. Alice can selectively prove:
- "I paid for this event ticket" (without revealing the amount)
- "I have sufficient balance" (without revealing the balance)
- "This payment is linked to attestation X" (without revealing the attestation details)

This is the same pattern as Imajin attestations — signed claims that prove something without revealing everything. Midnight makes it work at the settlement layer. We already make it work at the identity and trust layers.

## Integration with Existing RFCs

| RFC | Relationship |
|-----|-------------|
| RFC-04 | Superseded — this RFC is the settlement protocol |
| RFC-11 | Extended — key derivation tree grows, same master key |
| RFC-12 | Extended — MJN economics unchanged, fiat reserves back all chains equally |
| RFC-19 | Compatible — settlement is a kernel service, apps don't know which chain |
| RFC-22 | Compatible — federated auth works regardless of settlement rail |

## Implementation Phases

### Phase 0 — Current (Solana + Stripe)
What exists today. Fiat through Stripe, MJN on Solana. No changes needed.

### Phase 1 — Rail Abstraction
Refactor `@imajin/pay` to abstract the settlement rail behind the `settle()` interface. Current Solana + Stripe implementations become adapters. No new chains yet, but the architecture is ready.

### Phase 2 — Cardano Integration
Add Cardano adapter. Key derivation for Cardano wallets. MJN as Cardano native token. Foundation clearinghouse for cross-chain movement. Access to Cardano ecosystem (37M wallets from Midnight airdrop).

### Phase 3 — Midnight Integration
Add Midnight adapter. Privacy-preserving settlement. Selective disclosure for transactions. Auto-routing based on privacy requirements. This is the capability that unlocks enterprise use cases — payroll, healthcare, B2B settlement.

### Phase 4 — Automatic Rail Selection
Full settlement router. Transactions route automatically based on privacy, cost, speed, and counterparty preferences. The user never sees a chain name.

## Security Considerations

- **Blast radius is per-chain.** A compromised Solana key only affects the Solana wallet. Child keys are independently revocable (RFC-11).
- **Bridge risk is contained.** Foundation clearinghouse model means no trustless bridge exploits in Phase 1. Phase 2 bridges are opt-in.
- **Privacy is additive.** Adding Midnight doesn't reduce transparency on Solana. Transactions that should be public stay public.
- **Master key compromise is still catastrophic.** Same as RFC-11 — the backup/recovery story is unchanged and still the most critical user education challenge.

## Economic Impact

Adding settlement rails doesn't change the fee model (RFC-12, Fee Model v2):
- 1% protocol fee + 0.5% node fee + 0.25% user credit = 1.75% total
- Fees are denominated in the transaction currency, settled on whichever rail processes the transaction
- Gas costs vary by chain but are subsidized by the gas pool regardless

What changes: **the addressable market expands.** Privacy-requiring transactions (enterprise, healthcare, payroll, B2B) are currently blocked by Solana's full transparency. Midnight unblocks them. Cardano integration opens 37M existing wallets as potential users.

## The Pitch

> "Hoskinson spent $200M to build a privacy chain. We agree with his diagnosis — crypto is too public, too complex, too risky for mainstream use. But we're solving it from the other direction. We're not building a chain. We're building the application layer that routes through *any* chain. Your identity is sovereign. Your settlement is automatic. You never see a chain name. You just tap, pay, and it works."

---

## Dual-Token Convergence

Midnight launched with a dual-token model: NIGHT (governance/security) and DUST (transaction fees). This is the same structural separation as Imajin's MJN (equity/governance) and MJNx (stable settlement, CHF-pegged).

| | Midnight | Imajin |
|---|---|---|
| **Governance token** | NIGHT | MJN |
| **Utility token** | DUST (fees) | MJNx (settlement, CHF-pegged) |
| **Separation rationale** | Predictable tx costs, isolate speculation | Predictable settlement, isolate speculation |
| **Fee abstraction** | Apps cover DUST fees for users | Gas pool subsidizes, users never see gas |
| **User experience goal** | "Invisibility" — users don't know it's blockchain | Users tap, pay, chain is plumbing |
| **Selective disclosure** | ZK proofs at protocol layer | Attestation chains at identity layer |
| **Funding** | $200M self-funded | ~$80K bootstrapped |
| **Token distribution** | Airdrop to 37M wallets across 8 chains | Earned through real economic activity, milestone-gated mint |
| **Valuation at launch** | Briefly >$1B, currently ~$776M | Pre-token, virtual MJN accruing |

The design conclusions are identical. The approach is opposite. Hoskinson built from the protocol layer up — a new L1 with ZK privacy baked into the chain. Imajin built from the application layer down — real services (events, marketplace, chat, payments) with sovereign identity underneath, chain-agnostic settlement.

### Distribution: Airdrop vs Proof-of-Participation

Midnight distributed tokens to 37M wallets on day one. Wide reach, but value is given, not earned. The tokens represent nothing except having a wallet on one of eight chains.

Imajin's model: virtual MJN accrues through real economic activity — buying tickets, selling goods, tipping, creating content. Each credit is an entry on a DFOS chain. Replay the chain = calculate the balance. The milestone gate (10K active DIDs + $2.5M settlement volume) converts virtual to real. Every token at mint represents actual participation in a real economy.

Airdrop is spray-and-pray. Proof-of-participation is earned. The structural consequence: Imajin's token holders are *users of the network*, not speculators who happened to have a wallet.

### Why This Matters for Multi-Chain Settlement

If Imajin integrates Midnight as a settlement rail (Phase 3), the dual-token models are complementary:
- DUST handles Midnight transaction fees (or Imajin's gas pool covers them)
- MJN/MJNx handles the actual settlement value
- NIGHT governance is Midnight's concern, MJN governance is Imajin's concern
- No token conflict — they operate at different layers

The town doesn't compete with the highway. It uses it.

---

## Open Questions

1. **Midnight token standard** — details TBD pending Midnight documentation maturity
2. **Cardano key derivation path** — CIP-1852 is the standard, but need to verify Ed25519 compatibility with Imajin's specific key generation
3. **Cross-chain .fair manifests** — does the manifest reference the chain-specific txId, or a chain-agnostic settlement ID?
4. **Regulatory implications** — privacy-preserving settlement may trigger different compliance requirements per jurisdiction
5. **Foundation clearinghouse licensing** — operating cross-chain MJN movement may require money transmitter licensing depending on jurisdiction

---

*This RFC was catalyzed by the Midnight mainnet launch (March 30, 2026) and the observation that Imajin's Ed25519 identity layer is already chain-agnostic — we just hadn't made it explicit.*
