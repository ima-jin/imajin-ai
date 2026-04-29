---
title: Emissions Model — .fair-Driven MJN Emissions
type: rfc
status: draft
date: 'April 7, 2026'
slug: emissions-model
topics:
  - settlement
  - fair
refs:
  rfcs:
    - 1
  issues:
    - 433
    - 461
    - 641
---
# Emissions Model — .fair-Driven MJN Emissions

**Version:** 1
**Status:** Draft
**Date:** April 7, 2026
**Related:** Fee Model v3, RFC-01 (.fair Attribution), #433 (Virtual MJN), #461 (Attestation Coverage)

---

## Summary

MJN emissions are defined by `.fair` specs attached to attestation types. When an attestation fires, the `.fair` on that attestation type defines who earns MJN and how much. Gas burns MJN, attestations emit MJN. The `.fair` cascade controls the rates.

**One sentence:** Attribution and emission are the same thing.

## The Loop

```
Action → Gas burn → Attestation → .fair lookup → MJN emission → Chain entry
```

1. **User performs an action** (register, buy ticket, send message, create event)
2. **Gas is burned** (MJN debit to the node — cost of compute)
3. **Attestation fires** (proves the action happened — signed, bilateral, on-chain)
4. **`.fair` spec is resolved** (cascade: root → identity → record snapshot)
5. **MJN is emitted** to parties defined in the `.fair` (credited to their balance)
6. **Chain entry records it** (the attestation + .fair snapshot = mint proof)

Gas and emissions are two sides of the same coin. Gas is the cost. Emission is the reward. The `.fair` spec defines the reward schedule. The attestation is the trigger.

## .fair Cascade for Emissions

The same three-layer cascade from RFC-01 applies:

| Layer | Location | Controls | Example |
|-------|----------|----------|---------|
| **Root .fair** | `/.fair` (git-versioned, protocol-level) | Default emission schedule for all attestation types | `identity.created → 100 MJN to subject` |
| **Identity .fair** | Per-scope/forest config | Scope-level overrides | Mooi emits 200 MJN to new members |
| **Record .fair** | Snapshot at attestation time | Immutable proof of rates active when the attestation fired | Frozen into the chain entry |

Resolution order: record .fair (if exists) → identity .fair → root .fair.

The **record .fair** is critical — it's the snapshot that proves what rate was in effect at the moment of emission. When you replay the chain to mint tokens, you don't look up current rates. You read the record .fair that was frozen into the attestation.

## Emission Schedule (Root .fair)

```yaml
# /.fair/emissions.yaml (root — protocol defaults)

emissions:
  # === Identity lifecycle (tiered verification) ===
  # Total for fully verified identity: 210 MJN ($2.10)
  identity.created:
    gas: 0
    emit:
      - to: subject
        amount: 10
        unit: MJN
        reason: "Soft DID — welcome to the network"

  identity.verified.preliminary:
    gas: 0
    emit:
      - to: subject
        amount: 100
        unit: MJN
        reason: "Preliminary verification — email confirmed"

  identity.verified.hard:
    gas: 0
    emit:
      - to: subject
        amount: 100
        unit: MJN
        reason: "Hard verification — full identity confirmed"

  # === Connections ===
  connection.accepted:
    gas: 0.001
    emit:
      - to: subject       # person who accepted
        amount: 1
        unit: MJN
      - to: issuer         # person who invited
        amount: 1
        unit: MJN

  vouch:
    gas: 0.001
    emit:
      - to: subject        # person vouched for
        amount: 2
        unit: MJN

  # === Commerce ===
  ticket.purchased:
    gas: 0.01
    emit:
      - to: subject        # buyer
        amount: 0.25%      # of settlement value
        unit: MJN
      - to: issuer         # seller/host
        amount: 0.25%
        unit: MJN

  listing.purchased:
    gas: 0.01
    emit:
      - to: subject        # buyer
        amount: 0.25%
        unit: MJN
      - to: issuer         # seller
        amount: 0.25%
        unit: MJN

  tip.received:
    gas: 0.001
    emit:
      - to: issuer         # tipper (rewarded for generosity)
        amount: 1
        unit: MJN
      - to: subject        # creator
        amount: 0.5%
        unit: MJN

  # === Content & Creation ===
  event.created:
    gas: 0.01
    emit:
      - to: issuer         # event creator
        amount: 5
        unit: MJN

  handle.claimed:
    gas: 0.01
    emit:
      - to: subject
        amount: 2
        unit: MJN

  # === Groups & Scoping ===
  group.created:
    gas: 0.01
    emit:
      - to: issuer         # forest creator
        amount: 10
        unit: MJN

  scope.onboard:
    gas: 0.001
    emit:
      - to: subject        # new member
        amount: 5
        unit: MJN
      - to: scope          # community treasury
        amount: 1
        unit: MJN
```

### Emission Types

**Fixed amount:** `amount: 100` — flat MJN credit regardless of transaction value. Used for lifecycle events (signup, connection, handle claim).

**Percentage:** `amount: 0.25%` — percentage of settlement value. Used for commerce. This is the same buyer/seller credit from fee-model v3 — but now it's defined in .fair, not hardcoded in the settlement route.

### Emission Targets

| Target | Resolves to |
|--------|-------------|
| `subject` | `subject_did` on the attestation |
| `issuer` | `issuer_did` on the attestation |
| `scope` | Active scope DID (from `X-Acting-As` or forest context) |
| `node` | Node operator DID |

## MJN Valuation (Pre-Token)

| Property | Value |
|----------|-------|
| **1 MJN** | **0.01 CHF (≈1¢ USD/CAD)** |
| 100 MJN | 1 MJNx (1 CHF) |
| Signup (soft DID) | 10 MJN = $0.10 |
| Preliminary verified | +100 MJN = $1.00 |
| Hard verified | +100 MJN = $1.00 |
| **Fully verified total** | **210 MJN = $2.10** |
| Gas per operation | 0.001 MJN = $0.001 |
| 10 MJN covers | ~10,000 gas operations |

Post-token launch, MJN floats at market rate. The pre-token peg is a utility definition: **1 MJN = the cost of one unit of platform compute.** This grounds the token in real resource consumption rather than speculation.

## How It Connects to Fee Model v3

The fee model's "buyer credit" (0.25%) becomes an emission defined in .fair:

**Before (fee-model v3):** buyer credit is a hardcoded 0.25% in the settlement code.

**After (emissions model):** buyer credit is a `.fair` emission on `ticket.purchased` / `listing.purchased`. The settlement route reads the .fair spec, not a hardcoded rate.

This means:
- Scopes can override emission rates (Mooi gives 1% back to buyers instead of 0.25%)
- New attestation types automatically become emission points (just add to .fair)
- The settlement route becomes simpler — it handles fiat, the attestation handler handles MJN

## Implementation Path

### Phase 1: DB-backed emissions (Mooi MVP)
- Add emission schedule as a config file (`.fair/emissions.yaml` or JSON in root .fair)
- After `emitAttestation()` succeeds, look up emission schedule for that type
- Credit `pay.balances.credit_amount` for each emission target
- Log `pay.transactions` entry with `{ type: 'emission', reason: attestation_type }`
- `identity.created` → 100 MJN on signup (covers #641)

### Phase 2: .fair cascade
- Root .fair in git, identity .fair in `forest_config`, record .fair snapshot on each attestation
- Scope-level emission overrides
- Emission rate governance (same rules as fee model: decreases instant, increases 24h notice)

### Phase 3: Chain-native (DFOS)
- Emission entries appended to subject's DFOS chain
- Record .fair frozen into the chain entry
- Chain replay = total MJN balance = mint proof
- DB becomes a cache, rebuildable from chains

### Phase 4: Token mint
- Solana contract reads DFOS chains
- Each emission entry + its record .fair = verified mint amount
- `verify_and_mint()` is permissionless — anyone can trigger it with chain proofs
- No trust required. The math is in the .fair, the proof is in the chain.

## Relationship to Gas

Gas and emissions are inverse flows of the same currency:

| | Gas | Emissions |
|---|---|---|
| Direction | User → Node | Protocol → User |
| Trigger | Any platform action | Attestation fires |
| Rate defined by | Node's published gas schedule | .fair spec (cascaded) |
| Recipient | Node operator (100%) | Varies per .fair (user, scope, node) |
| Chain entry | Gas debit on user's chain | Emission credit on recipient's chain |

**Net flow for active participants is positive.** A soft DID gets 10 MJN ($0.10) which covers 10,000 gas operations at 0.001 MJN per op. Preliminary verification adds 100 MJN ($1.00), hard adds another 100 MJN ($1.00). Every attestation emits new MJN. Active users accumulate, not deplete.

**Net flow for the network is inflationary** — bounded by real economic activity (attestations require signed actions from real participants). Sybil farming is uneconomical: creating 1000 identities costs gas on each, and the $100 settlement threshold for mint eligibility means fake accounts can't extract real value.

## Security Properties

- **Emissions can't be forged.** They reference a signed attestation CID. No attestation = no emission.
- **Rates can't be backdated.** The record .fair is frozen at attestation time. Historical rate changes don't affect past emissions.
- **Scope overrides are transparent.** Identity .fair is on-chain and auditable. A scope advertising 5% emission is verifiable.
- **Double-emission is prevented.** Each attestation has a unique CID. Emission handler is idempotent on attestation CID.

## Resolved Questions

1. **Emission caps:** No cap for now. Gas cost + attestation requirement + $100 settlement threshold for mint eligibility provides sufficient friction. May revisit once we see real data flow patterns.

2. **Scope emission funding:** Scope treasury. If a scope wants to give more than the protocol default (e.g., 200 MJN signup instead of 100), the extra comes from the scope's own MJN balance. Gift/transfer mechanism. The protocol does not subsidize and there is no dilution — scope funds its own generosity.

3. **MJN valuation (pre-token):** **1 MJN = 0.01 CHF (≈1¢).** Conversion: **100 MJN = 1 MJNx.** Grounded definition: 1 MJN = the minimum unit of compute (one gas operation). Post-token, MJN floats at market rate. This does not affect the Howey analysis — MJN is still earned through participation, never purchased. The peg makes gas costs legible, not speculative.

4. **Retroactive emissions:** Yes — backfill existing identities using tiered verification emissions (see below). Run as a script replaying existing identities through the emission handler after the engine is built.

## Open Questions

1. **Commerce emission rounding:** On small transactions, 0.25% of a $5 ticket = 0.0125 MJNx = 1.25 MJN. Round up or down? Floor is simpler, ceil is more generous.
2. **Scope treasury seeding:** When a forest is created, does the creator's MJN seed the treasury? Or does the treasury start at 0 and accumulate from `scope.onboard` emissions?

---

*Gas burns. Attestations prove. .fair defines. Chains record. Tokens mint.*
