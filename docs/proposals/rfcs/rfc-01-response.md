# RFC-01 Response: .fair Attribution from Commit History

**Responding to:** [RFC-01 — .fair Attribution from Commit History](https://github.com/ima-jin/imajin-ai/blob/main/docs/rfcs/RFC-01-fair-attribution.md)
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/15
**Related issues:** #633 (dev equity pool), #365 (`gh fair` CLI)
**Author:** Greg (kimaris@gmail.com)
**Status:** Draft response for community discussion

---

## Framing

RFC-01 asks a protocol question. Two open issues already sketch the adjacent layers:

| Layer | Document | What it specifies |
|-------|----------|-------------------|
| **Protocol** | RFC-01 (this) | Attribution object schema, weight signals, chain anchoring |
| **Tooling** | #365 `gh fair` CLI | `.fair/issues/{N}.json` sidecars, backfill, leaderboard |
| **Economics** | #633 dev equity pool | 10% of 1% protocol fee → contributors, 5 attestation types |

This response answers RFC-01's six open questions in a way that lets all three layers ship coherently.

---

## Core principle

One pattern runs through every answer: **tool suggests, human decides, reason recorded.**

The sidecar at `.fair/issues/{N}.json` is the signed contract a maintainer commits to at merge time. Structural signals (diff size, file importance, derivation detection) produce suggestions. The maintainer accepts or overrides, and overrides carry a one-line reason that lands in the sidecar alongside both the suggested and declared values.

The chain is the audit trail. Everything else is tooling.

---

## Answers to the Six Open Questions

### Q1. How do you weight an architectural decision in a small commit?

**Automatic suggestion, manual override with required reason. Both values stored.**

`gh fair close 358` runs a structural pass (diff size, files-touched set-cover, type/interface detection, test-to-code ratio) and proposes a `points` value. The maintainer accepts or overrides with `--points`. If overriding, a `reason` string is required and persisted in the sidecar.

Divergence between suggested and declared values is visible and auditable. The 3-line commit that defines `interface SyndicationAdapter` gets flagged by the set-cover pass; maintainer sees the suggestion, bumps points with a reason; downstream reviewers can see why.

### Q2. Reviewer attribution — how much?

**5% implicit pool plus opt-in explicit elevation.**

Implicit: a fixed 5% of each PR's points is pooled across approving reviewers. Dilution is linear — 1 reviewer gets 5%, 5 reviewers get 1% each. Sybil approvers dilute themselves.

Explicit: the maintainer closing the PR can add a reviewer to `contributors[]` with any share and a note ("caught fundamental architecture flaw, redirected PR"). The elevated share comes **out of the author's share**, not out of the 5% pool — which means elevation costs something and only happens when it should.

### Q3. DID linking from GitHub handle

**Proof: OAuth default, gist as fallback. Failure: first-claim-wins with 30-day challenge window.**

Sidecars store `handle` (GitHub) as the durable identifier. `did` is populated on claim.

**Proof flow.** `gh fair claim --did did:imajin:xxx` uses the CLI's existing GitHub OAuth token to confirm handle ownership. A `contributor.claim` attestation binds handle ↔ DID. For users who don't trust GitHub's auth layer, a signed-gist challenge flow is available as a fallback.

**Failure flow.** First claim on a handle wins. For 30 days after a claim is made, a second claimant can challenge with stronger proof (e.g., a signed gist proving prior key control). After 30 days the claim is permanent unless overridden by maintainer quorum — which covers the rare account-compromise case.

Historical sidecars resolve forward automatically once a handle is claimed. Sidecars are not rewritten; handle stays the stable key.

### Q4. Retroactive attribution

**One-time maintainer-drafted batch with a soft review step.**

`gh fair backfill --since 2026-02-01` walks all closed issues and merged PRs, proposing sidecars using the Q1 suggestion layer. The maintainer adjusts `points` where the suggestion is off. **Before the batch commits, one or two other long-standing contributors sign off.**

The soft review step addresses the awkwardness of a maintainer assigning points to their own historical work. It's not a full governance process — just enough to make the judgment observable.

Attestations emit with original merge/close timestamps, not the backfill timestamp, so chain ordering reflects historical contribution. Handles without claimed DIDs accumulate attributions that resolve later via Q3's claim flow.

### Q5. Gaming resistance

**Public auditability as default; threshold-based co-signing for high-value sidecars.**

The combination of Q1 (points declared at close, not counted from commits) and Q2 (diluted implicit reviewer pool) already blocks the outside-gaming attacks — spam, sock-puppet approvers, line-count inflation.

The attack that remains is inside gaming: maintainer self-dealing or clique collusion. The defense:

- **All sidecars public.** Disputes surface through the normal issue process.
- **Threshold co-signing.** Sidecars with `points > 20` (roughly two months' typical work) require co-signing by a second maintainer before the attestation emits. The threshold is adjustable — starting at 20, maintainers tune based on the actual usage distribution.

Heavier multi-sig governance (e.g., a maintainers-forest group DID co-signing every sidecar) is deferred until RFC-17 (governance primitive) lands. This response doesn't require that substrate in the short term.

### Q6. Forking and derivative work

**Automatic detection, maintainer-declared shares.**

When `gh fair close` detects high code-overlap with a prior sidecar — via `git log --follow` + content-diff on touched files, past a threshold — it flags the PR as derivative and surfaces the prior sidecar's contributors. The sidecar gains a `derivedFrom` field referencing the prior sidecars.

**Shares are not computed by formula.** The tool shows the maintainer the prior contributors and the overlap ratio. The maintainer decides the split and writes a reason. No magic percentages, no `unchangedLines × 0.5` pseudo-math.

The chain of derivation is walkable — fork-of-fork-of-fork preserves the original contributors through each link.

**Sidecar shape:**

```json
{
  "version": "1.0",
  "issue": 742,
  "derivedFrom": [
    { "sidecar": ".fair/issues/358.json", "overlapRatio": 0.62 }
  ],
  "contributors": [
    { "handle": "original-author", "role": "originator", "share": 0.40 },
    { "handle": "fork-author",     "role": "maintainer", "share": 0.60 }
  ],
  "points": 8,
  "reason": "Fork of #358; 38% rewrite. Originator keeps credit for interface design."
}
```

---

## What this leaves open

Three things this response does **not** resolve:

1. **Unclaimed handle escrow.** If a handle never claims a DID, its accumulated share sits unassigned. Hold indefinitely? Redistribute after some period? 4-year vesting parallel is tempting but needs legal review.

2. **Non-PR design contributions.** Architectural calls that shape the next 10 PRs aren't in commit history. The `contributor.design` attestation type in #633 covers this in principle, but needs a convention — probably "filed as a GitHub issue with a `design` label, closed with `gh fair close` like any other tracking number."

3. **Reviewer-expertise weighting.** The implicit reviewer pool in Q2 is flat — a Sybil-diluting but otherwise equal split. Weighting by the reviewer's historical contribution in the same file area would be more signal, but the complexity is probably not worth it at current project scale.

---

## Recommendation — ship order

1. **#365 (`gh fair` CLI), minimum viable.** `init`, `close`, `show`, `backfill`. Produces sidecars only — no attestations yet.
2. **Backfill run.** One-time, maintainer-drafted, soft-reviewed by 1–2 other long-standing contributors.
3. **Attestation emission.** Wire `gh fair close` to emit the 5 attestation types from #633. Threshold co-signing (Q5) gates the high-point sidecars.
4. **Claim flow.** `gh fair claim` with OAuth default + gist fallback (Q3). 30-day challenge window enforced.
5. **Dev pool routing.** 10% of protocol fee routed to contributors, shares computed from chain replay. Only possible once 1–4 are stable.

Steps 1–4 run on the current DFOS substrate without new protocol primitives. Step 5 waits on MJN settlement.

---

## Anchor to existing work

- **Runtime `.fair`** (packages/fair) handles content manifests (events, tickets, media). `.fair/issues/` sidecars are a sibling format — share signing primitives, diverge in schema.
- **RFC-18** (media revocation and attribution) is the template for how attestations thread through downstream use.
- **RFC-17** (governance primitive) is the eventual substrate for multi-sig sidecars if the threshold approach in Q5 proves insufficient.
