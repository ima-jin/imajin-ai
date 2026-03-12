## 15. .fair Attribution from Commit History — ADR-001

**Author:** Ryan Veteze (RFC open for community input)
**Date:** March 2026 (committed in `e079b80`)
**Source:** `apps/www/articles/rfc-01-fair-attribution.md`
**Status upstream:** Open for discussion — destined to become `ADR-001: .fair Attribution Protocol`
**Related upstream:** Discussion #15 (GitHub), Bounty #17 (Syndication Service)
**Connects to:** Proposals 3 (.fair signing), 6 (.fair Attribution Integrity), 7/8 (Cryptographic Trust Layer)

### The Core Claim (rfc-01-fair-attribution.md:11–13)

> *"This isn't just a contributor credits problem. It's a protocol design question. The answer here becomes the foundation for how imajin attributes everything — not just code, but content, curation, introductions, and eventually any value-generating act that passes through the network."*

And explicitly (rfc-01-fair-attribution.md:140):

> *"We're solving the code case first because the data is clean, the tooling exists, and the stakes are low enough to experiment. But the protocol we land on here is the protocol."*

This RFC is not about contributor credits. It is the first working implementation of the `.fair` attribution model — the template for all attribution going forward. Everything Greg's proposals say about `.fair` signing and attribution integrity applies directly here.

### What Ryan Has Proposed (rfc-01-fair-attribution.md:23–29)

Git is already a content-addressed, cryptographically signed ledger: author identity, timestamp, precise diff, hash chain. PRs are natural attribution boundaries — discrete units of contribution with author, reviewer, merge decision (rfc-01-fair-attribution.md:31–33). Weight is the unsolved part: *"a one-line architectural decision can outweigh a thousand-line boilerplate addition"* (rfc-01-fair-attribution.md:37).

**The proposed attribution object per merged PR** (rfc-01-fair-attribution.md:45–76):

```json
{
  "id": "attr_abc123",
  "repo": "ima-jin/imajin-cli",
  "pr": 42,
  "merged_at": "2026-03-15T14:22:00Z",
  "contributors": [
    {
      "github": "contributor-handle",
      "did": "did:imajin:...",
      "commits": 7,
      "lines_added": 312,
      "lines_removed": 44,
      "files_touched": ["src/adapters/linkedin.ts"]
    }
  ],
  "reviewers": [{ "github": "reviewer-handle", "did": "did:imajin:...", "approved": true }],
  "weight": null
}
```

**Three tiers of weight signals** (rfc-01-fair-attribution.md:82–97):
- *Structural* (from the diff): touches interface definitions? adds tests? new adapter vs. fix?
- *Community* (from PR activity): reviewer count, review thread length, issues closed, references from subsequent PRs
- *Network* (from trust graph, over time): downstream contribution references, query frequency of contributed module, trust weight of reviewers

**Attribution chain anchoring** (rfc-01-fair-attribution.md:99–106): the resolved attribution object is hashed and written to the node's attribution ledger, linked to the contributor's DID via GitHub handle claim, and referenced in every downstream use — *"the contributor is in the chain of every use of the thing they built."*

### Greg's Position on the Six Open Questions (rfc-01-fair-attribution.md:114–131)

**Q1 — Weighting a small architectural commit** (rfc-01-fair-attribution.md:114–115):
The structural signal approach is correct but incomplete. Interface-touching PRs should carry higher weight — but detecting *why* a small change is load-bearing requires either: (a) explicit tagging by the author in the PR description, or (b) network signals that only emerge over time as downstream PRs reference the change. Greg's position: structural signals for initial weight assignment; network signals as a retroactive weight correction mechanism. Weight is not fixed at merge — it accumulates.

**Q2 — Reviewer attribution** (rfc-01-fair-attribution.md:117–118):
Review thread depth is the best proxy for reviewer contribution quality. A reviewer who leaves substantive comments redirecting the architecture leaves a longer, more substantive thread than an approve-only reviewer. Greg's position: reviewer weight = f(comment count, thread depth, whether PR was modified in response to their comments). This is inferable from the PR record without additional signal.

**Q3 — DID linking from GitHub handle** (rfc-01-fair-attribution.md:120–121):
The GitHub handle becomes an *unclaimed mention* — a reference that exists in the attribution ledger before the profile does. Greg's position: the claim flow should require the contributor to prove ownership of the GitHub handle by signing a message with their imajin DID that matches a verification challenge posted to the GitHub account (via a public Gist or profile README). This is the same model used by Keybase and similar DID linking systems. Once claimed, all historical attribution objects referencing that GitHub handle are retroactively linked to the DID.

**Q4 — Retroactive attribution** (rfc-01-fair-attribution.md:123–124):
Walk the existing commit history and generate attribution objects for all historical PRs. Contributors who haven't yet claimed imajin profiles exist as unclaimed mentions in the ledger. Greg's position: retroactive generation is required — it is the founding generation of the attribution ledger. Unclaimed attributions accumulate; they become claimable when the contributor creates their imajin profile and completes the GitHub handle linking flow (Q3). Unclaimed attributions should not distribute value until claimed — value accumulates in a holding state attached to the unclaimed mention.

**Q5 — Gaming resistance** (rfc-01-fair-attribution.md:126–127):
Structural signals are harder to fake than commit counts but not immune. Interface-definition commits can be fabricated; review thread depth can be gamed with sock-puppet accounts. Greg's position: gaming resistance at launch relies on the trust graph — reviewers carry the trust weight of their DID. A review approval from a Preliminary DID carries less weight than one from an Established DID. The trust graph already provides the anti-gaming layer; no separate mechanism is needed for MVP.

**Q6 — Forking and derivative work** (rfc-01-fair-attribution.md:129–130):
The git history records the fork relationship. `derives_from` in the `.fair` manifest (already present in the architecture doc at `grounding-03-ARCHITECTURE.md:136`) is the mechanism. Greg's position: forked adapters should carry a `derives_from` reference to the original PR's attribution object. The original contributor's share in derivative work is a governance parameter — proposed starting value: 20% of the derivative's attribution weight flows to the original, decaying with each subsequent fork.

### Connection to Unsigned FairManifest (P3)

The attribution object proposed in this RFC has `"weight": null` — unresolved weight. The RFC does not specify that the attribution object itself is *signed*. This is the same gap identified in P3 and Proposal 6: an attribution claim without a cryptographic proof that the claimed DID authorized it.

Greg's position: the attribution object schema needs a `signature` field from the moment it is specified. An unsigned attribution object is the same category of problem as an unsigned `.fair` manifest. The RFC should be extended to require Ed25519 signing of the attribution object by the contributor's DID (not just the GitHub handle) before it is written to the attribution ledger.

### Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Is weight fixed at merge, or does it accumulate retroactively as network signals emerge? | Determines attribution ledger mutability model | Accumulates — network signals update weight over time; original weight is a floor |
| What is the unclaimed attribution holding model — accumulate to a zero address, escrow, or redistribute? | Determines what happens to value from unclaimed GitHub handles | Accumulate to a per-mention escrow; claimable indefinitely; unclaimed after N years → distribute to active pool |
| Should attribution objects be signed at creation, or only hashed? | Integrity vs. operational complexity | Signed — same requirement as `.fair` manifests (extends P3) |
| Who computes `derives_from` weight decay — the contributor, a governance parameter, or a protocol constant? | Attribution economics for fork chains | Protocol constant initially; Cultural DID can override for community-specific forks |

**Detecting resolution in the repo:**
- New `ADR-001` document in `docs/decisions/`
- Attribution object schema appears as TypeScript types in a new package or `@imajin/fair`
- PR merge webhook generates attribution objects (GitHub Actions or pay service webhook)
- GitHub handle → DID claim flow in auth service
- `derives_from` field on attribution objects referencing parent PR attribution

---

