# RFC-13 Response: Progressive Trust Model

**Responding to:** [RFC-13 — Progressive Trust Model](https://github.com/ima-jin/imajin-ai/blob/main/docs/rfcs/RFC-13-progressive-trust-model.md)
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/271
**Related:** RFC-07 (Cultural DID), RFC-15 (Trust Accountability), RFC-17 (Governance Primitive), #244 (Delegated App Sessions)
**Author:** Greg (kimaris@gmail.com)
**Status:** Draft response for community discussion

---

## Framing

RFC-13 is my original proposal from March 2026 ("Entering the Network"), refined with Ryan. The four open questions at the end are ones I left for future resolution. This response closes them, consistent with the decisions in our RFC-17 response (governance bedrock, sovereignty within invariants).

The existing comment on #271 (from imajin-jin) clarifies that Preliminary DIDs can accept inbound connections from Established DIDs and message within those — they just can't extend trust outward. That framing ("inbound trust yes, outbound trust no") is the right way to think about the Preliminary phase and is assumed throughout.

---

## Core principle

**Standing is a network-level signal; membership is a community-level decision.** Those are different axes and they need to be answered differently. Most of the open questions resolve cleanly once that split is explicit.

---

## Answers to the Four Open Questions

### Q1. Milestone thresholds — network-wide defaults or per-Cultural-DID configurable?

**Two-layer. Network-level thresholds are protocol-set; community membership criteria stack on top and are community-configurable.**

RFC-13 conflates two distinct questions:
- When does a Preliminary DID become **network-Established** (unlocking vouch/create/governance capabilities that live at the network layer)?
- When does a DID become a **member of community X** (satisfying X's specific bar for joining)?

These need different answers.

**Network-level milestones (Preliminary → Established)** are protocol-set. "Established" should mean the same thing across the entire network — otherwise the signal is useless for cross-community trust. Protocol defaults start as something like: N verified interactions with existing Established DIDs, N event attendances, N days on network (see Q2), zero unresolved flags. Over time, these are tunable via protocol-scope governance (RFC-17's constitutional tier applied to the protocol's own parameters). The specific Ns are empirical — needs observation of real behavior to calibrate.

**Community membership** is a separate axis and fully community-configurable. An artist collective has different membership criteria from a DAO managing treasury funds. Communities can set arbitrary additional requirements — "attend three listening sessions," "be vouched by a current member," "hold X standing in a related community." These requirements are layered on top of network-level Established status, not a substitute for it.

**Practical consequence:** a network-Established DID can show up in a new community as an unknown-to-that-community person whose *Established* status is legible but whose *membership* has to be earned separately. That split keeps both signals honest.

### Q2. How long is the onboarding period — fixed or variable?

**Hybrid with a 14-day floor, no hard ceiling, and soft-sunset to Soft at 12 months of inactivity.**

**Floor.** 14 days from registration is the minimum period before Established is possible, regardless of how fast milestones are met. This is the anti-rush protection — you can't become Established within 24 hours of registration by frantically farming attestations. Calendar time, not active time; inactivity doesn't reset the clock.

**No hard ceiling.** Graduation happens whenever milestones are met within the floor-or-later window. Someone who participates slowly over 6 months legitimately reaches Established the day their milestones complete, not sooner and not later. Staying Preliminary indefinitely is a valid state, not a failure.

**Milestones don't decay.** Verified interactions, event attendances, and other attestations are cumulative. Someone who joins, does 2 events, disappears for 3 months, and returns retains those 2 events toward their milestone count.

**Soft-sunset at 12 months of inactivity.** A DID that has accumulated zero new attestations for 12 months is reverted to Soft. This isn't a punishment for slow movers; it's reclamation of abandoned accounts. Returning after a sunset means re-registering keypair attachment but keeping the existing DID string and history.

**Why not fixed:** treats dissimilar cases as the same. High-velocity users held back for no reason.

**Why not pure variable:** losing the floor loses the anti-rush property; there's no principled stopping point short of the floor.

### Q3. Should preliminary DIDs see that they're in an onboarding phase?

**Ambient tier visibility, no progress bars, contextual disclosure when users hit capability walls.**

**Ambient.** The profile plainly shows the user's current tier (Visitor / Resident / Host). A help page explains what each tier does. Hiding standing from the user would be patronizing — it's a real fact about them that the system already knows.

**No progress bars, no milestone counters.** Turning onboarding into a skill tree corrupts the thing being measured. If the system shows "3/5 verified interactions complete," users start optimizing for the metric rather than the underlying behavior. Goodhart's law applies immediately. The milestones exist to be *evidence*, not *targets*.

**Contextual disclosure at walls.** When a Resident (Preliminary) taps "create event," they see a friendly explanation: *"Creating events is for Hosts — it happens after someone vouches for you and the network has come to know you. No timeline on this; it's a byproduct of being part of things."* That last phrase matters: **framing graduation as a byproduct of participation rather than a goal to achieve** is the whole tone the protocol is trying to set.

**Why not fully transparent dashboard:** gamifies trust-building; creates "second-class user" feel; distorts behavior toward metrics.

**Why not fully invisible:** surprises everywhere; hard to explain the system; withholding standing from users feels like the protocol thinks it knows better than they do.

### Q4. Can an Established DID be demoted back to Preliminary?

**Yes, but only through explicit governance action with multi-trigger safeguards and appeal rights. Specifics live in RFC-15.**

From Q1 above, two kinds of demotion are possible:

- **Community-level exclusion** — person is removed from community X's member list but remains network-Established. Handled by community governance (RFC-17 bedrock: decisions TTL, forks reversible). Per-community configurable. Not the open question.

- **Network-level demotion** — Established DID drops to Preliminary in the network overall. This is the serious one. The answer:

**Network-level demotion is possible, through any of three trigger paths:**

1. **Multi-community flag threshold.** 3+ unrelated communities (with independent governance) have formally flagged the DID. Triggers a formal network-level review.

2. **Severe-act direct path.** Confirmed fraud, abuse, or cryptographic misuse (key theft, signature forgery, deliberate attestation manipulation). Direct demotion path — immediate effect, appeal available.

3. **Cross-community petition.** A specified fraction of Established DIDs petition for review. Triggers the review process.

**Safeguards:**

- All paths include appeal rights. The appealing body excludes the petitioners and flagging communities.
- Demotion decisions carry TTL (suggested: 1 year) and expire unless re-ratified.
- Reversibility is bedrock (RFC-17). A demoted DID's attestation history is preserved; they can rebuild to Established through normal milestones.

**Why this shape:** automatic threshold-based demotion is the exact weaponization attack surface the protocol must avoid — coordinated bad-faith negative attestations could take down legitimate Established DIDs with no recourse. Requiring multi-community involvement and/or severe-act confirmation raises the cost of bad-faith attacks above what any single community or small coalition can mount.

**Why demotion has to exist:** without it, bad actors who reach Established stay there as a network-level signal indefinitely. Individual community exclusion doesn't propagate across the network. "Established" becomes increasingly noisy as a signal, eroding the whole point of the tier system.

**Scope added to RFC-15:** the specifics of the multi-community threshold (3? 5? proportional to network size?), the severe-act list, the appeal body composition, and the rebuild path all live in RFC-15. Our RFC-15 response will close those.

---

## What this leaves open

1. **Protocol-scope governance doesn't exist yet.** Network-level threshold tuning (Q1) and the governance-primitive decisions behind the three demotion trigger paths (Q4) assume a protocol-scope governance mechanism that RFC-17 describes in principle but hasn't been instantiated. Until it exists, these parameters are whatever Ryan/Jin decide.

2. **The specific Ns in Q1 are empirical.** 3 verified interactions? 5? 2 event attendances? These need calibration from actual usage data, which doesn't exist yet. Starting conservative (higher Ns) is safer than starting loose — it's easier to lower the bar than raise it.

3. **Community membership revocation semantics.** Q1 says community-level exclusion is community-governed and per-community configurable. But there are questions underneath: can a community partially exclude (read-only member)? Can exclusion be appealed? These live in RFC-07 (Cultural DID) and RFC-15 rather than here.

---

## Anchor to existing work

- **Current shipped state:** `auth.identities` table already supports the three-tier computation. Standing is queryable. What's missing is the specific milestone thresholds (Q1) and the UX for contextual disclosure (Q3).
- **RFC-17 response (our Q4):** the three-item bedrock (forks reversible, standing decays, non-bedrock has TTL) is what makes demotion work correctly. Demotion is reversible because forks are reversible; demotion decisions have TTL because non-bedrock parameters have TTL.
- **RFC-15:** absorbs the specifics of the demotion mechanics (trigger thresholds, severe-act list, appeal body, rebuild path). This RFC-13 response sets the frame; RFC-15 fills it in.
- **imajin-jin's comment on #271:** the "inbound trust yes, outbound trust no" framing for Preliminary DIDs is the right mental model and is assumed throughout this response.
