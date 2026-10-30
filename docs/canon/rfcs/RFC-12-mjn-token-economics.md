# RFC-12: MJN & MJNx — Settlement Units and the Reserved On-Chain Seat

**Status:** Current — reconciled with the #738 ruling (2026-09-04)
**Canon:** Settlement
**Tracked-in:** #2019 (reconciliation); originally triaged under #1852
**Reviewed:** 2026-09-15
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/269

---

## Summary

Two units, one ledger, provenance forever — ruled 2026-09-04 (#738 Decisions), shipped in the #2016 ledger split (#2159, merged 2026-09-10).

- **MJN** — receipt-backed money on the platform. Minted only against a signed rail receipt (Stripe today; e-Transfer, Lightning, Solana Pay/x402 as they land — #2013, #2014), burned against a payout receipt. Withdrawable.
- **MJNx** — the emitted platform unit. Earned by activity per a configured emission schedule (#2012, #2017), spendable in-platform, **not withdrawable**, never silently converted to MJN.
- **MJNx → MJN** is a reserved seat, not a mechanism this RFC builds: if/when a Stiftung and a real token exist, any relationship is computed from the signed ledger history already being kept (§1.3). No conversion promise, no rate, no date.

This RFC replaces the previous "MJN Token Economics" draft, which described MJN as a Solana-native reserve-backed token with a Foundation-run fiat bridge and peg. That model predates the 2026-09-04 ruling and doesn't match what ships today: MJN and MJNx are Postgres ledger rows (`pay.balances`, row-per-`(did, unit)`), not on-chain tokens. The Solana/Foundation material is retained in §5 as the shape a *future* on-chain bridge would take if the Stiftung seat is ever exercised — it is explicitly not committed, scheduled, or required for MJN/MJNx to work.

## 1. Core Model

### 1.1 MJN — receipt-backed, withdrawable

- **Mint:** only against an external-value receipt. Every rail mint has a receipt — no discretionary mint, no receipt-less MJN.
  - Live: Stripe Checkout (`topup`, `admin/deposits`), Interac e-Transfer (admin-confirmed).
  - Planned: Lightning (#2004), Solana Pay / x402 (#2013), EMT direct (#2014).
- **Burn:** on withdrawal, via a guarded conditional debit reserved *before* the payout rail is invoked (Stripe Transfer, EMT) — insufficient balance is a 402 and the payout is never attempted (#2166).
- **Fiat relationship:** MJN carries the fiat relationship of its receipt (e.g. a $50 CAD Stripe top-up mints 50 MJN tagged `currency: CAD`). There is no separate "MJN rate" to publish or manage — the receipt sets it.
- **Not a token today.** MJN lives as a `pay.balances` row keyed `(did, unit='MJN')` in the kernel's Postgres database. It is not minted on Solana or any chain.

### 1.2 MJNx — emitted, in-platform, non-withdrawable

- **Mint:** the bus's `mjn` reactor and the `/api/emission` route credit MJNx against a rule-based activity schedule (identity created, verified, connection, vouch, ticket purchase, etc.). The exact schedule and caps are governed by #2012, moving from hardcoded constants (`packages/bus/src/emissions.ts`) into signed `bus_chain_configs` rows (#2017) so every emission traces to a triggering attestation.
- **Spend:** in-platform only — event tickets, market listings, course enrollment, tips, declared-intent marketplace gas, and transfers to other DIDs (still MJNx on arrival).
- **Never withdrawable, never silently converted.** `/api/balance/withdraw` only ever debits MJN. `/api/balance/transfer` and `/api/settle` move a single unit per request — MJNx sent arrives as MJNx; an unknown or cross-unit request is a 400, never a conversion.
- **Peg language retired.** The old "1 MJNx = 1 CAD" (and the whitepaper's now-corrected "100 MJN = 1 MJNx" sub-unit framing) is gone. MJNx carries no fiat relationship at all — it has no rate to peg or manage.
- **Funded, not minted, outside the kernel.** Gift and event-topup credits (#2018) are transfers debited from the granting DID's own MJN and MJNx balances, atomically and with a guarded conditional debit — never a mint. Any entity outside the kernel that credits MJNx funds it.

### 1.3 The ledger invariant

For any balance, the ledger can always answer how much is backed (MJN) and how much is emitted (MJNx) — per-DID and in aggregate (`GET /pay/api/admin/reconciliation`, #2016 decision 4). This provenance is kept forever: every MJNx transaction carries `source_kind` (`emission` or `transfer`) and, where applicable, the triggering `attestation_id`; every MJN transaction carries `source_kind` (`receipt` or `transfer`). Nothing about §5 (the reserved seat) requires new bookkeeping — the history it would need is already the history #2016 keeps.

## 2. Settlement

`POST /api/settle` defaults to `unit: MJN` and validates the requested unit against `accepted_units` (default `[MJN]`) before touching any balance — an unaccepted unit is a 400, never a silent conversion. Externally-funded settlements (`funded: true`, e.g. Stripe) are hard-pinned to `unit: MJN`: there is no receipt for an externally-funded MJNx mint, so funded settlement in MJNx is not offered.

`POST /api/balance/transfer` moves a single unit (default MJN) between two DIDs; both legs of the transfer touch the same unit row, so cross-unit movement is impossible by construction.

## 3. What Changed From the Original Draft

The previous version of this RFC (reviewed 2026-09-03, prior to the ruling) described:

- MJN as a single reserve-backed Solana SPL token, mint/burn 1:1 against fiat reserves held by a Swiss Foundation clearinghouse.
- A fixed-then-managed-float exchange rate the Foundation would publish.
- No MJNx concept at all — "MJN" covered both the receipt-backed and the earned/emitted cases.

The audit behind #2016 found this was one of three inconsistent tellings of the model in the repo (alongside the whitepaper's "MJN as a cent sub-unit of MJNx" framing and the code's single fungible bucket with `'MJNx'` as an unused alias). Ryan's 2026-09-04 ruling (§1 above) is the one that ships. This RFC is rewritten to match it; nothing in §1–2 is aspirational — it describes `pay.balances`/`pay.transactions` as they exist after #2159 (merged 2026-09-10).

## 4. Where MJNx Is Spent

- **Event tickets, course enrollment, tipping, market listings** — in-platform MJNx spend.
- **Declared-intent marketplace (#114)** — gas priced in MJNx; still speculative, not built.
- **Org DID / merchant settlement** — an Org DID accepting MJNx from a customer receives an in-platform, non-withdrawable balance like anyone else; nothing here grants merchants a special MJNx→fiat conversion path. If merchants need fiat, the payer settles in MJN instead (§2).

## 5. Reserved Seat: MJNx → MJN On-Chain Bridge (no build, no date)

This section is retained from the original draft as a description of the *shape* a future on-chain bridge could take **if and when** the Stiftung and a real token exist — per the #738 epic, this is a reserved seat, not a roadmap item. None of it is required, scheduled, or promised by shipping MJN/MJNx today; it is here so the option isn't lost, and so nobody re-derives a Solana-token design without reading this first.

### 5.1 Why a seat, not a plan

The provenance §1.3 keeps means any future MJNx→MJN relationship — a token issued *against* the signed ledger, at whatever rate a Stiftung decides — can be computed retroactively from history. There is no need to build the bridge now, peg a rate now, or promise redemption now. Doing so before there is a Stiftung would be making a financial promise nobody has authorized.

### 5.2 If exercised: sketch of the mechanism

- A Swiss Stiftung (non-profit foundation, Swiss Civil Code Art. 80–89 — the vehicle used by the Ethereum, Solana, Cardano, and Polkadot foundations) would hold any mint authority for an on-chain MJN-equivalent token, not Imajin Inc.
- Any token issued would be issued *against* the DID-level MJNx provenance record kept per §1.3 — not promised inside it. The ledger doesn't owe anyone a token; a Stiftung decision would create one, informed by the ledger.
- FINMA (Swiss financial regulator) token classification, reserve auditing, and AML/KYC procedures would need to be established before any such token could be offered.

```
MJN Foundation (Swiss Stiftung, if/when formed)
├── Would hold: any on-chain token treasury, mint authority
├── Would govern: the MJNx → MJN relationship, RFC process for it
Imajin Inc. (Canadian corporation)
├── Operates: the kernel, the MJN/MJNx ledger, reference implementation
├── Does not: hold Stiftung mint authority, promise a conversion rate
```

### 5.3 Formation reference (unchanged shape, no commitment)

| Item | Cost (CHF) |
|------|------------|
| Legal setup (Swiss blockchain law firm) | 20,000 - 40,000 |
| Foundation endowment (minimum) | 50,000 |
| FINMA classification (legal fees) | 10,000 - 20,000 |
| Ongoing compliance + audit (annual) | 10,000 - 20,000 |
| Swiss-resident board member service (annual) | 5,000 - 10,000 |
| **Total to launch** | **~CHF 100,000 - 150,000 (~$110-165K USD)** |

Recommended firms (unchanged, for reference): MME, Lenz & Staehelin, Walder Wyss, LEXR (all Zurich/Zug, blockchain-specialized). No timeline is committed — the original draft's Q2–Q4 2026 target dates are removed; they predate the ruling and were never re-derived against it.

### 5.4 Existing reserved token (placeholder, not connected to the ledger)

A Solana token was already reserved as a placeholder in anticipation of the seat above: `12rXuUVzC71zoLrqVa3JYGRiXkKrezQLXB7gKkfq9AjK`, Solana Mainnet, supply 0 (nothing minted), mint authority currently held by Ryan. It has no relationship to today's MJN/MJNx ledger — it exists only so the address doesn't need to be re-claimed if/when the Stiftung seat is exercised. The whitepaper's "MJN token reserved on Solana" What's Live entry refers to this placeholder, not to a live bridge.

## Open Questions

1. **Activity emission schedule** — which activities emit MJNx, how much, and what caps apply. Tracked in #2012; lands as `bus_chain_configs` rows via #2017.
2. **Reconciliation cadence** — `GET /pay/api/admin/reconciliation` is on-demand today; does circulating-MJNx / backed-MJN reporting need a scheduled snapshot or alerting?
3. **Multi-rail MJN** — Lightning (#2004) and Solana Pay/x402 (#2013) both mint MJN against their own receipt formats; confirming each receipt schema is a design task for those issues, not this one.
4. **Reserved-seat trigger** — no open question here by design (§5.1): the seat stays reserved until a Stiftung exists to decide it.

## Dependencies

- Ledger split shipped (#2016, #2159, merged 2026-09-10).
- Activity emission schedule ruling + config migration (#2012, #2017) — in progress.
- Gift/event-topup as funded transfers (#2018) — shipped alongside #2159.
- Additional MJN rails: Lightning (#2004), Solana Pay/x402 (#2013), EMT direct (#2014) — not yet built.
- Reserved seat (§5): no dependency, no build — Stiftung formation is a precondition, not scheduled.

## References

- MJN Whitepaper: `docs/mjn-whitepaper.md` (see "MJN / MJNx ledger" under Settlement)
- #738 — Open Wallet epic, Decisions (2026-09-04 ruling this RFC implements)
- #2012 — MJNx activity emission schedule
- #2016 / #2159 — ledger split (shipped)
- #2018 — gift/event-topup as funded transfers
- #2019 — this reconciliation
- `apps/kernel/api-spec/pay.yaml` — wire contract for `Balance`, `/api/balance/*`, `/api/settle`, `/api/emission`

---

*"Two units, one ledger, provenance forever."*
