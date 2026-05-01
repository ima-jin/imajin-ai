# Goal-Based Deposits — MJNx Top-Up with Milestones

## Summary

Let users deposit funds (MJNx) directly onto the platform with no purchase required. Deposits are always spendable and always withdrawable. Aggregate deposit totals are displayed publicly against community-defined milestones to build social proof and signal demand.

## Problem

Right now MJNx balances only accumulate through transaction fee variance (Stripe reconciliation rebates). There's no way to load funds onto the network ahead of there being things to buy. Early supporters who want to back Imajin have no mechanism between "use it in a transaction" and "invest" — and investing requires sophistication most people don't have and risk they shouldn't take.

## Proposal

### Core: Direct Deposit Flow

- **Top-up page** (`/pay/deposit` or `/wallet/deposit`) — simple amount entry + Stripe PaymentIntent
- Stripe charges the user → credits MJNx balance (1:1 CAD)
- No purchase, no counterparty, no .fair manifest (this is a pure fund load)
- Balance is immediately spendable on any network transaction (events, market, etc.)
- **Withdrawal flow:** user can request balance withdrawal at any time → Stripe payout or reversal
  - Important: "your money is always yours" — this is stored value, not a donation or investment

### Milestones: Goal-Based Commitment

- **Public progress dashboard** — shows aggregate deposits, depositor count, and milestone targets
- Milestones are admin-configured (per-node or network-wide):
  - `$10,000 — Launch the Muskoka Network Card`
  - `$25,000 — First 100 businesses onboarded`
  - `$50,000 — Open the market to external sellers`
  - `$100,000 — Ship the first hardware node`
- **Visual progress bar** — simple, embeddable, shareable
- **Depositor opt-in visibility** — anonymous by default, option to show name/handle on supporters list
- **Outcome-pegged removability:** each milestone has a target date or condition. If the milestone isn't realized by that date, depositors who committed against that milestone can withdraw penalty-free (they always can anyway, but the framing matters — "we'll hit this or you get it back")

### Privacy & Regulatory

- Deposits are **stored value**, not securities, not donations
- No interest, no returns, no equity — just a spendable balance
- Under PCMLTFA prepaid instrument thresholds (confirm: $1M aggregate without MSB registration?)
- Terms of service must be clear: this is your money, spendable or withdrawable, not an investment

## Technical Notes

- Stripe PaymentIntent with no connected account (funds go to platform Stripe account)
- MJNx credit via existing `@imajin/pay` balance system
- New tables: `deposit_goals` (milestones), `deposits` (individual top-ups, linked to goal if user chose one)
- Withdrawal: Stripe Transfer or refund depending on timing — needs design
- Dashboard: public API endpoint for aggregate stats, SSR page for display

## UX Flow

1. User visits deposit page (linked from homepage, profile, wallet)
2. Sees current milestones with progress bars
3. Enters amount ($50 min? $25? TBD)
4. Optional: selects a milestone to commit against
5. Stripe checkout → balance credited → confirmation with updated progress
6. Public dashboard updates in real-time
7. User's wallet shows MJNx balance, spendable anywhere on the network

## Out of Scope (for now)

- Recurring deposits / subscription-style top-ups
- Deposit matching (though this is interesting — could a business match deposits?)
- EMT/Interac funding (future, eliminates Stripe fees entirely)
- MJN token conversion (Year 3)

## Labels

`feature`, `pay`, `mjnx`, `community`

## Priority

High — this is a pre-revenue traction mechanism and a credible signal to lenders/investors. Should ship before Muskoka summer program.
