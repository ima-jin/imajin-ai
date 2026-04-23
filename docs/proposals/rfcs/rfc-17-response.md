# RFC-17 Response: Governance Primitive

**Responding to:** [RFC-17 — Governance Primitive](https://github.com/ima-jin/imajin-ai/blob/main/docs/rfcs/RFC-17-governance-primitive.md)
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/410
**Related:** RFC-13 (Progressive Trust), RFC-14 (Community Issuance), RFC-15 (Trust Accountability), RFC-07 (Cultural DID), RFC-08 (Org DID)
**Author:** Greg / Tonalith (kimaris@gmail.com)
**Status:** Draft response for community discussion

---

## Framing

This response extends an earlier comment I posted on discussion #410 as Tonalith, which connected RFC-17 to Proposal 21 (Attentional Sovereignty) and the Browne & Watzl autonomy framework. That comment argued TTLs operationalize "reflective endorsement" and standing decay operationalizes anti-capture. This response builds on that and answers all five open questions at the end of RFC-17.

The answers converge on a single principle: **sovereignty within invariants.** Communities decide almost everything about their own governance — but three protocol-level invariants stay fixed, because they're what make the network coherent across communities.

---

## Core principle

Three protocol-level invariants, everything else configurable at constitutional tier:

1. **Forks are reversible** — attestation history cannot be erased by governance vote
2. **Standing decays with non-participation** — no absentee landlords
3. **Non-bedrock parameters have TTL** — no permanent power grabs within configurable space

Those three are the bedrock. Everything else — quorum formulas, tier TTLs, mode thresholds, deliberation periods, assist compensation, cross-community rules — is up to the community.

---

## Answers to the Five Open Questions

### Q1. Quorum bootstrapping

**Size-scaled quorum matching the existing governance-modes table, with equal weight for the first 30 days.**

The RFC's own "governance modes by size" table (line 72) already splits behavior by community size. Quorum follows the same split:

| Size | Quorum rule |
|---|---|
| 3–10 (informal consensus) | Every member must explicitly acknowledge the decision — explicit abstention counts as acknowledgment, silence blocks |
| 11–50 (weighted voting) | 40% of standing-weighted membership must vote |
| 50+ (formal governance) | 33% of standing-weighted membership must vote |

**Bootstrap:** For the first 30 days after a community DID is created, voting uses equal weight per member. After that, standing-weighted math kicks in. This solves the "nobody has standing yet" problem without freezing governance during the period the community probably most needs to adjust things.

**Why not fixed percentages everywhere:** small communities can't reliably hit percentages, and percentages at the small end would let 2 people pass things through low turnout. The explicit-acknowledgment rule for 3–10 is doing real work — it forces small-community decisions to be visible.

**Why not `max(percentage, floor)`:** false precision. The attacks that percentages-alone fails on all happen at small scale, and the explicit-acknowledgment rule already blocks those.

### Q2. Cross-community governance

**Bilateral negotiation for formal co-hosts; each community's own rules apply to its own members when negotiation fails or the interaction is informal.**

(Extending my earlier Tonalith comment on #410 with three edge-case refinements.)

**The main answer:** when two communities formally co-host an event, both ratify a negotiated parameter set scoped to the event, TTL'd to the event's duration. Default gravity back to each community's own governance when the event closes.

**Edge 1 — negotiation fails:** each community applies its own rules to its own members at the shared event. Not intersection, not union — each community stays sovereign over its own people. This accepts the weirdness of "different rules for different people at the same event" in exchange for letting collaboration continue without forcing agreement. Substantive co-hosts will negotiate; minor collaborations don't need to.

**Edge 2 — what counts as "sharing":** only formal co-hosting triggers bilateral governance. Listing another community's event in your calendar, cross-posting content, members attending as guests — none of those trigger bilateral. They're all "one community hosts, others participate under the host's rules." This keeps the bilateral mechanism scoped to the cases where both communities are actively shaping the context.

**Edge 3 — standing portability in the shared context:** home standing carries into shared contexts; both home chains are visible. Members show up with the reputation they carry. The philosophical alternative (shared-context-only standing) is cleaner but less honest — people do bring reputations with them, and making that legible in-chain is healthier than pretending it doesn't exist.

### Q3. Governance migration — in-flight votes and existing mandates

**In-flight votes continue in both forks independently. Existing mandates transfer by default with an accelerated re-ratification window.**

**In-flight votes.** When a community forks mid-vote, votes already cast carry with the voter into whichever fork they end up in. Each fork completes the vote within its own post-fork membership. Different forks can reach different outcomes on "the same" vote — and that's correct, because once forked, they're different communities.

**Why not cancel at fork:** makes forking a veto mechanism. Any losing faction kills the vote by leaving. Incentivizes strategic forking.

**Why not continue-in-parent-only:** creates a timing exploit — fork right before the vote closes to avoid being bound. Also invalidates the work of fork members who voted before leaving.

**Existing mandates.** Active mandates (decisions passed but still within their TTL) transfer to both forks by default. Each fork gets a **14-day accelerated re-ratification window** during which any active mandate can be cancelled by simple majority — no need to wait for the normal TTL to expire. After 14 days, mandates behave normally and expire on their original schedules.

**Why not transfer-with-normal-TTL:** if a fork happened specifically *because* members disagreed with a mandate, waiting out a 2-year constitutional TTL defeats the point of forking. The accelerated window handles that case directly.

**Why not mandates-stay-with-parent-only:** too much of a clean break. Forking ordinary operational disagreements shouldn't reset every decision the community has made.

### Q4. Constitutional amendments

**Three-item bedrock list. Everything else is constitutional-tier configurable.**

The bedrock:

1. **Forks are reversible.** Attestation history cannot be erased by governance vote. A community that leaves can return; the chain remembers.
2. **Standing decays with non-participation.** No absentee landlords. Founding cohorts can't ossify into permanent oligarchy.
3. **Non-bedrock parameters have TTL.** Even decisions made at constitutional tier must be re-ratified periodically. The meta-regress terminates at this rule — quorum formulas can be changed, but only under TTL.

**Everything else is up to the community:**

| Configurable at constitutional tier | Example |
|---|---|
| Tier TTLs | "Our constitutional mandates last 5 years, not 2" |
| Deliberation periods | "We vote 14 days on structural changes, not 7" |
| Quorum formula | "We use approval voting with 60% threshold" |
| Size-scaled mode thresholds | "Our formal governance activates at 25 members, not 50" |
| Adding new decision tiers | "We have a 5th tier above constitutional" |

**Why only three bedrock items:** these are the minimum set that makes cross-community interaction coherent. Reversibility is what makes "default gravity toward reunion" non-vacuous. Standing decay is what prevents early-cohort capture. TTL-on-everything is what prevents meta-regress into permanent rules. Everything outside these three can legitimately differ between communities without breaking the protocol's claims.

**Why not fully configurable (A):** a community that votes away reversibility is effectively opting out of the federation. If the protocol allows that silently, cross-community trust has no stable basis. Other communities can't reason about A's members if A might have irreversibly erased parts of A's chain.

**Why not layered-by-difficulty-only (C):** a motivated supermajority can still rewrite core assumptions. Defers rather than resolves the question.

### Q5. Assist compensation

**Protocol-level assist pool with opt-out.**

A small fraction of the protocol fee (suggested: 5% of the 1% protocol fee, parallel to the 10% dev pool in #633) routes to an assist pool. Distributions computed from assist attestations earned, with chain replay — same mechanism as the dev pool.

**Opt-out.** Default: assists receive pool distributions. Assists who want to keep their work civic-only can opt out globally or per-engagement. This respects people who genuinely want attestation-only while not making everyone else do volunteer labor by default.

**Why protocol-level rather than per-community:** per-community compensation puts the cost on exactly the communities least able to bear it — small, struggling ones that need assists most. A network-funded pool means well-capitalized communities effectively subsidize help for newer ones, which is how civic infrastructure actually works.

**Why compensation at all:** access-inequity is a real risk. If assistance is attestation-only, only people who can afford to volunteer become assists — which biases the pool toward existing resources. The adverse selection problem is that communities needing help most can't attract the best assists without compensation, while wealthy communities can. That's the exact inequity the protocol exists to address.

**Gaming defense:** assist attestations require the helped community to countersign. A farming attack requires collusion between assist and community, which is visible on-chain. Same defense pattern as RFC-01 Q5 — public auditability plus threshold co-signing for high-value attestations if abuse emerges.

---

## What this leaves open

Three things this response deliberately does not resolve:

1. **Bedrock-adjacent cases.** The three-item bedrock list may be too tight. Candidates that could plausibly belong (but that I'd keep out for now): countersignature requirement on attestations, the human-supersedes-agent/device default in RFC-17's Device Scope section, the fork-merge mechanic itself. These can be argued into bedrock later; starting tight is safer than starting loose and trying to add constraints after communities have built on the looser version.

2. **Pool size governance.** The "5% of the 1% protocol fee" for the assist pool is a placeholder. The pool's size, how it's tuned, and whether communities have any voice in that tuning are all unresolved. Probably lives in RFC-12 (token economics) rather than here.

3. **Cross-fork mandate resolution.** Q3 says mandates transfer to both forks with an accelerated re-ratification window. What happens if the two forks later merge back? Do they need to reconcile mandate states, or does the merge resolve to whichever fork's mandate is still active? Probably: reunions negotiate mandate state at merge-time, same bilateral mechanism as Q2. But this needs a worked example to be sure.

---

## Anchor to existing work

- **Earlier Tonalith comment on #410** — the Browne & Watzl / attentional-landscape framing. TTLs as reflective-endorsement mechanism, standing decay as anti-capture. This response operationalizes that framing into the five specific answers above.
- **RFC-13 (Progressive Trust):** standing computation feeds governance weight. The 30-day equal-weight bootstrap in Q1 is the transition period during which RFC-13's standing accumulation begins.
- **RFC-01 response (our Q5):** the "public auditability + threshold co-signing" pattern used here for assist-farming defense is the same pattern used there for dev-pool farming defense. Both rely on countersignature requirements making collusion visible on-chain.
- **#633 (dev equity pool):** the assist pool in Q5 follows the same structural pattern — fraction of protocol fee, chain-replay distribution, attestation-based accumulation.
