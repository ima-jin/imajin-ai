## 36. Founding Supporter Tier — Bridge from Demo to Fundraise

**Author:** Greg Mulholland (Tonalith)
**Filed:** 2026-04-22 (extracted from Proposal 28 §4; original framing filed 2026-03-27)
**Status upstream:** #474 OPEN, #433 OPEN (epic). No `supporter.*` attestation type in `packages/auth/src/types/attestation.ts` (34 types as of April 22 — verified).
**Related:** #474 (Founding Supporter tier), #433 (virtual MJN credits epic), RFC-12 (MJN Token Economics / #269), RFC-28 (Universal Real-World Registry), `docs/rfcs/drafts/fee-model.md` v3 (dual-token MJN + MJNx)
**Lineage:** extracted from P28 Launch Readiness (now `resolved/28-launch-readiness-critical-path.md`) — the rest of P28 was pre-April-1 launch-wiring that shipped; this §4 residue is the only durable carry-forward.
**Connects to:** P38 (RFC-28 commission ceiling — pairs at the "people-giving-money-to-early-network" surface), P35 (gas governance — both touch the token-meets-infrastructure boundary), business plan (biz-dev SAFE path is the *investor* bridge; this is the *supporter* bridge).

---

### 1. Why This Is Still Here

P28 was a launch-readiness document for April 1. The pre-demo wiring (§3.1–§3.3) shipped on time. The post-demo bridge-to-fundraise items did not:

- Greg's P28 §6 Week 1 target: "Ship #474 within one week of the April 1 demo."
- Reality on April 22 (22 days past demo): #474 and #433 both still OPEN; no `supporter.founding` / `supporter.seed` / `supporter.grove` / `supporter.canopy` attestation types in the controlled vocabulary.

The April 1 demo generated interest. Without the founding supporter mechanism, that interest has no on-network surface other than "buy me a coffee" or "fill out an interest form." The gap P28 §4 identified is still present.

### 2. What Has Changed Since the Original Draft

The founding supporter spec was written before three things that now shape it:

1. **Dual-token fee model v3** (MJN equity + MJNx stable, 1 CHF) — "founding rate virtual MJN" now has to choose. Is the founding allocation in MJN (equity-like, scarce, governance-bearing) or MJNx (stable, redeemable, non-speculative)? The original P28 §4 spec implicitly meant MJN. With MJNx now the stable track, this is a real decision.
2. **RFC-28 Universal Real-World Registry** (April 21) — introduces an *alternative* mechanism for "give someone skin in the game at bootstrapping time": claim a public stub, earn 90/10 commission. This is a different bridge than founding-supporter. P38 flagged the squatting risk; here the question is which bridge is primary.
3. **Biz-dev SAFE path** — the *investor* bridge exists on the biz-dev side (SAFEs, pitch-v3-universal). Founding Supporter is explicitly NOT that — it is the on-network contributor-to-infrastructure path for people who want skin in the game without being accredited investors. The two paths must not collide.

### 3. The Bridge Rationale

The April 1 demo will keep generating signal as it gets shown to prospects. People will keep asking "how do I support this?" The answers today:

- "Buy me a coffee" — no upside, no chain record, feels like charity.
- "Wait for the token mint" — indefinite deferral; interest dissipates.
- "Buy a Unit for $1,500" — Kaarlo's signal (P28 §4 opening): too much friction for most signal-holders.
- "Sign a SAFE" — only available to accredited investors; wrong path for most supporters.

The founding supporter tier converts interest into a chain-backed attestation with a locked-in conversion rate. It is the on-network version of "I was here early," with cryptographic proof and a defined economic path.

### 4. The Immediate Implementation Path (preserved from P28 §4.2)

```
1. Contribute via coffee/tip page (exists today — Stripe wired, DID attached)
2. supporter.{tier} attestation emitted on contributor's chain
3. Virtual MJN (or MJNx — see Decision #1 below) allocated at founding rate, recorded in attestation payload
4. At token mint (RFC-12 / #269): replay chain → derive allocation
```

**What is already infrastructure (not blocking):**
- `emitAttestation()` in `@imajin/auth` — works
- DFOS chain backing — every identity has a chain
- Pay service — Stripe + Solana wired
- Coffee/tip page — exists and processes payments
- Bilateral attestation layer (`authorJws` / `witnessJws`) — shipped; provides the countersignature surface a founding supporter tier can use for "contributor signs, network witness countersigns"

**What is blocking (the actual scope of this proposal):**
- `supporter.founding` + `supporter.seed` + `supporter.grove` + `supporter.canopy` in `ATTESTATION_TYPES`
- Attestation emission wired to the coffee/tip payment handler, keyed on contribution amount → tier
- The MJN-vs-MJNx decision (§5 Decision #1)
- The securities framing locked in (§5 Decision #3) before any contribution flow exposes a rate

### 5. Decisions Owed

| # | Decision | Greg's position |
|---|---|---|
| 1 | Is the founding allocation denominated in MJN (equity-like) or MJNx (stable)? | **MJN.** MJNx is for transactional stability; founding supporters are taking early risk for early upside, which is the MJN surface. A hybrid (some MJNx now as receipt, MJN at mint) is possible but adds conversion complexity — not worth it for a bridge mechanism. |
| 2 | Are the rates (20:1 Seed / 25:1 Grove / 30:1 Canopy) locked in now, or gated on RFC-12 / #269 finalization? | **Lock placeholder rates now with a clear "subject to token economics finalization" note in the attestation payload.** The contribution is the commitment; the rate is the recorded claim. If RFC-12 shifts the ratio, the claim remains honored at the recorded rate. The attestation is an irrevocable record of early contribution, not a contingent claim. |
| 3 | Securities framing — contribution-to-infrastructure (not investment-for-returns). | **Yes — this is non-negotiable.** The `.fair` attribution chain is a tracking record of contribution, not a security. MJN conversion is proportional to network participation, not speculation. Legal review before any contribution page exposes a rate. |
| 4 | Does the founding supporter appear in the trust graph as a special connection type, or is it purely attestation-level? | **Attestation-level only.** Trust graph connections are relationship primitives; supporter status is a contribution record. Keeping them separate avoids the "paying for trust" antipattern. |
| 5 | Does RFC-28 (public-stub claims) compete with or complement the founding supporter tier? | **Complement.** RFC-28 is for claiming a real-world entity presence; founding supporter is for contributing to network infrastructure. Different surfaces, different economics. A person can do both. |

### 6. Why The Rate Lock-In Matters

A founding supporter at 30:1 on April 25 and a founding supporter at 30:1 on December 25 are both "Canopy tier" in the attestation record. The rate attestation must be:

- **Recorded at the attestation payload level**, not computed at mint time against a current rate table.
- **Irrevocable** — the chain entry cannot be retroactively adjusted if RFC-12 lands at different numbers.
- **Honored regardless of network growth** — a Canopy contributor at month 1 and a Canopy contributor at month 12 both get their recorded rate at mint. This is the "founding" part of founding supporter.

This matters because if the rate can move (even implicitly), the supporter is taking on rate-risk in addition to project-risk. The chain-backed attestation must be the cryptographic equivalent of "I signed for these tokens at this rate on this date."

### 7. Detection Signals in the Repository

- `supporter.founding` OR `supporter.{tier}` in `packages/auth/src/types/attestation.ts` ATTESTATION_TYPES
- Coffee/tip payment handler in `apps/kernel/app/coffee/**` emits supporter attestation on payment confirmation, keyed by contribution amount
- #474 and #433 closed or moved to in-progress
- `supporter.founding` appears in `apps/kernel/api-spec/auth.yaml` attestation type enum
- A `/supporter` or `/founding` UX surface in `apps/kernel/app/` surfacing the tiers

### 8. What This Proposal Does NOT Cover (out of scope)

- **MJN token mint mechanics** — RFC-12 / #269 territory.
- **MJNx stablecoin mechanics** — fee model v3 + dual-token whitepaper section.
- **Investor SAFE path** — biz-dev repo, separate track.
- **Perks delivery** (Unit-at-cost, named in genesis block, reserved handle) — operational, not protocol.
- **Securities opinion** — external legal review, not this document.
- **RFC-28 claim economics** — covered by P38.

### 9. Timing

- **Blocker for:** structured post-April-1 supporter conversion. Every week without this surface is interest-dissipation.
- **Not a blocker for:** April 1 demo (past), business plan v1 (separate track), fundraise mechanics (SAFE path independent).
- **Suggested sequence:** (1) attestation types land in vocabulary; (2) coffee/tip handler emits on payment; (3) `/founding` page surfaces the tiers; (4) legal review gate on the rate-exposure page before external promotion.

---

*Original framing from P28 §4 preserved in substance. This extraction exists because P28 was a time-boxed launch-readiness document, and §4 is the only part whose gap is still present and still load-bearing for the fundraise bridge.*

*— Greg, April 22, 2026*
