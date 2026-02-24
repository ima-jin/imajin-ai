# RFC: .fair Attribution from Commit History

**Category:** RFC / Architecture  
**Status:** Open for discussion  
**Related:** [Bounty: imajin Syndication Service](#) *(link when live)*

---

## The Question

When a contributor writes code that becomes part of imajin infrastructure, how does their contribution get recorded in the .fair attribution chain — permanently, verifiably, and with appropriate weight?

This isn't just a contributor credits problem. It's a protocol design question. The answer here becomes the foundation for how imajin attributes *everything* — not just code, but content, curation, introductions, and eventually any value-generating act that passes through the network.

We're designing this in public because the people who will live with the answer should have a hand in building it.

---

## What We Know

### The basic mechanism is already there

Git is a content-addressed, cryptographically signed ledger of contributions. Every commit has:
- Author identity (name + email, soon: DID)
- Timestamp
- A precise diff — exactly what changed
- A hash chain linking it to everything before it

Walking the commit history of a repo gives you a complete, tamper-evident record of who contributed what and when. Tools like `git log --follow`, `git shortlog`, and `git-fame` already extract this. We're not inventing a new data source — we're deciding what to do with the one that already exists.

### PRs are natural attribution boundaries

A pull request is a discrete unit of contribution with its own metadata: description, review thread, merge decision, linked issues. It's also the moment where the community makes a judgment — this is good enough to merge. That judgment itself is attribution signal. The reviewers who approved a PR are as much a part of the attribution chain as the author.

### Weight is the unsolved part

Not all commits are equal. A commit that defines the adapter interface for the entire syndication service carries different weight than a commit that fixes a typo. The raw diff size is a proxy, but a poor one — a one-line architectural decision can outweigh a thousand-line boilerplate addition.

This is where the discussion needs to happen.

---

## Proposed Approach

### Step 1: Attribution object per PR

When a PR is merged, generate an attribution object:

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
      "files_touched": ["src/adapters/linkedin.ts", "src/adapters/base.ts"]
    }
  ],
  "reviewers": [
    {
      "github": "reviewer-handle",
      "did": "did:imajin:...",
      "approved": true
    }
  ],
  "weight": null
}
```

The `weight` field starts null. It gets resolved through the weighting mechanism (see below).

### Step 2: Weight signals

Proposed inputs to the weight calculation. **These are up for debate.**

**Structural signals** (inferrable from the diff):
- Does this PR touch interface definitions or types? (Higher weight — sets contracts others depend on)
- Does it add tests? (Higher weight — tests encode intent, not just implementation)
- Does it modify core attribution logic itself? (Flag for human review)
- Is it a new adapter vs. a fix to an existing one? (New adapter higher weight)

**Community signals** (from PR activity):
- Number of reviewers who approved
- Review comments — longer review threads suggest more scrutiny, more significance
- References from subsequent PRs ("builds on #42")
- Issues closed by the PR

**Network signals** (from imajin trust graph, over time):
- How many downstream contributions reference this PR's code?
- How often is the contributed module queried through the network?
- Trust weight of the reviewers who approved

### Step 3: Attribution chain anchoring

The resolved attribution object gets:
- Hashed and written to the node's attribution ledger
- Linked to the contributor's imajin profile (via DID, claimed from GitHub handle)
- Referenced in any content or service that depends on the contributed code

This last part is the key behavior: when someone syndicates an article through the LinkedIn adapter, the attribution chain for that syndication event includes a reference to the adapter's attribution object. The contributor is in the chain of every use of the thing they built.

---

## Open Questions

These are the things we don't have good answers for yet. Discuss below.

**1. How do you weight an architectural decision in a small commit?**
A 3-line change that defines the adapter interface contract probably deserves more weight than a 300-line implementation that follows it. How do you detect and weight that?

**2. Reviewer attribution — how much?**
A reviewer who catches a fundamental design flaw and redirects the PR is making a real contribution. A reviewer who just clicks approve is not. Can we distinguish these from the PR record, or does this require a separate signal?

**3. DID linking from GitHub handle**
Contributors may not have imajin profiles when they contribute. The GitHub handle becomes a *mention* in the imajin sense — a reference that exists before the profile does. When the contributor eventually claims their imajin identity, they need to be able to prove ownership of the GitHub handle and pull their historical attribution forward. What's the verification flow?

**4. Retroactive attribution**
The imajin repos already have commit history. When this system goes live, do we walk that history and generate attribution objects retroactively? How do we handle contributors who haven't claimed imajin profiles yet?

**5. Gaming resistance**
If attribution weight is valuable, people will try to game it — commit spam, fake review approvals, artificially inflating line counts. The structural signals above are harder to fake than raw commit counts. Are they hard enough?

**6. Forking and derivative work**
If someone forks an imajin adapter, modifies it, and submits it back as a new PR — how does the original author's attribution carry forward? The git history has the answer technically, but the weighting logic needs to handle it explicitly.

---

## What This Becomes

The answer to these questions isn't just a contributor credits system. It's the first working implementation of .fair attribution for code — which becomes the template for .fair attribution for everything else on the network.

The music curator who surfaces a track that later goes viral. The journalist whose research gets cited across fifty subsequent articles. The node operator whose infrastructure routes ten thousand inference queries. All of these are the same problem: *who contributed to this value, and in what proportion?*

We're solving the code case first because the data is clean, the tooling exists, and the stakes are low enough to experiment. But the protocol we land on here is the protocol.

---

## How to Participate

Comment below with your thinking on any of the open questions. You don't have to have answers — identifying the right questions is also a contribution.

If you want to propose a concrete mechanism, open a PR against `/docs/decisions/` with a draft ADR. Link it here. We'll work through it together.

When this discussion stabilizes, it lands as `ADR-001: .fair Attribution Protocol`.

---

*This discussion is part of building imajin.ai — sovereign infrastructure for identity, payments, and presence. The essays behind the architecture: [imajin.ai/articles](https://imajin.ai/articles)*
