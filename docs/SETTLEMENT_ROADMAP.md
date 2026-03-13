# Settlement & Economics Hardening Roadmap

*Generated March 13, 2026 — cross-referencing Greg's proposals, open issues, and current code.*

---

## Current State

### What Exists — It's Actually Solid

**`apps/pay/`** — Universal settlement layer, already working:

| Component | Status | What It Does |
|-----------|--------|-------------|
| `pay.transactions` | ✅ Live | Full ledger: service, type, from/to DID, amount, status, source, `fair_manifest` JSONB |
| `pay.balances` | ✅ Live | Per-DID balances with cash/credit split |
| `pay.balance_rollups` | ✅ Schema | Daily aggregated stats per DID per service |
| `POST /api/checkout` | ✅ Live | Creates Stripe sessions, logs pending transactions |
| `POST /api/webhook` | ✅ Live | Handles `payment_intent.succeeded`, updates transactions |
| `POST /api/settle` | ✅ Live | Accepts .fair chain, atomically splits balances across DIDs |
| `GET /api/balance/:did` | ✅ Live | Balance queries |
| `POST /api/balance/topup` | ✅ Live | Top up from Stripe |
| `POST /api/balance/transfer` | ✅ Live | DID-to-DID transfers |
| `POST /api/balance/gift` | ✅ Live | Gift credits |
| `POST /api/escrow` | ✅ Live | Hold funds pending confirmation |
| `POST /api/charge` | ✅ Live | Direct charges |
| `GET /api/transactions/:did` | ✅ Live | Filtered transaction history |
| Stripe provider | ✅ Live | Payment Intents, checkout, escrow, subscriptions, refunds |
| Solana provider | ✅ Scaffolded | SOL/SPL transfers, unsigned tx returned for client signing |
| Pluggable provider interface | ✅ Live | `PaymentProvider` contract — Stripe + Solana implement it |

**Key insight:** The settlement engine (`/api/settle`) already does atomic .fair splits. It's not fancy — it accepts a chain of `{ did, amount, role }` and atomically debits sender / credits all recipients in a DB transaction. But it works. Three tickets have settled through it.

### What Does NOT Exist

- ❌ Events webhook → settle wiring (ticket purchase doesn't trigger .fair settlement)
- ❌ Platform fee calculation (no platform DID in .fair chains yet)
- ❌ Signed .fair verification at settlement (accepts any JSON — no crypto check)
- ❌ Coffee routing through pay (talks to Stripe directly)
- ❌ Balance UI on profile pages
- ❌ Daily rollup cron job
- ❌ Stripe Connect for multi-creator payouts
- ❌ Distribution contracts (programmable splits)
- ❌ Intent-bearing transactions (money with purpose)
- ❌ Contribution pools
- ❌ Embedded wallet / on-chain settlement
- ❌ Gas model for Stream 2
- ❌ Consent primitive at settlement

---

## The Gaps (Greg's Pressure Tests)

| Gap | Greg Proposal | Severity |
|-----|--------------|----------|
| **No .fair verification at settle** | Proposal 6 | Critical — settlement accepts unsigned manifests |
| **No platform fee in chain** | — | High — revenue not flowing |
| **No distribution contracts** | Proposal 16 | Medium — needed for automated splits beyond simple chains |
| **No intent field on transactions** | Proposal 17 | Medium — money doesn't carry purpose |
| **No consent verification** | Proposal 18 | Medium — settlement doesn't prove both parties agreed |
| **No frequency-scaled gas** | Proposal 11 | Low (pre-Stream 2) — but design needed now |
| **Embedded wallet is scaffolded, not wired** | Proposal 4 | Low (Year 3) — Solana provider exists but unused |

---

## Build Strategy: Four Phases

### Phase 0 — Wire What Exists *(no new infrastructure, just connect the dots)*

Everything needed is already built — it's just not connected. This is the "April 1" scope.

| Task | Location | Notes |
|------|----------|-------|
| Wire events webhook → `/api/settle` | `apps/events/` webhook handler | After ticket creation, call settle with .fair chain |
| Add platform DID to event .fair chains | `apps/events/` fair generation | Platform DID gets its share (3% default) |
| Platform fee as chain entry | `.fair` chain | `{ did: PLATFORM_DID, amount: X, role: "platform" }` — no special logic |
| Record `fair_manifest` on ticket transactions | `apps/events/` → `apps/pay/` | Already have the JSONB column, just not populating it |
| Balance UI on profile | `apps/profile/` | Show earnings/spending per DID |
| Daily rollup cron | `apps/pay/` | Aggregate `pay.transactions` → `pay.balance_rollups` |

**Platform fee model:**

| Service | Default Fee | Notes |
|---------|------------|-------|
| Events | 3% | Organizer gets 97%, platform 3% |
| Coffee | 0% initially | Creator keeps 100% until Stripe Connect ships |
| Learn | 3% | Instructor gets 97% |
| Inference | TBD | Depends on Stream 5 economics |

**Decision needed:** Platform fee percentage. Greg's proposals don't specify a number. 3% seems right — low enough to not be extractive, high enough to sustain infrastructure. Stripe takes ~2.9% + 30¢ on top of this.

---

### Phase 1 — Signed Settlement *(enforce .fair at the money boundary)*

This is where settlement gets teeth. Reject unsigned or invalid manifests.

**Depends on:** .fair Roadmap Phase 1 (#316 signing utilities, #317 manifest signing)

| Task | Location | Notes |
|------|----------|-------|
| Verify .fair signature before settlement | `apps/pay/api/settle/route.ts` | Call `verifyManifest()` — reject invalid |
| Log signature verification result on transaction | `pay.transactions.metadata` | Audit trail |
| Emit `transaction.settled` attestation | `apps/pay/` → `apps/auth/` | Proof of payment as signed attestation |
| Platform signature check | `apps/pay/` | Show ✅ verified / ⚠️ modified in transaction history |
| Stripe Connect for multi-creator payouts | `apps/pay/`, `apps/coffee/` | Real fund splitting — not just ledger entries (#142) |
| Route coffee through pay | `apps/coffee/` → `apps/pay/` | Stop talking to Stripe directly |

**Critical change to `/api/settle`:**

```typescript
// Current: accepts any JSON
if (!fair_manifest.chain || !Array.isArray(fair_manifest.chain)) {
  return 400;
}

// Phase 1: verify signature
const isValid = await verifyManifest(fair_manifest);
if (!isValid) {
  return NextResponse.json(
    { error: 'Invalid .fair manifest signature' },
    { status: 400 }
  );
}
```

---

### Phase 2 — Distribution Contracts *(programmable splits)*

Move from "each transaction specifies its split" to "each DID declares how incoming value flows."

**Greg proposals addressed:** Proposal 16 (Distribution Contracts)

| Task | Location | Notes |
|------|----------|-------|
| `DistributionContract` type | New `packages/distribution/` or extend `@imajin/fair` | Schema from RFC-02 |
| Contract creation + versioning | `apps/pay/` or new service | Signed, versioned, `effective_at` timestamped |
| Contract execution engine | `apps/pay/` | On settlement, apply recipient's distribution contract to split further |
| Cycle detection | Contract validation | DFS — max depth 5 hops, reject circular chains |
| `overflow` handling | Engine | Sub-minimum transactions accumulate, route when threshold met |
| `on_failure` per allocation | Contract schema | `hold` / `overflow` / `fail` per recipient |
| Micro-founder layer | Extend .fair / distribution | Financial contributions as attribution (RFC-02 §micro-founders) |

**Key decision from Greg's analysis:**

| Decision | Options | Greg's Position |
|----------|---------|----------------|
| Where does distribution contract live? | `@imajin/pay`, `@imajin/fair`, or new `@imajin/distribution` | New package — distinct concern |
| Settlement version: initiation or completion? | Which contract version governs | Version at initiation governs |
| Circular chain handling | Reject / cap depth | Reject with error; max 5 hops |

---

### Phase 3 — Advanced Economics *(intent, pools, gas, wallet)*

The full protocol-level economics layer.

**Greg proposals addressed:** Proposal 4 (Embedded Wallet), Proposal 11 (Gas Model), Proposal 17 (Intent + Pools)

| Task | Location | Notes |
|------|----------|-------|
| Intent-bearing transactions | Extend `FairManifest` + `apps/pay/` | `intent.purpose`, `intent.constraints` |
| Constraint enforcement (Phase 1: logged) | `apps/pay/` | Violations logged and auditable, no automatic consequences |
| Constraint enforcement (Phase 2: attestation-triggered) | When attestation layer live | Violations → `flag.yellow` attestations |
| Contribution pools | `apps/pay/` or new `apps/pools/` | Community-funded infrastructure with attributed rewards |
| Redistribution threshold | Pool governance | Anti-hoarding: mandatory distribution above cap |
| Frequency-scaled gas (Stream 2) | `apps/pay/` routing | Exponential cost for repeat messages to same DID |
| Cluster-aware gas | Attestation layer integration | Detect coordinated Org DID clusters sharing founding DID |
| Embedded wallet surface | `apps/profile/` | Derive Solana address from DID keypair, show balance |
| On-chain .fair settlement | `apps/pay/` Solana provider | Client-side signing, atomic .fair splits on Solana |
| Gas subsidization | Foundation pool | Cover SOL transaction fees for MJN settlements |

---

## Issue ↔ Proposal Cross-Reference

| Issue | Greg Proposal(s) | Phase | Status |
|-------|-----------------|-------|--------|
| **#141** — Pay settlement engine | Proposals 16, 17 | 0-1 | Open |
| **#113** — Revenue stream 1: settlement fees | — | 0 | Open |
| **#142** — Stripe Connect for payouts | — | 1 | Open |
| **#112** — Revenue streams (parent) | — | 0-3 | Open |
| **#114** — Stream 2: declared-intent marketplace | Proposal 11 (gas) | 3 | Open |
| **#115** — Stream 3: headless settlement | Proposal 18 (consent) | 3 | Open |
| **#116** — Stream 4: education settlement | — | 0-1 | Open |
| **#117** — Stream 5: trust graph queries | Proposals 1, 4, 11 | 3 | Open |
| **#111** — Inference cost flow | Proposals 4, 16 | 3 | Open |

### Issues That Need Creating

| What | Phase | Content |
|------|-------|---------|
| **Wire events → pay settle with .fair** | 0 | Connect the dots — ticket purchase triggers .fair settlement |
| **Platform fee in .fair chains** | 0 | Platform DID entry on all auto-generated manifests |
| **Signed .fair verification at settlement** | 1 | Reject unsigned manifests at `/api/settle` |

---

## Dependency Graph

```
Phase 0: Wire What Exists
    └── No blockers — ship now
    └── (benefits from .fair Phase 0 templates but not blocked)

Phase 1: Signed Settlement
    ├── Depends on: .fair Phase 1 (#316 + #317 — signing utilities + manifest signing)
    ├── Depends on: Identity Phase 1 (#320 — attestation layer for transaction.settled attestations)
    └── Can partially ship: Stripe Connect (#142) has no crypto dependency

Phase 2: Distribution Contracts
    ├── Depends on: Phase 1 (settlement verifies signatures)
    └── Depends on: .fair Phase 1 (signed manifests)

Phase 3: Advanced Economics
    ├── Depends on: Phase 2 (distribution contracts for automated routing)
    ├── Depends on: Identity Phase 2 (attestation layer for gas/flag enforcement)
    └── Depends on: Embedded Wallet (#268) for on-chain settlement
```

---

## How the Three Roadmaps Connect

```
                        #316: @imajin/auth signing
                       /           |            \
                      /            |             \
        .fair Phase 1    Identity Phase 1    Settlement Phase 1
       (sign manifests)  (attestations)     (verify at settle)
              |                |                    |
        .fair Phase 2    Identity Phase 2    Settlement Phase 2
       (settlement)    (progressive trust) (distribution contracts)
              \                |                   /
               \               |                  /
                  Full Sovereign Economics
              (signed .fair + standing-gated +
               programmable distribution +
               intent-bearing transactions)
```

**The convergence point:** All three roadmaps meet at "signed .fair manifests verified at settlement, with attestation-backed trust gating." That's the protocol.

---

## What's Unique About Settlement

Unlike .fair and identity, **settlement already works.** The `/api/settle` endpoint does atomic multi-party splits. Three tickets have settled through it. The schema is solid.

The gap isn't "build settlement" — it's:
1. **Connect it** (Phase 0 — wire events → settle)
2. **Harden it** (Phase 1 — verify signatures)
3. **Extend it** (Phase 2-3 — distribution contracts, intent, gas)

This is the most shippable of the three tracks. Phase 0 could land in a day.

---

*This document lives alongside `docs/FAIR_ROADMAP.md` and `docs/IDENTITY_ROADMAP.md`. Together they cover the three foundational systems Greg's proposals pressure-test.*
