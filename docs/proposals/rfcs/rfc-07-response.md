# RFC-07 Response: Cultural DID

**Responding to:** [RFC-07 — Cultural DID](https://github.com/ima-jin/imajin-ai/blob/main/docs/rfcs/RFC-07-cultural-did.md)
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/252
**Related:** RFC-08 (Org DID), RFC-11 (Embedded Wallet), RFC-13 (Progressive Trust), RFC-15 (Trust Accountability), RFC-17 (Governance Primitive), RFC-22 (Federated Authentication), RFC-01 (.fair Attribution)
**Author:** Greg (kimaris@gmail.com)
**Status:** Draft response for community discussion

---

## Framing

RFC-07 is my March 2026 proposal for a Cultural DID primitive — identity for collectives, scenes, and communities of practice. The April 7 forest infrastructure sprint then shipped `scope: 'community' | 'org' | 'family'` group identities with real keypairs, service-scoped permissions, and multi-controller access. This response reconciles the RFC-07 proposal with what's already shipped and closes the eight open questions at the end of the RFC.

The answers compose cleanly with our responses to adjacent RFCs:

- **RFC-17** bedrock (forks reversible, standing decays, non-bedrock has TTL) shapes the dissolution, cross-node-stewardship, and dispute-resolution answers.
- **RFC-13** two-layer split (network standing vs. community membership) is inherited here — formation thresholds use network-level standing; membership decisions sit with the collective.
- **RFC-15** tiered accountability provides the integrity-deadlock path and the disqualifier rule on red-tier flags.
- **RFC-01** "tool suggests, human decides, reason recorded" carries into .fair attribution policy.

---

## Core principle

**Cultural identity is an opt-in declaration, not an imposed category.** The protocol supplies infrastructure that makes the declaration meaningful — formation threshold, governance shape, treasury tiering, attribution options, cross-node stewardship — and keeps the posture reversible at every turn. Collectives adopt the Cultural layer because it fits; they relinquish or fork when it no longer does; nothing is permanent except history.

---

## Answers to the Eight Open Questions

### Q1. Substrate relationship — new primitive or layer on existing community forest? (RFC-07 Q5)

**Cultural DID is an opt-in policy layer on `scope: 'community'` forests. Not a new scope.**

The April 7 forest infrastructure already provides the substrate: group keypair, multi-controller access, service-scoped permissions, membership roster, contextual onboarding. Adding a parallel `'cultural'` scope would double the plumbing (queries, permissions, UI, federation) for no clear gain.

Instead, the Cultural layer is attested by adopting a signed covenant at formation. A `scope: 'community'` forest that has published the Cultural covenant attestation is a Cultural DID. A community forest without it is a plain community — looser defaults, no Cultural constraints.

**Mid-life transitions.**

- A plain community forest can adopt the Cultural covenant later, provided it meets formation requirements (Q2/Q3) at the moment of adoption.
- A Cultural DID can shed the layer through the governance action defined in the covenant itself (default: constitutional-tier amendment per RFC-17), or via fork.
- Both transitions preserve chain history per RFC-17 bedrock.

**Why not a fourth scope (A):** the substrate is the same; only the policy differs. Double substrate for policy variation is exactly the thing to avoid.

**Why not narrowing `'community'` to mean Cultural (C):** retroactively redefines live community forests that were never intended as Cultural.

**Why not a `type` discriminator (D):** the covenant attestation is already the type signal. An additional field is redundant unless queryability demands it — flag as follow-on if indexing turns out to matter.

### Q2. Founding member count (RFC-07 Q1)

**Floor of 3 founding Person DIDs. Combined trust-weight gate scales inversely with count.**

Raw count is a proxy for "real collective, not a shell." The real signal is founders' combined seriousness. Fixing count at 5 or 7 rejects legitimate trios; lowering to 2 opens the door to pseudonym-pairs. Making count a floor and trust-weight the real gate handles both ends.

- **Floor: 3 founding Person DIDs**, never less. Three is the smallest structurally-collective unit — pluralism beyond a pair.
- **Combined trust-weight scales inversely with count:**
  - At 3 founders: threshold ≈ 2× base
  - At 5 founders: threshold ≈ base
  - At 7+ founders: threshold slightly softer than base (strength-in-numbers counts, but the main signal stays trust-weight)

A deeply-attested trio with 20-year .fair histories passes the gate. Five thin accounts co-signing each other's attestations fail it. Count doesn't bend; the bar does.

### Q3. Token context threshold values (RFC-07 Q2)

**Shape specified in the RFC; specific numbers deferred to protocol governance.**

The threshold structure:

- **Primary gate:** sum of founders' standings, weighted by Q2's inverse-scaling factor, must exceed `T_formation`. `T_formation` calibrated empirically; starting conservative (high) is safer than starting loose.
- **Hard minimums per founder (not averaged):**
  - ≥ **90 days active on network** — anti-rush. Matches the spirit of RFC-13's 14-day Preliminary floor but longer because Cultural formation is more consequential.
  - ≥ **K `.fair` contributions** — ensures each founder has demonstrated contribution, not just social standing. K starts small (≈3) and tunes with observation.
- **Disqualifier:** no outstanding red-tier flags on any founder (per our RFC-15 response).

**Why standing as the primary input:** RFC-13 already spec'd standing to be the network's "real and participating" signal. Cultural formation piggybacks on it rather than inventing parallel math. Tuning standing tunes both.

**Why per-founder minimums on days-active and `.fair` contributions:** averaged standing can be gamed by one high-standing founder carrying five thin co-founders. Per-founder hard floors force each member to be individually real.

**Why defer specific numbers:** pre-empirical calibration is guessing. Starting with the shape and letting real formations inform numbers is the same playbook used for RFC-13's milestone counts. Protocol-scope governance (RFC-17) tunes the values.

### Q4. Dissolution mechanics (RFC-07 Q3)

**180-day grace window → member-directed choice between demote (default) or hibernate (opt-in). No outright dissolution path.**

Outright dissolution violates RFC-17 bedrock — chain history is referenceable by other DIDs (attestations, vouches, `.fair` records) and cannot be deleted. What can end is the *Cultural claim*, not the forest itself.

- **Grace window: 180 days below formation threshold.** Tighter than RFC-13's 12-month inactivity-sunset because Cultural status carries stronger claims. During the window the Cultural layer remains active but the forest shows an ambient "below formation threshold" status on its public face (same legibility principle as RFC-13 Q3).
- **Within the window, remaining members choose:**
  - **Demote (default path):** forest continues as `scope: 'community'` without the Cultural covenant. Treasury held by the community-scope forest under fallback rules.
  - **Hibernate (opt-in):** DID dormant. Treasury frozen — no new spending. Existing multi-sig-signed recurring obligations continue to flow. Reactivation requires re-meeting formation threshold and re-attesting covenant.
- **Window-end default: auto-demote.** If remaining members take no action, the less-restrictive path wins. Demote is reversible via Q1's mid-life adoption. Hibernate is weightier and requires affirmative choice.

**Treasury during hibernation:** frozen state is the trade for preserving reversibility. Indefinite hibernation leaves funds frozen until reactivation. Collectives can choose demote instead if continuity of operations matters more than the sealed-waiting posture.

### Q5. Treasury management (RFC-07 Q4)

**Tiered by amount. Signer rotation tracks governing-member changes. No emergency bypass.**

- **Small operational tier (< X):** 2 governing members sign. Covers recurring bills, small stipends, operational costs. X defaults at formation to the smaller of 5% of current treasury balance or a fixed floor (≈500 CHF-equivalent / 500 MJNx).
- **Normal tier (X to Y):** trust-weighted governance quorum per RFC-07's governance model. Covers most spending decisions.
- **Large tier (> Y):** supermajority — governance quorum plus a standing-weighted threshold above normal quorum. Covers treasury-emptying acts, large grants, exceptional commitments. Y set in covenant per collective.
- **All tiers execute via multi-sig wallet** — RFC-11 Embedded Wallet for MJN, plus Stripe/Solana settlement infrastructure.

**Signer-set rotation:** when governing members change, the multi-sig signer set updates. Each rotation is itself a governance-quorum decision, not a small-operational act.

**No emergency bypass.** The small-operational tier already handles "need to pay this now." Lower-threshold emergency paths are where capture events happen.

**Dual-denomination (MJN + MJNx):** same tiered structure applies to both. MJN's protocol-level lock-ups per RFC-12 apply independently.

**Why not same-as-governance (A):** procedural decisions that don't touch money shouldn't require spending-tier quorum.

**Why not uniformly-higher-than-governance (B):** paralysis on small spends. The operational tier exists to prevent exactly that.

**Why not role-specialized (D):** optional treasurer roles are fine at the community level but shouldn't be RFC-mandated. Communities that want elected treasurers layer that on top of C in their covenant.

**What's deferred:** starting defaults for X and Y are empirical — depends on expected collective treasury sizes, which doesn't exist yet. Covenant language: "defaults TBD, adjustable at constitutional tier."

### Q6. `.fair` attribution splits within the collective (RFC-07 Q6)

**Collective-configurable at covenant. Default: `hybrid(10)`.**

Different collectives legitimately want different attribution policies. An art collective publishing distinct works wants per-work attribution. A sound healing lineage where every session is "the lineage's practice" wants standing-ratio. An event-producing collective wants both — specific contribution plus stewardship credit. A single mandated policy fails the reality test.

**Policy options (declared in covenant):**

- `per_work` — every sidecar declares contributors and shares explicitly. Maximum accuracy.
- `standing_ratio` — splits follow members' standings at publication time. No per-work overhead.
- `hybrid(residual_pct)` — declared per-work share of `(100 − residual_pct)%`, standing-ratio pool of `residual_pct%`. Default `residual_pct = 10`.

**Every sidecar identifies the policy applied** so downstream settlement can compute correctly without re-deriving context.

**RFC-01 alignment:** the person closing the work declares the final split. Under standing-ratio, the standing-derived split is the RFC-01-style suggestion; overrides require a reason. Under per-work, the closer's declaration stands alone. Under hybrid, the per-work portion follows RFC-01 override-with-reason; the pool portion distributes automatically by standing.

**Invariants (regardless of policy):**

- All attribution records are signed RFC-01-style sidecars. Policy choice doesn't let collectives skip the sidecar.
- Policy change is a constitutional-tier covenant amendment per RFC-17 — deliberation, TTL, reversible. Not ad-hoc.
- Standing used for ratio/pool computation is standing *at the moment of publication*, not any later time. Locks attribution against retroactive manipulation.

**Why `hybrid(10)` as default:** the 90/10 hybrid handles the most common case — specific contributors made a specific work, and the collective's ongoing stewardship (facilitation, venue, brand, infrastructure labor) contributed to the conditions that made it possible. Collectives wanting pure per-work set residual to 0; pure standing-ratio set residual to 100.

### Q7. Cross-node Cultural DIDs (RFC-07 Q7)

**Steward-node model with governable transfer. Federation registry carries canonical state refs.**

- **At formation: steward node = registrant's node.** Cultural DID keypair and authoritative state (membership roster, governance decisions, treasury state, attestation chain) live there.
- **State changes published to the federation registry.** Other nodes fetch canonical state, verify signatures against the Cultural DID's advertised key, cache for their members' UX. Registry is discovery/verification; steward node is writes.
- **Stewardship is governable.** The collective can transfer stewardship to another node via constitutional-tier governance (same threshold as covenant amendment). Transfer use cases:
  - Original registrant leaves the collective
  - Steward node becomes unreliable or goes dark
  - Collective outgrows an individual's node, moves to dedicated infrastructure
  - Jurisdictional risk rebalancing
- **Stewardship transfer is a signed, chain-recorded act.** Old steward signs relinquishment; new steward signs acceptance. Registry updates the canonical reference. Transfer lineage is readable.
- **Member interactions are federated.** Members on other nodes sign actions on their own nodes using their own keys, submit signed payloads to the steward node for integration. Authentication flows via RFC-22.

**Edge — steward node unresponsive.** If the steward node fails to respond to legitimate operations for 30 days, remaining governing members can initiate emergency stewardship transfer from their home nodes using last-known registry-cached state as starting point. Lower threshold than normal transfer (simple majority of governing members) because the collective is in duress. This is the single "emergency" path the RFC carries — the single-node-host failure mode would otherwise make collectives brittle forever.

**Why not full replication (B):** authoritative replication across all members' nodes means consensus-on-every-action. Governance decisions that wait for quorum are fine; simple membership reads aren't.

**Why not home-node-only (A):** binds the Cultural DID to the registrant forever. If registrant leaves or node dies, collective is stranded.

**Why governable transfer:** keeps the node-host relationship accountable to the collective, not imposed on it. The collective chooses its substrate as conditions change.

**What's deferred:** the federation-registry schema for Cultural DID state (what gets published, at what granularity, signed by whom) is infrastructure spec — sits with RFC-22 or a dedicated cross-node state RFC.

### Q8. Dispute resolution at quorum deadlock (RFC-07 Q8)

**Hybrid tiered by decision type. No tiebreak rule imposes a winner — ever.**

RFC-07's "no unilateral control" invariant extends to procedural design. Rules like "oldest member wins ties" or "highest-standing wins ties" are concentrated authority in disguise. Deadlocks resolve by conversation, external perspective, or fork — not by rule.

- **Ordinary procedural deadlocks: status quo wins.** If quorum can't pass a change — admission, procedural motion, operational decision — no change happens. Collective continues on existing rules. Handles the common case without imposition.
- **Structural deadlocks** (covenant amendment, stewardship transfer, large-tier treasury spend): first attempt fails → **30-day cooling-off with optional facilitated dialogue** (collective chooses whether to facilitate) → second attempt. If still deadlocked, governing members choose by simple majority between:
  - **External arbitration** via the RFC-15 appellate pool (same opt-in pool, random-draw-7, non-voting advisors). Panel gives a non-binding recommendation; collective can accept by simple majority.
  - **Orderly fork** per RFC-17 bedrock. Each faction forks its members into a successor Cultural DID. History preserved, reversibility intact. Treasury divides by standing-weighted split at fork time.
- **Integrity deadlocks** — one faction alleges the other is blocking in bad faith (vote-trading, conflict of interest, coordinated obstruction): direct path to RFC-15. Amber or red tier flag routes through the multi-community or severe-act machinery there. The real issue is conduct, not deadlock.
- **Fork is always available as a last resort.** Any governing member proposes; simple majority of governing members executes. Bedrock guarantees reversibility — forks can reunite if the fracture heals.

**Why not pure fork-first (C):** fork is weighty. Many deadlocks are procedural noise that cools off; routing those directly to fork breaks collectives unnecessarily.

**Why not pure arbitration-first (A):** external machinery for every deadlock creates governance overhead collectives don't need. Arbitration fits real structural fights.

**Why not time-alone (B):** two cooling-off periods still deadlocked means the disagreement is real, not procedural. Time alone defers, doesn't resolve.

---

## What this leaves open

Six things this response deliberately does not resolve:

1. **Covenant schema.** This response specifies that a Cultural DID is a `scope: 'community'` forest with an adopted covenant attestation. The covenant's concrete schema — fields, attestation format, versioning — is follow-on work. Likely sits adjacent to RFC-17 covenant-attestation work if that lands.

2. **Independence of the "community" scope semantics.** If the community scope remains the substrate for both plain communities and Cultural DIDs, some query/indexing surface may need to distinguish them cheaply. The covenant attestation is the type signal, but fast-path queries may want a column-level flag. Flag this if UI/indexing work surfaces the need.

3. **Empirical calibration of specific numbers.** `T_formation` (Q3), K (Q3's `.fair`-contribution minimum), X and Y (Q5 treasury tiers), residual percentage in hybrid attribution (Q6). All are starting values or shape-only specs; real numbers require observation.

4. **Governance-weight computation.** RFC-07 describes trust-weighted quorum but doesn't specify the formula. This response assumes combined standing (RFC-13 signal) weighted per-member feeds the quorum calculation but leaves the exact aggregation unspecified. Needs pairing with RFC-13's standing-computation spec.

5. **Federation registry schema for Cultural DID state.** Q7 depends on a registry substrate for cross-node state publication. The schema and write/read semantics sit with RFC-22 or a dedicated follow-on.

6. **Covenant template library.** A collective forming a Cultural DID needs to author a covenant. A starter library of covenant templates (art collective, mutual aid, lineage/practice, festival community, open-source project) would lower the authoring bar and create shared vocabulary. Community contribution rather than protocol spec.

---

## Anchor to existing work

- **April 7 forest infrastructure** — `scope: 'community' | 'org' | 'family'` group identities are the substrate. Cultural DID is the `'community'` scope with covenant layer. No new scope needed.
- **RFC-13 response (standing signal)** — Q2/Q3 formation thresholds use RFC-13 standing as the primary input. Tuning standing tunes formation.
- **RFC-15 response (accountability framework)** — Q3 disqualifier (no outstanding red-tier flags) and Q8 integrity-deadlock path both route through RFC-15 machinery.
- **RFC-17 response (bedrock)** — forks-reversible shapes Q4 (no dissolution), Q7 (stewardship-transfer), and Q8 (fork-as-last-resort). Standing-decays shapes the per-founder activity minimum in Q3.
- **RFC-01 response (attribution)** — Q6's per-work and hybrid policies inherit RFC-01's "tool suggests, human decides, reason recorded" pattern. Pool portion distributes automatically; declared portion follows override-with-reason.
- **RFC-11 (Embedded Wallet)** and **RFC-22 (Federated Authentication)** — Q5 treasury wallet primitive and Q7 cross-node authentication both depend on these. Cultural DID does not require them to ship first, but their maturity enables the full posture.
