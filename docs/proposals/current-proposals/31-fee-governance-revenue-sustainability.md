## 31. Fee Governance — Revenue Sustainability and Anti-Capture Mechanism

**Author:** Greg Mulholland
**Date:** March 29, 2026
**Priority:** HIGH — directly affects business plan financials and investor narrative
**Matrix cells:** All scopes × Settlement
**Related issues:** #474 (founding supporter), RFC-12 (MJN Token Economics)
**Related concerns:** C14 (Foundation governance)
**Connects to:** P11 (Gas Model — resolved, superseded by P35), P14 (Governance Equity), P35 (Gas Governance — gas-specific successor)
**Protocol repos:** [mjn-protocol](https://github.com/ima-jin/mjn-protocol) (RFC-0001 core spec, RFC-0004 token economics), [.fair](https://github.com/ima-jin/.fair) (settlement RFC)

---

### April 22, 2026 — Status Sharpening

**Substantially resolved at the spec level. Fee model v3 adopted P31's core governance mechanism. Four residual items carry forward; one bounds delta needs Greg's explicit acceptance or pushback.**

**What became canon (`docs/rfcs/drafts/fee-model.md` verified April 22):**
- **§5 governance mechanism adopted verbatim:** *"Only the **protocol fee** is governance-controlled"* (line 74); *"Bounded: 0.25% floor (starvation prevention), 2% ceiling (capture prevention)"* (line 76). P31's §2 failure-mode framing is now the canonical anti-capture argument.
- **RFC-17 Governance Primitive (shipped March 21, Ryan+Jin)** provides the engine §5 assumed: TTL'd decisions, standing-weighted voting, fork-reversible. P31's "trust-graph-elected governance body" has a specified mechanism it did not when filed.
- **§3 DID-scoped fee proposal — partially vindicated as scope fee.** The scope fee (0.25% default, sovereign, no protocol ceiling) is a DID-scoped fee, but *community-controlled* not *protocol-controlled* — a stronger answer than P31 proposed on the sovereignty axis.
- **§8 Q2 (voting mechanism) — RESOLVED by RFC-17 + dual-token split:** standing-weighted (behavioral, not financial). MJN is earned-through-standing, not ownable-through-purchase; MJNx is non-governance-bearing. The capture vector P31 worried about (wealthy actor buys votes) is structurally closed.
- **§6 business plan implications — integrated.** App studio model now business-plan canon; "protocol fee doesn't fund the company alone" is load-bearing for fundraise narrative.
- **§7/§7.1 already updated in-place** with fee model v3 integration on April 5.

**Bounds delta — needs Greg's explicit sign-off:**

| | Floor | Ceiling |
|---|---|---|
| P31 §4 (Ryan's March 29 response) | 0.75% | 3% |
| fee-model.md canon (April 22) | **0.25%** | **2%** |

Both moved downward since P31 filed. Floor -0.50% (more adoption latitude, more starvation risk). Ceiling -1.0% (tighter anti-capture; even a captured governance body cannot 3× the fee).

**Greg's open position owed:** accept 0.25%/2%, or push back for 0.50%/2% (keep the lower ceiling, raise the floor to preserve starvation protection)? Floor stress test: at $155K Y1 volume, 0.25% floor = $388/yr vs 0.75% floor = $1,163/yr. Y1 revenue is not the binding constraint (app studio is), but floor scenarios matter for the "protocol still funds development in adoption mode" story.

**§8 Open questions — April 22 status:**

| Q | P31 framing | Current status |
|---|---|---|
| Q1: Enforcement location — kernel or Solana? | Open | **Still open.** `fee-model.md:88`: *"Solana contract holds the protocol rate (or reads from governance state)"* — ambiguous. No `protocolFee` / `PROTOCOL_FEE` enforcement code in `apps/kernel` (only refund route + build-log match). Specified but not implemented. |
| Q2: Voting mechanism? | Open | **Resolved by RFC-17 + dual-token:** standing-weighted, not MJN-weighted, not one-DID-one-vote. |
| Q3: Foundation → trust-graph transition timing? | Open | **Still open at the trigger layer.** RFC-17 specifies the mechanism; no trigger conditions (count threshold, declaration, time-box) are specified anywhere. Decentralization-narrative load-bearing for fundraise. |
| Q4: Multi-node consistency in federation? | Open | **Still open.** RFC-28 stubs span nodes; nodes may disagree on protocol rate if reading different governance-state replicas. Unaddressed. |

**What complicates P31 since writing:**
- **Dual-token MJN/MJNx** structurally closes the "wealthy actor buys votes" capture vector (§8 Q2 dimension).
- **RFC-28 Universal Real-World Registry** adds a 90/10 commission layer *above* the 4-layer fee stack. P31's total-effective-rate analysis needs to account for stub commissions. **P38** pairs here — P38's commission ceiling argument is the RFC-28 analogue of P31's anti-capture bounds for protocol fee.
- **@imajin/bus #759** — fee adjustments will emit via the bus envelope. P31's "chain-recorded attestation for every fee change" maps to a bus event. P40 safety-plan territory.
- **P35 (Gas Governance, filed April 22)** is the gas-specific successor for the `fee-model.md:184` open question on gas rate governance. P31 and P35 share the "governance-controlled rate with bounds" pattern.

**Load-bearing open questions for Ryan (new April 22):**

> **(1) Bounds delta — accept 0.25% / 2%, or push back to 0.50% / 2%?**
> 2% ceiling is stronger anti-capture; worth keeping. 0.25% floor is aggressive — 0.50% preserves starvation protection with the same adoption latitude for most scenarios.
>
> **(2) Where is protocol fee enforced — kernel (upgradeable) or Solana contract (immutable)?**
> This is `fee-model.md:88` restated. The answer shapes the entire anti-capture argument: kernel-enforced means governance is captureable via kernel control; contract-enforced means governance is at arm's length from operational control.
>
> **(3) Foundation → trust-graph handoff — under what triggers?**
> Candidate triggers: (a) standing-weighted participant count crosses threshold, (b) Foundation declares by governance operation, (c) time-boxed (e.g., 5 years post-launch). Business-plan-relevant for the decentralization-over-time narrative.

**Revised scope for P31:**
- **Effectively resolved by fee-model.md + RFC-17:** §1, §2, §3, §4 (minus bounds delta), §5, §6, §7, §7.1, §8 Q2.
- **Carry forward as open items:** bounds delta (§4), §8 Q1 enforcement location, §8 Q3 Foundation transition timing, §8 Q4 multi-node consistency, gas governance cross-reference to P35.
- **Reframe as a "residual items" document** — the original proposal's big moves are in canon; what remains is implementation + three specific decisions.

Sections below preserve the original substance unchanged.

---

### 1. The Problem

The 1% flat settlement fee, while simple and legible, creates a structural tension:

1. **Year 1 revenue gap:** At $155K settlement volume, protocol revenue is $620. This is insufficient to demonstrate revenue traction to investors.
2. **Fee decay compounds the gap:** The tokenomics draft specifies fee decay (1% → 0.75% → 0.5%) at volume thresholds, which means the protocol gets cheaper as it grows — good for adoption, challenging for revenue.
3. **Flat rate ignores value asymmetry:** A $25 event ticket and a $50,000 business settlement both pay 1%. The business settlement generates vastly more protocol overhead (compliance, dispute resolution, attestation complexity) but pays the same proportional fee.
4. **Immutability risk:** If the 1% rate is hardcoded and the market shifts, the protocol has no mechanism to adapt.

### 2. Analysis — The Capture Question

Platform fees tend toward extraction because platforms control the fee unilaterally. The governance question is: how does a protocol adjust its fee without becoming extractive?

**The failure modes:**
- **Too low:** Protocol can't fund development. Network stagnates.
- **Too high:** Communities leave. The sovereignty promise is broken.
- **Immutable:** No adaptation to market conditions. Either too low or too high forever.
- **Centrally adjustable:** Governance theater. Who controls the adjustment controls the network.

### 3. Greg's Original Proposal — DID-Scoped Fees

The original analysis proposed DID-scoped fees based on identity type:

| DID Scope | Proposed Fee | Rationale |
|-----------|-------------|-----------|
| Actor (personal) | 0.5% | Individuals subsidized — network growth priority |
| Cultural (community) | 1.5% | Communities pay for collective infrastructure |
| Business (commercial) | 2.5% | Commercial use pays for the value it extracts |

Year 1 revenue under this model (blended rate ~1.6%): **$159K–$283K** vs. $620 at flat 1%.

### 4. Ryan's Response — Keep 1%, Add Governance

Ryan's position (March 29): the DID-scoped fee analysis is "genuinely valuable" but the implementation should be simpler:

- **Keep 1% flat rate** — simplicity and legibility matter. "1%" is the thing people remember.
- **Add governance mechanism** — trust-graph-elected fee adjustment within structural bounds
- **Tighter bounds:** Floor **0.75%**, ceiling **3%** (not the proposed 0.25% / 5%)
- **Fee decay at volume thresholds remains** (per tokenomics draft)

### 5. The Governance Mechanism

The fee governance mechanism works as follows:

1. **Default rate:** 1% (applies unless governance action changes it)
2. **Adjustment bounds:** 0.75% floor / 3% ceiling
3. **Adjustment authority:** Trust-graph-elected governance body (initially the MJN Foundation board, eventually trust-graph-weighted voting)
4. **Adjustment triggers:** Annual review, or emergency proposal with supermajority
5. **Transparency:** All fee changes are chain-recorded attestations — auditable by any participant

This mechanism ensures:
- The protocol can adapt if 1% is wrong
- No single entity controls the fee
- The bounds prevent both extraction (ceiling) and starvation (floor)
- Every adjustment is cryptographically documented

### 6. Implications for Business Plan

The governance mechanism changes the investor narrative:

**Before:** "1% forever, revenue scales linearly with volume"
**After:** "1% default with governance-adjustable bounds. The protocol can adapt to market conditions while maintaining structural anti-capture guarantees."

The app studio model (vertical leads + platform licensing + professional services) addresses the Year 1 revenue gap more directly than fee adjustment. The governance mechanism is the long-term structural answer; studio revenue is the near-term economic answer.

The open-core model (kernel open source, production verticals commercial) means revenue comes from studio operations, not just protocol fees. This fundamentally changes the fee governance calculus — the 1% fee doesn't need to fund the company alone.

### 7. Upstream Fee Model v2 → v3 (March 30 → April 5)

**v2 (March 30):** Ryan drafted `docs/rfcs/drafts/fee-model-v2.md` (commit 162b47e3) — three-party model at 1.75% default.

**v3 (April 5):** Replaced by `docs/rfcs/drafts/fee-model.md` — four-layer model:

| Layer | Range | Default | Set by |
|-------|-------|---------|--------|
| Protocol (MJN) | 0.25% – 2% | 1.0% | Governance (trust-graph-weighted voting) |
| Node operator | 0.25% – 2% | 0.5% | Node operator (market-driven) |
| Buyer credit | 0.25% – 2% | 0.25% | Node operator |
| **Scope fee** | 0% – no cap | 0.25% | Scope owner (community/org) |

**Default total: 2.0%.** Key additions over v2:
- **Scope fee** — sovereign, no protocol ceiling. Communities self-fund (Mooi cited by name).
- **Dual-token** — MJN (equity/governance, earned, not purchasable) + MJNx (stable, 1 MJNx = 1 CHF). Supersedes RFC-12.
- **Gas fees** — 1¢ per non-economic operation, 100% to node, bilateral signing for integrity.
- **Platform affiliation** — `relay_config.platform_did` (node default) + `forest_config.platform_did` (per-scope override).

**Impact on P31:** P31's governance mechanism (bounds + chain-recorded adjustments) adopted for protocol fee. P31's DID-scoped fee analysis (§3) partially vindicated — the scope fee IS a DID-scoped fee, but sovereign rather than protocol-controlled. Gas model resolves P11 at spec level.

**Impact on business plan:** Total effective rate 2.0% (was 1.75%). Protocol revenue unchanged at 1.0%. Scope fee is NOT Imajin revenue — it's community revenue, strengthening the sovereignty pitch.

### 7.1 Relationship to MJN Tokenomics

The tokenomics draft specifies fee decay at cumulative volume thresholds:
- $0–$100M: 1.0%
- $100M–$1B: 0.75%
- $1B+: 0.5%

The governance mechanism and fee decay interact: governance sets the base rate within bounds, and fee decay applies on top of that as volume thresholds are crossed.

### 8. Open Questions

1. **Where is the fee rate enforced?** Kernel code (upgradeable) vs. Solana contract (immutable). Ryan's tokenomics draft asks this for fee decay — same question applies to governance adjustments.
2. **Voting mechanism:** Trust-graph-weighted? MJN-weighted? One-DID-one-vote? Each has capture dynamics.
3. **Transition period:** When does governance authority transfer from founders to the trust graph?
4. **Multi-node consistency:** In a federated network, how do nodes agree on the current fee rate?

### 9. Detecting Resolution

- [ ] Fee governance mechanism documented in an RFC
- [ ] Governance bounds (0.75% floor / 3% ceiling) specified in protocol
- [ ] Business plan reflects governance-adjustable fee (not "immutable 1%")
- [ ] Fee adjustment authority defined (Foundation → trust graph transition)
- [ ] Interaction between governance and fee decay clarified

---
