# RFC-15 Response: Trust Accountability Framework

**Responding to:** [RFC-15 — Trust Accountability Framework](https://github.com/ima-jin/imajin-ai/blob/main/docs/rfcs/RFC-15-trust-accountability-framework.md)
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/273
**Related:** RFC-13 (Progressive Trust), RFC-17 (Governance Primitive), RFC-07 (Cultural DID), RFC-01 (.fair Attribution)
**Author:** Greg (kimaris@gmail.com)
**Status:** Draft response for community discussion

---

## Framing

RFC-15 specifies how the network handles misconduct — flagging, decay, demotion, rebuild. This response absorbs scope inherited from our RFC-13 response (Q4 left the specifics of network-level demotion to RFC-15) and closes RFC-15's own six open questions in the same pass.

The design tracks three decisions already made in adjacent responses:

- **RFC-17 bedrock:** forks are reversible, standing decays, non-bedrock parameters have TTL. Demotion and flag-decay behaviors in this response honor those.
- **RFC-13 two-layer split:** standing is a network-level signal; membership is a community-level decision. Flags and demotions split the same way.
- **RFC-01 "tool suggests, human decides, reason recorded":** attestation-farming defense via countersignatures carries forward here as procedural defenses against flag-farming.

---

## Core principle

**Match the procedure to the harm.** Cryptographic facts route through a direct path. Social judgments route through cross-community agreement. Community-scoped harms stay community-scoped. The protocol specifies the procedures; humans make the judgments inside them.

That principle lets every question below resolve to a path rather than a formula.

---

## Answers to the Open Questions

### Q1. Who can flag, and with what weight?

**Two-class reporting. Reports from Preliminary/Soft DIDs are informal signals; formal flags require Established standing.**

The hard problem RFC-15 has to solve is separating reporting-as-feedback from flagging-as-formal-action. Mixing them lets new accounts mass-report; splitting them too strictly excludes real complaints from newcomers.

- **Reports** (Preliminary, Soft): standing-weighted, accumulate in the flagged DID's history, visible to community governance and to the network-level review process, but do **not** by themselves count toward the multi-community threshold (Q6a) or trigger automatic consequences.
- **Formal flags** (Established only): standing-weighted, count toward the multi-community threshold, trigger the procedural paths in Q2.

**Why two classes:** reports let newcomers surface problems without giving brand-new accounts the ability to trigger network-level actions. The information flows; the authority doesn't.

**Why standing-weight either class:** uniform weight invites Sybil amplification. Standing-weighted means a 3-year Established DID's flag carries more than a 2-week Established DID's, which raises the cost of spinning up thin accounts to flag-farm.

### Q2. What's the consequence scope for a flag?

**Severity determines scope. Single-community formal action is bounded to yellow/amber tier; red tier and permanent consequences require network-level process.**

RFC-15 proposes tiered consequences (yellow / amber / red / permanent). Q2 asks who can assign which tier.

| Tier | Who can assign | Effect |
|---|---|---|
| Yellow | Single community governance | Visible within that community; light restrictions per community rules |
| Amber | Single community governance | Restricted participation within that community; visible flag on profile within that community's view |
| Red | Network-level process only (multi-community threshold or severe-act direct path) | Network-visible flag; contributes to demotion review |
| Permanent | Network-level process only, after demotion + appeal exhausted | Network-wide |

**A single community cannot unilaterally escalate to network-level consequences.** The paths to red/permanent are the multi-community threshold (Q6a) and the severe-act direct path (Q6b), not "community X applied a red flag." This is the same principle as RFC-13's two-layer split: community decides community-scope consequences; network decides network-scope consequences.

**Why not let communities apply red directly:** any captured or small community becomes a network-level attack vector. A network-level consequence needs a network-level procedure.

### Q3. Flag decay

**Hybrid decay: time floor by tier, then combined time + positive-attestation decay. Red tier requires formal review for decay. Fully-decayed flags remain visible for context.**

| Tier | Time floor before decay begins | Decay rule after floor |
|---|---|---|
| Yellow | 6 months | Time + positive-attestation combined |
| Amber | 12 months | Time + positive-attestation combined |
| Red | 24 months | Formal review required; does not auto-decay |

**What "combined" means:** after the time floor, decay progresses as a function of both elapsed time and the flagged DID's positive-attestation accumulation in the interim. Someone who sits inactive doesn't decay on time alone; someone who re-engages constructively decays faster than time alone would give them. This is the flag-side parallel to RFC-13's "milestones don't decay" rule — positive behavior counts cumulatively, negative consequences erode with demonstrated change.

**Why formal review for red:** red-tier flags are network-level and reflect serious judgment. Letting them auto-decay — even with positive-attestation gating — undermines the weight of the original finding. A formal review matches the formality of the path that produced the flag.

**Visibility of decayed flags.** Fully-decayed flags are not deleted. They remain visible in the DID's history as context. They do **not** count toward the multi-community threshold (Q6a) and do not contribute to new demotion reviews. They exist for readers who want to understand the full history.

**Why keep decayed flags visible:** erasure breaks RFC-17 bedrock (forks reversible, history preserved). Decay reduces the *weight* of a flag; it doesn't reduce its *existence*.

### Q4. Brigading defense

**Procedural defenses over algorithmic ones. The structural rules in Q1/Q2/Q6a combined with two additional procedural gates do the work without graph-analysis machinery.**

The brigading attack RFC-15 worries about: coordinated actors flag-spam a target across multiple communities to trigger threshold demotion.

**Existing structural defenses already in place from other answers:**

- Multi-community threshold with independence test (Q6a) — coordinated communities fail the independence check
- Severity scope split (Q2) — no single community can unilaterally escalate to red
- Two-class reporting (Q1) — brigading requires Established-tier accounts, not just new signups
- Standing-weighted flag weight — thin accounts dilute themselves

**Additional procedural defenses:**

- **Community-level flags require community governance action, not individual action.** An Established DID can't unilaterally apply a yellow flag to someone on behalf of their community; the community's governance procedure (per RFC-17 size-scaled modes) has to ratify it. This raises the cost of community capture as an attack — you have to own a community's governance, not just hold an account in it.
- **Appeal-first timing on amber-and-above formal flags.** When a formal flag at amber or above is applied, the flagged DID has a 7-day response window before the flag's effects become publicly visible beyond the flagging community. They can respond, dispute, or accept. The flag still exists during the window; its effects are held.

**Why procedural over algorithmic:** graph-based collusion detection (clustering flaggers by interaction patterns) sounds clean but gives the protocol a false-precision problem. The detector will make mistakes, and its mistakes will disproportionately hit legitimate coordinated action (a valid multi-community concern looks a lot like brigading at the graph level). Procedural defenses are legible — participants understand them, attackers know the rules they're trying to evade, good-faith coordination isn't mistaken for attack.

### Q5. Voucher accountability — visibility

**Raw track record on profile. No computed voucher score.**

When someone you vouched for is later flagged or demoted, the consequence to you has two layers:

- **Standing adjustment.** Your own standing dips, with the size of the dip scaling to the severity of your vouchee's outcome (yellow < amber < red).
- **Visibility.** Your profile displays plain counts: "Vouched for N people — K in good standing, J flagged (by tier)." No formula, no score, no ranking.

**Why raw counts and not a score:** the moment the system reduces vouching history to a number, the number becomes the target. Same reasoning as RFC-13 Q3's decision to avoid milestone counters on user profiles. Counts are harder to compare across people (12-vouches-1-flag ≠ 3-vouches-0-flags in any directly-comparable way), which is a feature — it keeps readers having to judge the context rather than a leaderboard.

**Why standing adjustment regardless:** vouching without consequence is free, and free vouching is Sybil fuel. The standing adjustment is the protocol-level cost; the visible counts are the social-level legibility.

### Q6. Network-level demotion specification (inherited scope from RFC-13 Q4)

RFC-13's response said the specifics of network-level demotion live here. Four sub-items:

#### Q6a. Multi-community flag threshold

**Fixed 3 communities, plus an independence test.**

Three unrelated communities with independent governance having formal red-tier flags (or accumulated amber flags reaching a severity threshold) triggers a network-level review. The count stays at 3 regardless of network size — the real attack is coordinated communities wearing different hats, not insufficient count.

**Independence test.** Three flagging communities must pass:

- No shared primary controllers in their governance chains
- Membership overlap below a bounded fraction (target: <25%, tunable via protocol governance)
- No common governance parent in their fork ancestry

**Why not scale the count to network size:** proportional formulas create a moving target — a DID that was "safe" yesterday can become at-risk tomorrow just because the denominator shrank. Keeping 3 stable means the bar is predictable. The independence test is what grows teeth with network scale.

**What's left to specify in RFC-15 itself:** the exact independence test thresholds, how the membership-overlap fraction is computed, how governance-chain ancestry is traced. This is the main new specification RFC-15 adds beyond closing the open questions.

#### Q6b. Severe-act direct path

**Cryptographic misconduct only. Off-chain harms route through the multi-community threshold (Q6a).**

Severe-act directly triggers network-level demotion without waiting for threshold:

- **Signature forgery** — forged JWS attributable to a DID's key material
- **Key theft** — established via dispute where prior-key signatures prove ownership of pre-theft history
- **Deliberate attestation manipulation** — demonstrable falsification of attestation payloads or chain anchors

All three are facts the protocol can verify on-chain without social judgment.

**Off-chain harms (fraud, abuse, stalking, etc.) are not on the severe-act list.** They route through Q6a. This is the hardest line to hold in practice — real victims will want faster response — but the alternative is a severe-act lane that gets weaponized by any community willing to declare "this is severe."

**The protective compensation:** community-level flags and community-level removals happen immediately under Q2. The target stays network-Established until the threshold is met, but affected communities aren't forced to keep interacting with them during that period. The slower network-level path is about not letting a single community's judgment unilaterally reshape the network's standing signal.

#### Q6c. Appeal body composition

**Opt-in appellate pool, random-draw per case, invited non-voting advisors allowed, 1-year TTL on pool membership.**

- **Pool.** Established DIDs self-nominate as willing to serve on network-level appeals. Pool membership is public. Members opt back in annually; inactive members roll off.
- **Draw.** Per appeal, 7 panelists are randomly selected from the pool, excluding: members of flagging communities, members of the petitioning community, anyone who filed flags in the case, the flagged DID's direct vouchers.
- **Advisors.** The drawn panel may invite up to 2 non-voting advisors with relevant expertise (cryptographic forensics for severe-act cases, community governance experience for threshold cases). Advisors explain; panel decides.
- **Decision rule.** Simple majority of the 7.

**Why not a fixed elected council:** fixed councils attract capture. The protocol's whole shape is "no permanent power centers"; a permanent appeals council would violate that.

**Why not pure random jury:** randomly-drawn members without opt-in are more likely to ignore the case or rubber-stamp. Opt-in filters for people who actually want to do the work.

**Why invite advisors:** some appeals hinge on technical evidence a random panel won't follow. Non-voting advisors preserve the "experts inform, panel decides" split — because "expert" is exactly what a captured-council attack would claim.

**Why TTL on pool:** prevents the pool from ossifying into a de facto permanent body. Annual opt-back-in keeps it fresh.

#### Q6d. Rebuild path for demoted DIDs

**Extended floor plus Established-DID vouching. Scales by demotion type. Appeal-success and repeat-demotion edge cases handled.**

| Demotion type | Extended floor | Vouching requirement |
|---|---|---|
| Multi-community threshold | 90 days from demotion | 3 Established DIDs, none of whom were flaggers |
| Severe-act direct | 180 days from demotion | 5 Established DIDs, none of whom were flaggers |

After the floor, normal RFC-13 milestones apply on top of the vouching requirement. Attestation history is preserved (RFC-17 bedrock); it provides context but doesn't count toward rebuild.

**Why vouching rather than time-alone:** milestones are attestations, and attestations can be farmed — the same gaming problem RFC-01 Q5 and RFC-17 Q5 address elsewhere with countersignature defenses. Vouching is the equivalent defense here: someone has to stake their own standing on this person being safe to re-Establish, and that staking is visible via Q5's raw-counts mechanism.

**Edge 1 — appeal succeeded.** If the original demotion is overturned on appeal, the rebuild path does not apply. Full Established status is restored as of the demotion date. Attestation history during the demoted period is preserved and counts forward.

**Edge 2 — repeat demotion.** For a DID demoted-then-rebuilt-then-demoted-again, the extended floor compounds (2× base: 180 days for threshold, 360 days for severe-act) and the vouching requirement increases by 2 (5 for threshold, 7 for severe-act). Otherwise the rebuild path is a laundry cycle.

**Vouching counts (3/5) are empirical starts.** Real calibration waits for observation of actual cases.

---

## What this leaves open

Five things this response deliberately does not resolve:

1. **Independence test specification.** Q6a specifies that flagging communities must be independent, but the exact membership-overlap threshold, shared-controller detection algorithm, and governance-ancestry-tracing rules are sketched rather than defined. This is the main new specification RFC-15 needs to add. Concrete work item.

2. **Empirical calibration.** Voucher counts for rebuild (3/5/7), time floors for rebuild (90/180 days) and decay (6/12/24 months), and the amber-accumulation-reaching-red threshold are starting values. All need calibration against real usage. Starting conservative (higher bars) is safer than starting loose.

3. **Minimum appellate pool size.** The random-draw-7 mechanism in Q6c requires a pool large enough to reliably exclude flaggers and still draw 7. Below ~30 opt-in members, the draw may not be viable; fallback to full-pool review in that regime. Protocol needs to handle the early-network period before the pool reaches critical mass.

4. **Community-level appeal paths for yellow/amber.** Q6c specifies the network-level appeal body. Community-level flag appeals (for yellow/amber flags applied by single communities) are not specified here — they're community-governance-scoped and sit with RFC-17 or RFC-07. Each community decides its own appeal mechanism for its own flags, but minimum-guarantee requirements may be worth adding to RFC-17 bedrock later.

5. **Standing-weighted flag weight formula.** Q1 and Q2 both depend on standing-weighting the flag's impact. The formula — how much a flag from a 3-year Established DID weighs relative to a 2-week Established DID — isn't specified here. Lives adjacent to the RFC-13 standing-computation work.

---

## Anchor to existing work

- **RFC-13 response (our Q4):** RFC-15 inherits the four-part demotion specification. Q6a/b/c/d here close what RFC-13 deferred.
- **RFC-17 response (our bedrock):** forks-reversible, standing-decays, TTL-on-non-bedrock shape decay behavior (Q3), appeal mechanics (Q6c), and rebuild path (Q6d). Demotion decisions carry TTL per bedrock item 3.
- **RFC-01 response (our Q5):** "public auditability + countersignature" is the same defense pattern used here for vouching accountability (Q5) and community-level flag ratification (Q4). Farming attacks require visible on-chain collusion.
- **Current shipped state:** `auth.identities`, `attestations`, `flags` (if present) tables provide the substrate. What this response adds to the roadmap: flag-tier state machine, decay computation, appellate pool registry, rebuild-path gating. None of these are kernel-level primitives — they fit the userspace/kernel split in RFC-19.
