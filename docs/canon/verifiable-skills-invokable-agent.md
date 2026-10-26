# Epic: RFC-39 — Verifiable Skills & the Invokable Agent

> **Canon** · source: [ima-jin/imajin-ai#1425](https://github.com/ima-jin/imajin-ai/issues/1425) · filed 2026-07-24 by @imajin-jin · carried into docs 2026-10-26
>
> Ruled 2026-10-26 (pre-cut issue audit v0.8.28, card 11, option c): canon lives in `docs/canon/` now, and the corpus reads it from here later. The issue stays open until this lands.
>
> By **Veteze-Jin**: Ryan's thesis, translated by Jin (an AI) and signed as a translation. Anything quoted from Ryan is verbatim.

RFC: [docs/rfcs/RFC-39-verifiable-skills-invokable-agent.md](../rfcs/RFC-39-verifiable-skills-invokable-agent.md).

## Thesis

A skill should be a signed, verifiable artifact bound to the agent that invokes it, not a loose file matched by description. That makes the agent invokable, with tooling you can prove.

## Source (verbatim from [#1425](https://github.com/ima-jin/imajin-ai/issues/1425))

**RFC:** `docs/rfcs/RFC-39-verifiable-skills-invokable-agent.md` (PR [#1424](https://github.com/ima-jin/imajin-ai/issues/1424))
**Status:** Draft — architecture-first (STOP-and-discuss; net-new trust model for the agent's own tooling, not pure composition).

### Thesis

An OpenClaw skill today is a loose file matched by description — **detached** from the project it acts on AND **unverifiable** (nothing proves the loaded bytes are the authentic, unmodified skill). RFC-39 reframes:

- **A skill = a signed artifact** — manifest with author DID, content hash, version, declared capabilities, `supersedes` chain. No new primitive; `imajin_attest` over a new subject type.
- **The agent = a DID + a verified skill manifest** — "invoke Jin" resolves DID → manifest → hash-check each skill against the signed record → load only what verifies. Mismatch = refuse or flag, **never silent**.
- **Working copy vs source of truth** — the file in the workspace is the working copy; the signed hash is truth (host-independent — Ryan's "hash-checked against a cloud version" made honest: checked against the *signed record*, not "a cloud").

This is the honest-record thesis pointed at the agent's own capability layer. Proof-of-history answers *what did the agent do*; this answers *what is it allowed and able to do, and is it the real one* — the precondition for trusting an agent you did not configure.

### Positioning (composes with prior art)

- **[#1144](https://github.com/ima-jin/imajin-ai/issues/1144) (Agent Boot Loader — scope-as-share)** — delivery (how a skill legitimately arrives). RFC-39 = verification (are the arrived bytes authentic) + inspectability. Compose: delivery + verification.
- **[#366](https://github.com/ima-jin/imajin-ai/issues/366) (agent-principal pairing / capability image)** — RFC-39's manifest = the signed, verifiable contents of [#366](https://github.com/ima-jin/imajin-ai/issues/366)'s forkable `image`.
- **[#1225](https://github.com/ima-jin/imajin-ai/issues/1225) (in-harness authority substrate, parked)** — RFC-39 is the inward dogfood of that outward bet.
- **[#847](https://github.com/ima-jin/imajin-ai/issues/847) / [#1115](https://github.com/ima-jin/imajin-ai/issues/1115) / [#1327](https://github.com/ima-jin/imajin-ai/issues/1327)** — distribution + consumers.

### The OpenClaw-loader boundary (load-bearing)

OpenClaw's loader is path+description, trust-blind, can't be assumed to do DID/hash verification.
- **Option A (v1, recommended):** verification wrapper *beside* the loader — deterministic hook (RFC-36) resolves attestation, hashes working copy, allows/refuses + records the decision. Ships on existing primitives, no fork.
- **Option B (v2):** first-class signed-skill source inside the loader. A proposal *to* OpenClaw, only after A proves the model.

### Candidate sub-issues (to sculpt, not yet authorized to build)

- [ ] Skill manifest schema + canonical bundle hashing (deterministic across machines)
- [ ] `imajin_attest` over a skill subject type + version/`supersedes` chain
- [ ] Verify-on-load wrapper (Option A) via deterministic hook (RFC-36) — allow/refuse/flag + record
- [ ] Manifest resolution transport (DID → skill manifest; offline/first-boot fail-closed vs flagged)
- [ ] Capability declaration surface (advisory v1; sandbox-enforced v2 per RFC-31)
- [ ] Skill revocation on the record (RFC-18 shape)
- [ ] Plug manifest into [#366](https://github.com/ima-jin/imajin-ai/issues/366) capability `image` / `.imajin/` stack

### Open design questions

Own RFC vs [#1144](https://github.com/ima-jin/imajin-ai/issues/1144) sub-section (**decided: own RFC** — verification is distinct from delivery and applies to skills arriving by any path, incl. bundled vendor skills); canonicalization; who signs bundled/vendor skills; advisory-vs-enforced capability declaration; relation to RFC-16/RFC-25.

### Doctrine

Architecture-first. Filing to hold the frame + sculpt sub-issues; **not** authorizing build until the design conversation lands and Option A's boundary is agreed.

## Rulings and notes from the thread

**@imajin-jin · 2026-08-04**

> Sibling epic filed: **[#1607](https://github.com/ima-jin/imajin-ai/issues/1607) / RFC-40** — Tiered Sovereign Agent Memory & Per-Principal View Isolation. Generalizes RFC-39's working-copy-vs-signed-truth spine from *skills* → *all agent state*, and adds the storage tiering (hot/warm/cold) + the §4.1.5 per-principal view isolation. Verification (39) and storage-truth/isolation (40) are distinct but share the spine; RFC-40 consumes [#366](https://github.com/ima-jin/imajin-ai/issues/366) (capability image) and [#1144](https://github.com/ima-jin/imajin-ai/issues/1144) (scope-as-share).

**@imajin-jin · 2026-09-23**

> **DECISION** · [#1425](https://github.com/ima-jin/imajin-ai/issues/1425) · from decision run [#2277](https://github.com/ima-jin/imajin-ai/issues/2277) (2026-09-22) · verdict: **b — keep open**. RFC-39 (Verifiable Skills) stays architecture-first; RFC-40 ([#1607](https://github.com/ima-jin/imajin-ai/issues/1607)) generalizes tiered memory but does not replace the verifiable-build track. Ruled by Ryan; written back by Jin (decision-run).
