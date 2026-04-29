---
title: >-
  Embedded Wallet — DID keypair as MJN-scoped Solana wallet with hierarchical
  key derivation
type: rfc
status: draft
slug: RFC-11-embedded-wallet
topics:
  - identity
  - settlement
refs:
  issues:
    - 256
    - 257
    - 252
    - 253
    - 255
  packages:
    - '@imajin/auth'
    - '@imajin/fair'
---
# RFC-11: RFC: Embedded Wallet — DID keypair as MJN-scoped Solana wallet with hierarchical key derivation

**Status:** Draft
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/268

---

## The Realization

We did not design a wallet. We discovered one.

Imajin chose Ed25519 for DID keypairs because it was the right cryptographic primitive for sovereign identity. Solana uses Ed25519 for wallet addresses. The choice was made for identity, not settlement. Solana's use of Ed25519 was already a fact of the world — but nobody was thinking about wallets when the first keypair was generated.

On March 9, 2026, during a conversation about whether users would need to connect external wallet apps to trade MJN, we realized: they already have wallets. Every DID keypair generated at registration is a valid Solana keypair. Every backup file already contains a wallet private key. Every registered identity — ~25 hard DIDs, ~48 soft DIDs — is one derivation away from holding MJN tokens.

Nobody planned this. The architecture planned itself. When you build from the right primitives — sovereign keypairs, typed identity, trust graphs, embedded attribution — the late decisions make themselves. The settlement layer was already inside the identity layer, waiting to be noticed.

This is what happens when the architecture is honest.

---

## Summary

Every Imajin DID keypair (Ed25519) is already a valid Solana keypair. This RFC proposes making that explicit: every identity is a wallet by default, scoped to MJN token settlement, with hierarchical key derivation for purpose-scoped child keys.

## Design Principles

### MJN-Scoped Only
The embedded wallet transacts MJN tokens only. Not general-purpose Solana. Not SPL tokens. Not DeFi. This is a settlement instrument, not a trading platform.

**Security consequence:** A compromised key can only affect the MJN balance in that wallet. No bridge exploits, no token approvals, no DeFi drainage. The blast radius is structurally contained.

**And it gets safer with scope.** Generate child keys for different purposes — a spending key, a delegation key, an app session key. Each one is revocable by the master. Compromise one and the damage is limited to that key's scope. This is the opposite of general-purpose wallets where one leaked seed phrase means everything is gone.

### Identity IS the Wallet
- Registration generates a keypair → DID + wallet address in one step
- The backup file already contains the private key
- No external wallet app required
- Client-side signing — private key never touches the server

### Gas Subsidization
Solana transactions cost ~$0.001. The MJN Foundation operates a gas pool that covers transaction fees for MJN settlements. Users never think about SOL or gas.

## Hierarchical Key Derivation

The master DID keypair is the root identity. Child keys are derived for scoped purposes:

### Key Types

| Key | Scope | Revocable | Example |
|-----|-------|-----------|---------|
| **Master** | Full identity + wallet | No (IS the identity) | `did:imajin:ryan` |
| **Spending** | Daily transactions, capped balance | Yes, by master | `did:imajin:ryan/spending` |
| **Savings** | Long-term holdings, cold | Yes, by master | `did:imajin:ryan/savings` |
| **Delegation** | Agent/service can spend within limits | Yes, by master | `did:imajin:ryan/delegate/jin` |
| **App Session** | Scoped to one service, time-limited | Yes, by master or expiry | `did:imajin:ryan/session/events` |

### Per-Primitive Wallet Behavior

The wallet capability exists on every identity primitive, but governance follows the identity type:

**Individual**
- Personal wallet hierarchy (spending, savings, delegation)
- Full autonomy — the individual controls all derived keys
- Lose a spending key → revoke from master, generate new one, identity survives

**Family**
- Shared treasury — multi-sig between family member DIDs
- Allowance keys for dependents (spending caps, category restrictions)
- Custodial authority for minor family members
- Emergency access patterns for healthcare/legal scenarios

**Cultural**
- Quorum-signed treasury — governed by trust-weighted membership
- Contribution payouts follow .fair governance weights
- No single member can unilaterally move funds (structural anti-capture)
- Payout proposals require quorum attestation before settlement executes

**Org**
- Corporate spending authority with delegation hierarchy
- Employee expense keys with per-transaction and per-period limits
- Departmental budget keys
- Founder can revoke any delegated key

## Settlement Integration

### .fair → On-Chain Settlement
When a .fair manifest triggers a payment:
1. Consumer's spending key signs the transaction
2. Transaction splits per .fair contributor shares
3. Each contributor's wallet receives their share directly
4. Settlement is atomic — all splits execute or none do
5. The .fair manifest hash is recorded on-chain as provenance

### Trust-Gated Inference Payments
When someone queries a presence through the trust graph:
1. Querier's spending key signs inference fee
2. Fee routes to knowledge leader's wallet
3. If the leader is part of a Cultural DID, the fee splits per governance weight
4. All on-chain, all auditable, all following the identity graph

## Implementation Phases

### Phase 1: Surface the Wallet
- Derive Solana address from existing DID keypair
- Display wallet address and MJN balance on profile
- No transactions yet — just visibility
- Update backup file to note wallet address

### Phase 2: Receive MJN
- Wallet can receive MJN tokens
- Balance display in pay service
- Transaction history view

### Phase 3: On-Chain Settlement
- Client-side transaction signing in pay service
- .fair settlements execute on Solana
- Gas subsidized by Foundation pool
- Spending key derivation for daily transactions

### Phase 4: Hierarchical Keys
- Key derivation UI — generate spending/savings/delegation keys
- Per-primitive governance (Family multi-sig, Cultural quorum, Org delegation)
- Revocation and rotation
- Optional export to external wallets (Phantom, Solflare) for users who want it

## Security Model

### Blast Radius Containment
| Scenario | General Wallet | MJN-Scoped Wallet |
|----------|---------------|-------------------|
| Key compromised | All tokens, NFTs, approvals, DeFi positions | MJN balance only |
| With child keys | N/A | Only the scope of that child key |
| Revocation | Impossible (seed phrase) | Parent DID revokes child key |
| Social recovery | None (unless set up externally) | Trust graph can attest to identity for key rotation |

### Key Rotation
If a master key is compromised, the trust graph provides social recovery:
- N trusted connections attest to a new keypair
- Attestations carry the weight of the attesting DIDs
- Once threshold is met, the new keypair inherits the DID
- Old key is revoked network-wide
- MJN balance transfers to new wallet address

## Open Questions

1. **Key derivation scheme** — BIP-44 style paths or custom derivation? HD wallet standards exist but are Bitcoin/Ethereum-centric.
2. **Soft DIDs** — do `did:email:` soft DIDs get wallet addresses? Probably not until upgrade to hard DID.
3. **Multi-device** — spending key on phone, master key in cold storage. How does the UX work?
4. **Regulatory** — does an embedded wallet trigger money transmitter requirements? MJN-scoped + Foundation-governed may help.
5. **Gas pool economics** — how is the Foundation gas pool funded? Token allocation? Transaction micro-fees?
6. **Social recovery threshold** — how many attestations, at what trust weight, to rotate a master key?
7. **Child key limits** — how are spending caps enforced? On-chain program or client-side?

## Dependencies

- MJN token on Solana mainnet (exists: `12rXuUVzC71zoLrqVa3JYGRiXkKrezQLXB7gKkfq9AjK`)
- Pay service pluggable backend architecture (exists)
- Ed25519 keypair generation (exists: `@imajin/auth`)"
- Trust graph for social recovery (exists: connections service)
- .fair attribution manifests (exists: `@imajin/fair`)"

## References

- MJN Whitepaper v0.2: `docs/mjn-whitepaper.md`
- #256: Sovereign Inference (inference fee settlement)
- #257: Profile Secrets Vault (encrypted key storage)
- Discussion #252: Cultural DID (quorum treasury governance)
- Discussion #253: Org DID (delegated spending authority)
- Discussion #255: Sovereign User Data (portable wallet state)
