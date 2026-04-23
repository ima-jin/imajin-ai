## 35. Gas Governance and Rent-Extraction Limits

**Author:** Greg Mulholland
**Date:** April 22, 2026
**Thread:** successor to Proposal 11 (Gas Model Ceiling)
**Related upstream:** `docs/rfcs/drafts/fee-model.md` line 184 (standing ask), RFC-08 (Org DID), RFC-28 (Universal Real-World Registry), RFC-17 (Governance Primitive)
**Addresses:** Outstanding Concern C05 (Gas Model Ceiling — the *ceiling*, not the flat rate)
**Sibling proposal:** P38 (RFC-28 Real-World Registry Risk Review) — shared theme

---

### 0. Why This Proposal Exists

Proposal 11 proposed a frequency-scaled gas curve for the Declared-Intent Marketplace (Stream 2). Since March, fee model v3 has **shipped the flat gas rate** (1¢/op, 100% to node, signed integrity chain — `fee-model.md` §Gas Fees) but explicitly left **gas-rate governance** as an open question:

> **Open:** Gas rate governance model (central bounds + node discretion, annual vote, or threshold-triggered review). *Candidate for Greg's analysis.* — `fee-model.md:184`

This proposal is the response to that standing invitation, bundled with the unresolved components of P11:

- The **frequency multiplier curve** (reach-depth ceiling).
- **Cluster-aware gas** (coordinated Org DID ring detection).
- **`.fair` compliance-gated gas** (flags modulate cost).
- **User-configurable sovereign overlay** (rate limits, whitelist, blacklist).
- **Recipient share** of high-frequency gas (positive-sum reach).

And one new piece on top: the **governance shell** that makes all of this politically legitimate — who sets the curve, who adjusts it, under what constraints, with what audit.

### 1. The Rent-Extraction Theme

Imajin's no-advertising economy relies on trust-graph position being **unpurchasable**. But capital still seeks attention. Four surfaces convert capital into influence in a no-ads economy:

| Surface | Extraction mechanism | This proposal | Sibling |
|---|---|---|---|
| Reach width (graph hops) | Buy Tier 2/3 gas | Governed (below) | — |
| Reach depth (frequency) | Pay for saturation | §3 curve | — |
| Real-world stub claim | 90/10 commission farming | — | **P38** |
| Covenant-flagged actors | Ignore flags, pay through | §5 compliance gate | — |

P38 handles claim-time extraction; this proposal handles ongoing-transaction extraction. Together they are the rent-extraction-limits pair. They should be reviewed together by Ryan, ratified together, and cross-referenced in any fee model v4.

### 2. Governance Shell (the new part — answering `fee-model.md:184`)

Three governance models were enumerated in the fee model:

| Model | Shape | Risk |
|---|---|---|
| Central bounds + node discretion | Protocol sets min/max; node picks within | Bounds fixed by founding cohort |
| Annual vote | Trust-graph-weighted ballot once per year | Brittle to shocks; captured by whoever votes |
| Threshold-triggered review | Vote only when a metric trips | Depends on whose metric, whose threshold |

**Recommendation: hybrid — bounded discretion with threshold triggers.**

1. **Protocol-set bounds.** Two parameters enshrined at ratification:
   - `GAS_MIN`: floor per non-economic op (proposed: 0.0005 MJN / ~0.5¢)
   - `GAS_MAX`: ceiling per non-economic op (proposed: 0.005 MJN / ~5¢)
   - Bounds change only via RFC-17 governance primitive (trust-graph-weighted quorum, not routine).

2. **Node discretion inside the bounds.** Nodes publish their rate on-chain (already spec'd in fee model v3 §Gas Integrity Model). Decreases take effect immediately; increases require 24h notice (already spec'd). Rate history is auditable via chain replay.

3. **Threshold-triggered review.** The *bounds themselves* are reviewable — but not on a calendar. Review is triggered by any of:
   - **Cost-of-compute drift** — if compute costs drop or rise > 40% YoY (external benchmark).
   - **Network usage asymmetry** — if one relay's gas rate exceeds the network median by > 3× for > 90 days.
   - **Node-operator petition** — any node operator with > 5% of network volume can file.
   - **Founding-anchor petition** — any founding Person DID with a cluster triggering §4 cost can file.

4. **Audit surface.** Every rate change is a chain entry. Every threshold trigger is a chain entry. Every governance vote is a chain entry. Any operator can replay and verify.

**What this buys us:** gas-rate governance that isn't captured by the founding cohort (protocol bounds are a constitutional parameter, not a market one), but also isn't rigid (thresholds let the network adapt without annual drama). The founding cohort sets bounds once; the network operates within them continuously; the bounds themselves are amendable but only for cause.

### 3. Frequency Multiplier Curve (carried forward from P11 §3)

Unchanged from P11:

| Message # to same DID (30-day rolling) | Multiplier |
|---|---|
| 1st | 1× |
| 2nd | 2× |
| 3rd | 4× |
| 4th | 8× |
| 5th | 16× |
| 6th+ | 32×+ |

**Ratification question:** is the curve itself protocol-set, node-set within bounds, or user-set per-inbox? Greg's position: **protocol-set**, because it's structural. A node that could unilaterally flatten the curve could become a saturation vendor. Nodes compete on price within bounds, not on anti-saturation policy.

### 4. Cluster-Aware Gas (carried forward from P11 §4, blocked)

Still blocked by the same attestation gap as P10. Requires:
- `org.founding` attestation type (does not exist; not in `packages/auth/src/types/attestation.ts`).
- `departureSummary`-style aggregation across Org DIDs sharing a founding Person DID.
- Cumulative frequency count across a cluster.

**Status:** design here, ship when P10's attestation vocabulary lands. Do not ship frequency-scaling alone without cluster-awareness, because it just pushes capital to register more Org DIDs. This is a **hard dependency** on P10.

### 5. `.fair` Compliance Gate (carried forward from P11 §6, narrowed)

Original P11 proposal:
- `flag.yellow` → standard gas + recipient notice
- `flag.amber` → 2× gas
- `flag.red` → blocked

**Narrowing.** The "recipient notice" mechanism on `flag.yellow` is underspecified and risks becoming a warning-fatigue UX. Replace with:
- `flag.yellow` → **1× gas** (no cost modulation; flag is visible in sender profile but reach is unchanged).
- `flag.amber` → **4× gas** (aligned with the multiplier curve's 3rd-message step).
- `flag.red` → **blocked** until flag resolved or appealed per RFC-17.

Compliance state reads from `auth.attestations`. Gate enforcement lives in whichever service ships Stream 2.

### 6. User Sovereign Overlay (carried forward from P11 §5)

Unchanged substance. Default-safe: a user who configures nothing is protected by §3. Configuration options:

- **Personal rate limit** — tighter than protocol default.
- **Whitelist** — per-Org-DID exemption from multipliers.
- **Blacklist** — hard block regardless of gas paid.

Storage: user preferences. Enforcement: Stream 2 dispatch reads user prefs + §3 curve and takes the stricter of the two.

### 7. Recipient Share (carried forward from P11 §7, sharpened)

Fee model v3 says "100% to node, 0% to protocol" for gas. P11 argued for a small recipient share on high-frequency messages, as a positive-sum incentive to permit reach.

**Sharpened proposal.** Recipient share **activates at the 3rd message** (when the multiplier reaches 4×). Split from that point:

| Message # | Multiplier | Node share | Recipient share |
|---|---|---|---|
| 1st | 1× | 100% | 0% |
| 2nd | 2× | 100% | 0% |
| 3rd | 4× | 75% | 25% |
| 4th | 8× | 60% | 40% |
| 5th+ | 16×+ | 50% | 50% |

Rationale: low-frequency reach is what the network wants to subsidize (node covers its costs, no friction to normal business). High-frequency reach should pay the user directly, because the user is the scarce resource. At the 16× step, the user is earning more than the node from that contact.

This also **inverts the saturation economics.** A sender targeting a single high-value user over and over ends up transferring most of the cost to that user, who can decline or blacklist. The ceiling becomes socially self-enforcing rather than purely protocol-enforced.

### 8. Dependency Cascade

P35 cannot be shipped end-to-end until:

1. **Stream 2 (Declared-Intent Marketplace) exists.** `apps/market` is product listings, not intent-reach messaging. No surface to attach to.
2. **`org.founding` attestation exists** (P10 gap) — blocks §4 cluster-aware gas.
3. **`.fair` flag enforcement runtime exists** (Phase 3 per resolved/17) — blocks §5 compliance gate.

**But the governance shell (§2) can be ratified now,** because it defines bounds for the already-shipped flat rate. Ratifying §2 in isolation would (a) answer Ryan's standing question, (b) protect against node-level rent extraction under the current flat rate, (c) lay the constitutional frame for §3–§7 when Stream 2 exists.

### 9. Relationship to P38

P38 (RFC-28 Real-World Registry risk review) and P35 are siblings. Both are rent-extraction limits inside a no-advertising economy.

| | P38 | P35 |
|---|---|---|
| Extraction surface | Claim-time commission on stubs | Ongoing gas on frequent reach |
| Cap mechanism | Commission ceiling + time decay | Bounded rates + frequency multiplier |
| Governance model | Staking deposit + ceiling parameter | Protocol bounds + threshold review |
| Dependency | RFC-28 ship (imminent) | Stream 2 + P10 (later) |

**Bundle for Ryan review.** A single "Rent-Extraction Limits" cover memo introducing both. Both follow the same constitutional logic: the protocol sets bounds, the market operates within them, the bounds themselves are amendable but only for cause.

### 10. Open Questions for Ryan

| Question | Why it matters | Greg's position |
|---|---|---|
| Are `GAS_MIN=0.0005 MJN` / `GAS_MAX=0.005 MJN` the right protocol bounds? | Determines the constitutional band | Calibrate post-launch; proposed values bracket current 1¢ at ±5× |
| Is threshold-triggered review the right governance shape, or do you prefer annual vote? | Determines rigidity vs. responsiveness | Threshold — calendars get captured; metrics are auditable |
| Who triggers a "node-operator petition"? 5% threshold sensible? | Protects against fringe-driven review churn | 5% is the floor; lower = review theater, higher = big-node capture |
| Should the multiplier curve itself be a protocol constant or a bounded-discretion parameter? | Determines whether nodes can compete on anti-saturation | Protocol constant — nodes compete on base rate, not curve shape |
| Recipient-share activation at 3rd message — right threshold, or should it start at 2nd? | Determines how aggressive the social self-enforcement is | 3rd is where the multiplier first exceeds 2× — i.e., past "occasional" |
| Should P35 §2 ratify independently of §3–§7, or as a block? | Determines time-to-governance | Ratify §2 now; §3–§7 ship as surfaces land |

### 11. Detection Markers in the Repo

P35 is resolved when all of the following exist:

- `GAS_MIN` / `GAS_MAX` constants in `packages/fair/` or `packages/config/` referenced by gas computation.
- Threshold trigger definitions in `docs/rfcs/drafts/fee-model.md` §Gas (or promoted RFC).
- Frequency-multiplier lookup in Stream 2 dispatch path.
- Cluster aggregation reading `org.founding` attestations.
- Flag-state → gas-cost modulation in compliance middleware.
- User preference schema with rate-limit / whitelist / blacklist columns.
- Recipient-share distribution in gas settlement accounting.

---
