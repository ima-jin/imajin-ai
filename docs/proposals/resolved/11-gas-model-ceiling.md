# P11 — Gas Model Ceiling ✅ RESOLVED 2026-04-22 (superseded by P35)

**Resolution:** P11's components were split by outcome during the April 22 audit. The **existence** of gas was accepted and shipped in fee model v3; the **ceiling mechanism and governance shell** — the actual unresolved substance of P11 — moved to a successor proposal that also answers Ryan's standing invitation at `docs/rfcs/drafts/fee-model.md:184`.

**What shipped (counts against P11):**
- Flat gas rate: 0.001 MJN / ~1¢ per non-economic op, 100% to node operator (fee model v3 §Gas Fees).
- Gas integrity model: user-signed op → relay countersigned charge → signed rate schedule on chain → peering-relay audit. Rates cannot be backdated or silently inflated (fee model v3 §Gas Integrity Model).
- Rate-change cadence: decreases immediate; increases require 24h notice.
- `gas_balances` materialized table, rebuildable from chain replay.

**What moved to P35 (Gas Governance and Rent-Extraction Limits):**
- Governance shell: protocol-set `GAS_MIN`/`GAS_MAX` bounds + bounded node discretion + threshold-triggered review (answering `fee-model.md:184`).
- Frequency-scaled multiplier curve (original §3) — protocol constant within bounds.
- Cluster-aware gas — still blocked on P10 `org.founding` attestation gap.
- `.fair` compliance gate — narrowed: flag.yellow 1×, flag.amber 4×, flag.red blocked.
- User sovereign overlay — carried forward unchanged.
- Recipient share — sharpened: activates at the 3rd message (4× multiplier step), scaling up to 50/50 at 16×+.
- New framing: P35 pairs with P38 under the "rent-extraction limits" theme for bundled Ryan review.

**See:** `current-proposals/35-gas-governance-rent-extraction-limits.md`

---

*Original proposal preserved below for lineage.*

---

## 11. Gas Model Ceiling — Stream 2

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/gas-model-ceiling.md`
**Related upstream:** Discussion #253 (Org DID), MJN whitepaper
**Addresses:** Outstanding Concern 5 (Gas Model Ceiling)

### Executive Summary

The Declared-Intent Marketplace (Stream 2) resolved the structural contradiction between Imajin's sovereignty values and commercial revenue: no platform optimization between user attention and advertiser reach, local profile matching, trust-graph position that cannot be purchased.

One calibration gap remains: capital can achieve saturation of the opted-in pool through **volume**, even without buying trust-graph position. A well-funded Org DID paying high gas can reach every opted-in user in a relevant category as frequently as it chooses. Within a consent-based model, volume becomes a proxy for influence. The door can't be bought, but it can be knocked on constantly by the highest bidder.

This is a calibration problem, not a structural problem. The recommended solution: **frequency-scaled gas** as the primary mechanism, with user-configurable rate limits as an optional overlay.

### 1. Reach Width vs. Reach Depth

The three-tier gas model gates reach by graph distance — **reach width**. It says nothing about how frequently a business can reach the same opted-in user — **reach depth** is unconstrained.

A well-funded Org DID can pay Tier 2 or Tier 3 gas repeatedly to maintain constant presence. A bootstrapped business sends one message and waits. This recreates a two-tier visibility problem inside the consent model.

### 2. The Three Mechanisms

**Mechanism A — Consent alone (current state):** The problem is the asymmetry between opt-out friction (cognitive cost that compounds) and saturation cost (marginal for a well-funded sender). Surveillance advertising depends on exactly this tolerance gap.

**Mechanism B — Per-recipient rate limit (hard cap):** Cap the number of times a single Org DID can reach a single opted-in Person DID within a time window. Clean enforcement, but creates hard-limit edge cases (legitimate high-frequency businesses, user whitelists).

**Mechanism C — Frequency-scaled gas (Recommended):** Gas cost to reach the same opted-in Person DID scales with recency. First message within a 30-day window: standard Tier 2/3 gas. Subsequent messages: exponentially increasing cost.

### 3. The Recommended Multiplier Curve

| Message # to same DID (30-day window) | Multiplier | Rationale |
|---------------------------------------|------------|-----------|
| 1st | 1× | Standard gas |
| 2nd | 2× | Mild deterrence |
| 3rd | 4× | Meaningful cost signal |
| 4th | 8× | Saturation becomes expensive |
| 5th | 16× | Economically irrational for most senders |
| 6th+ | 32×+ | Hard ceiling in practice |

**The multiplier curve is the single governance parameter.** It should be a protocol-level parameter that nodes can adjust within defined bounds. The critical calibration question: at what multiplier does saturation become economically irrational, and does the 5th/6th message multiplier achieve that threshold?

### 4. Closing the Gaming Vector — Cluster-Aware Gas

The coordinated Org DID cluster scenario — multiple businesses sharing a founding Person DID, rotating senders to circumvent per-sender frequency scaling — is the primary gaming risk.

The fix requires `auth.attestations` infrastructure: Org DIDs are non-severably anchored to founding Person DIDs through `org.founding` attestations. Cluster gas computation detects when multiple Org DIDs share a founding Person DID and applies the cumulative frequency cost as if they were a single sender to the same recipient.

Negative behavioral attestations on an Org DID propagate a standing penalty to founding Person DIDs. This creates a direct disincentive for coordination.

**This is a hard dependency:** cluster-aware gas computation cannot be implemented before the attestation layer is live.

### 5. User-Configurable Overlay — Sovereign Rate Limit

Frequency-scaled gas deters saturation economically; user configuration provides personal sovereignty over commercial reach:

- **Personal rate limit:** User sets maximum messages-per-Org-DID-per-period (default: platform default, user can restrict further)
- **Whitelist:** User explicitly whitelists an Org DID for unrestricted reach (e.g., their favorite local business)
- **Blacklist:** User permanently blocks an Org DID — supersedes everything else, including gas payment

**Key design principle:** The default state should be the low-effort, well-protected baseline. A user who never configures anything is already protected by the frequency-scaled gas curve.

### 6. .fair Compliance as a Gas Model Gate

An Org DID that is not .fair compliant pays a higher gas cost to reach opted-in users, or is blocked from Stream 2 entirely pending compliance. The gas model becomes a partial enforcement mechanism for covenant adherence:

- `flag.yellow` on an Org DID: standard gas + transparency notice to recipients
- `flag.amber`: elevated gas cost (e.g., 2× base)
- `flag.red`: blocked from Stream 2 until flag resolved

Automated Org DID messages (Stream 3 settlement) must carry signed .fair manifests as a condition of settlement.

### 7. Where Gas Fees Go — Incentive Alignment

The platform should never benefit from enabling saturation. Recommended distribution:
- Node operator: operational costs
- Platform: protocol sustainability
- Recipient Person DID: small share for high-frequency messages — creating a direct financial incentive for users to permit high-gas commercial reach, while retaining the right to set their own rate limit

The most important property: if the platform and node operators both benefit more from high-quality, low-frequency commercial reach than from saturation, the incentive structure reinforces the gas model's design intent.

### 8. Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Multiplier curve starting values — are these correct? | Determines economic deterrence threshold | Start with proposed values; calibrate post-launch with transaction data |
| Should frequency scaling be per-Org-DID or per-founding-Person-DID? | Determines gaming surface before cluster-aware computation is live | Per-Org-DID for MVP; upgrade to cluster-aware when attestation layer is live |
| Does the recipient Person DID receive a share of high-frequency gas fees? | Incentive alignment for high-gas commercial reach | Yes — creates positive-sum model for frequent reach |
| What is the time window for frequency scaling — 30 days, 7 days, rolling? | Shorter windows are stricter; longer windows are more business-friendly | 30-day rolling window |
| Should .fair non-compliance block Stream 2 access entirely, or just cost more? | Enforcement vs. incentive model | Cost more first; block after unresolved `flag.amber` |

**Detecting resolution in the repo:**
- Frequency multiplier applied in Stream 2 gas calculation logic
- `apps/pay/` or Stream 2 routing service reads per-recipient message history for gas computation
- User rate limit configuration in profile or settings service
- `.fair` compliance check in Stream 2 dispatch flow

### Roadmap Placement — 2026-03-13

Assigned to **Phase 3** in the Settlement & Economics Hardening Roadmap. Ryan notes: "Low (pre-Stream 2) — but design needed now."

Phase 3 scope:
- Frequency-scaled gas in Stream 2 routing
- Cluster-aware gas (detect coordinated Org DID clusters sharing founding DID) — depends on Identity Phase 2 attestation layer

**Current state:** Stream 2 (Declared-Intent Marketplace) is not yet implemented. The gas model cannot be implemented before Stream 2 exists. However, the frequency-scaled gas mechanism should be designed into the Stream 2 schema from the start — retrofitting it will be harder than building it in.

The `.fair` compliance gate proposed in §6.1 of this document (Org DIDs with constraint violations pay higher gas) connects directly to Proposal 17's intent constraint model. Both should be designed in parallel.

---

