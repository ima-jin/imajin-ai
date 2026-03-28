## STATUS: RESOLVED
**Adopted:** 2026-03-17
**Resolved:** 2026-03-27 (audit against upstream HEAD `1d943e0`)
**Evidence:** `docs/rfcs/RFC-11-embedded-wallet.md` in upstream main. RFC-11 is a direct expansion of this proposal. Ed25519 convergence confirmed as three-way fact (Imajin DID + Solana wallet + DFOS chain) in RFC-11 and whitepaper v0.4. Hierarchical key derivation model and gas subsidization mechanics all incorporated.
**Outcome:** Core architecture confirmed: DID keypair IS the wallet (same Ed25519 keypair, no external wallet app). Scope: MJN only. Child keys for spending/delegation/app sessions. Foundation gas pool covers Solana tx fees. All design principles from this proposal adopted. RFC-19 extends with delegated session tokens for app-level key scoping.
**Implementation:** RFC-11 Draft — spec fully adopted. Wallet functionality implementation depends on MJN Foundation formation.

---

## 4. Embedded Wallet — DID Keypair as MJN-Scoped Solana Wallet

**Author:** Ryan Veteze and Jin (discovered architecturally, March 9, 2026)
**Related upstream:** #268 (Embedded Wallet), MJN whitepaper v0.2
**Addresses:** Outstanding Concerns: .fair attribution integrity (on-chain anchoring), Social graph portability (key rotation model)

### The Discovery

Imajin chose Ed25519 for DID keypairs because it was the right primitive for sovereign identity. Solana uses Ed25519 for wallet addresses. On March 9, 2026, during a conversation about whether users would need external wallet apps for MJN, the realization: **they already have wallets**. Every DID keypair is a valid Solana keypair. Every backup file already contains a wallet private key. Every registered identity — ~25 hard DIDs, ~48 soft DIDs at that time — is one derivation away from holding MJN tokens.

Nobody planned this. The architecture planned itself.

### Design Principles

**MJN-Scoped Only**
The embedded wallet transacts MJN tokens only. Not general-purpose Solana. Not SPL tokens. Not DeFi. A settlement instrument, not a trading platform. A compromised key can only affect the MJN balance — no bridge exploits, no DeFi drainage. Blast radius is structurally contained.

**Identity IS the Wallet**
Registration generates a keypair → DID + wallet address in one step. No external wallet app required. Client-side signing — private key never touches the server.

**Gas Subsidization**
Solana transactions cost ~$0.001. The MJN Foundation operates a gas pool that covers transaction fees for MJN settlements. Users never think about SOL or gas.

### Hierarchical Key Derivation

The master DID keypair is the root identity. Child keys are derived for scoped purposes:

| Key | Scope | Revocable | Example |
|-----|-------|-----------|---------|
| Master | Full identity + wallet | No (IS the identity) | `did:imajin:ryan` |
| Spending | Daily transactions, capped balance | Yes, by master | `did:imajin:ryan/spending` |
| Savings | Long-term holdings, cold | Yes, by master | `did:imajin:ryan/savings` |
| Delegation | Agent/service can spend within limits | Yes, by master | `did:imajin:ryan/delegate/jin` |
| App Session | Scoped to one service, time-limited | Yes, by master or expiry | `did:imajin:ryan/session/events` |

### Per-Primitive Wallet Behavior

| Identity Type | Wallet Governance |
|---------------|------------------|
| Individual | Personal hierarchy (spending, savings, delegation). Full autonomy. |
| Family | Shared treasury — multi-sig between family member DIDs. Allowance keys for dependents. |
| Cultural | Quorum-signed treasury — governed by trust-weighted membership. Contribution payouts follow .fair governance weights. No single member can unilaterally move funds. |
| Org | Corporate spending authority with delegation hierarchy. Employee expense keys with per-transaction limits. Founder can revoke any delegated key. |

### Settlement Integration

**.fair → On-Chain Settlement**
When a .fair manifest triggers a payment:
1. Consumer's spending key signs the transaction
2. Transaction splits per .fair contributor shares
3. Each contributor's wallet receives their share directly
4. Settlement is atomic — all splits execute or none do
5. The .fair manifest hash is recorded on-chain as provenance

**Trust-Gated Inference Payments**
When someone queries a presence through the trust graph:
1. Querier's spending key signs inference fee
2. Fee routes to knowledge leader's wallet
3. If the leader is part of a Cultural DID, the fee splits per governance weight
4. All on-chain, all auditable, all following the identity graph

### Implementation Phases

**Phase 1 — Surface the Wallet:** Derive Solana address from existing DID keypair. Display wallet address and MJN balance on profile. No transactions — just visibility.

**Phase 2 — Receive MJN:** Wallet can receive MJN tokens. Balance display in pay service. Transaction history.

**Phase 3 — On-Chain Settlement:** Client-side transaction signing in pay service. .fair settlements execute on Solana. Gas subsidized by Foundation pool. Spending key derivation.

**Phase 4 — Hierarchical Keys:** Key derivation UI. Per-primitive governance (Family multi-sig, Cultural quorum, Org delegation). Revocation and rotation. Optional export to external wallets.

### Key Rotation (Social Recovery)

If a master key is compromised, the trust graph provides social recovery:
1. N trusted connections attest to a new keypair
2. Attestations carry the weight of the attesting DIDs
3. Once threshold is met, the new keypair inherits the DID
4. Old key is revoked network-wide
5. MJN balance transfers to new wallet address

### Dependencies

- MJN token on Solana mainnet (exists: `12rXuUVzC71zoLrqVa3JYGRiXkKrezQLXB7gKkfq9AjK`)
- Pay service pluggable backend architecture (exists)
- Ed25519 keypair generation (exists: `@imajin/auth`)
- Trust graph for social recovery (exists: connections service)
- .fair attribution manifests (exists: `@imajin/fair`)

### Open Questions

- Key derivation scheme — BIP-44 style paths or custom derivation?
- Soft DIDs — do `did:email:` soft DIDs get wallet addresses? Probably not until upgrade to preliminary DID.
- Multi-device — spending key on phone, master key in cold storage. UX?
- Regulatory — does an embedded wallet trigger money transmitter requirements?
- Gas pool economics — how is the Foundation gas pool funded?
- Social recovery threshold — how many attestations, at what trust weight, to rotate a master key?
- Child key limits — how are spending caps enforced? On-chain program or client-side?

### Roadmap Placement — 2026-03-13

Assigned to **Phase 3** in the Settlement & Economics Hardening Roadmap:
- Embedded wallet surface: Derive Solana address from DID keypair, show balance on profile (`apps/profile/`)
- On-chain .fair settlement: Client-side signing, atomic .fair splits on Solana via existing `apps/pay/lib/providers/solana.ts`
- Gas subsidization: Foundation pool covering SOL transaction fees for MJN settlements

**Current state from Settlement Roadmap:** The Solana provider in `apps/pay/lib/providers/solana.ts` is "Scaffolded — SOL/SPL transfers, unsigned tx returned for client signing." The pluggable `PaymentProvider` interface is live. The wallet IS built at the infrastructure level — the gap is the UI surface and the wiring.

**Connection to Proposal 19 (Solana/Imajin Overlap):** Pathway 2 in Proposal 19 (Solana wallet → preliminary DID) depends on exactly this infrastructure. Proposal 4's Phase 3 work is what surfaces that wallet to users post-registration.

---

