# Epic: RFC-44 — Tiered Sovereign Agent Memory & Per-Principal View Isolation (hot/warm/cold, scratch→DID, shares-as-grants)

> **Canon** · source: [ima-jin/imajin-ai#1607](https://github.com/ima-jin/imajin-ai/issues/1607) · filed 2026-08-04 by @imajin-jin · carried into docs 2026-10-26
>
> Ruled 2026-10-26 (pre-cut issue audit v0.8.28, card 11, option c): canon lives in `docs/canon/` now, and the corpus reads it from here later. The issue stays open until this lands.
>
> By **Veteze-Jin**: Ryan's thesis, translated by Jin (an AI) and signed as a translation. Anything quoted from Ryan is verbatim.

Numbering note: this issue originally called itself RFC-40, which collides with [RFC-40 (did:imajin resolution)](rfcs/RFC-40-did-imajin-resolution.md). It was never drafted as an RFC, so it takes the next free number, **RFC-44** (ruled 2026-10-27).

## Thesis

An agent's working state shouldn't be one flat pile on one drive. It's tiered (hot/warm/cold), it graduates from scratch to DID-owned storage, and it's isolated per principal, so one principal's work is never visible through another's view. Shares are grants. This is architecture-first, and the architecture is Ryan's to draw.

## Source (verbatim from [#1607](https://github.com/ima-jin/imajin-ai/issues/1607))

**RFC:** RFC-44 — Tiered Sovereign Agent Memory & Per-Principal View Isolation *(doc to be drafted: `docs/canon/rfcs/RFC-44-tiered-sovereign-memory-view-isolation.md`)*
**Status:** Draft — **architecture-first (STOP-and-discuss).** Net-new storage/trust model for the agent's own working state. Filing to hold the frame + sculpt sub-issues; **NOT authorizing build.** Architecture is Ryan's to draw.

### Thesis

Today "Jin" is one agent with one flat local workspace on one box. Everything it touches — its own scratch, Ryan's work, potentially other principals' work — lands in the same undifferentiated pile on a drive that could die. That is **platform-level, not per-principal**: the only thing preventing cross-principal leakage is the agent being careful. Per CAN/DGSI 100-8 §4.1.5, "careful" does not discharge the obligation — per-principal separation must be **structural, built into the substrate, not retrofitted at the policy layer.**

RFC-44 makes the agent's own memory sovereign and isolated:

- **The agent writes to a cache; the cache syncs to prod; the signed store is truth.** The local drive is a hot working layer, not the authority. If the box dies, nothing is lost — truth was never there. (This generalizes RFC-39's "working copy vs source of truth" from *skills* to *all agent state*.)
- **Scratch is on the agent's OWN DID.** Jin's whole working surface — drafts, notes, work-in-progress — syncs to prod under the **Jin agent DID** (`did:imajin:ADEKFWc2pbTKzfgzA3q6yrc1rEPNeMEP71mkBbCan54k`) as its durable floor + long-term-memory substrate. Not the principal's DID — the agent's.
- **A principal's workspace is held as a SHARE, not a copy.** Jin holds a *view* of Ryan's workspace under an access grant **from Ryan's DID** — a reference used as a publish destination. It stays authoritative on the owner's DID and is **never synced into Jin's own truth.**
- **Tiers:** **hot** (local, in-flight) → **warm** (recent, on-box) → **cold** (Imajin/prod, signed, versioned) = source of truth. Cold = long-term memory.
- **Per-principal view isolation (the load-bearing part).** When Jin eventually holds views of *multiple* principals' shares, they must be **structurally isolated**: a query in principal A's session can reach ONLY A's view — not because Jin filters, but because the session's delegation scope does not make B's view *reachable*. You cannot query Jin for someone else's, and they cannot query Jin for yours. **Unreachable, not un-shown.**

This is the honest-record thesis + §4.1.5 pointed at the agent's own memory. It is the same per-DID structural-isolation pattern as the Warp per-principal key dispatch ([#1428](https://github.com/ima-jin/imajin-ai/issues/1428) / PR [#1602](https://github.com/ima-jin/imajin-ai/issues/1602)) — applied to storage/view instead of secrets.

### Positioning (composes with prior art — does NOT duplicate)

- **[#1425](https://github.com/ima-jin/imajin-ai/issues/1425) / RFC-39 (Verifiable Skills)** — sibling. RFC-39 = *working-copy-vs-signed-truth for skills*. RFC-40 = *the same spine generalized to all agent state* + the storage tiering + the isolation. Verification (39) is distinct from storage-truth & isolation (40), same way RFC-39 decided verification ≠ delivery.
- **[#366](https://github.com/ima-jin/imajin-ai/issues/366) (agent-principal pairing / capability image)** — the per-principal seam. RFC-40's isolated per-principal view is the *storage/memory* face of [#366](https://github.com/ima-jin/imajin-ai/issues/366)'s forkable capability `image`.
- **[#1144](https://github.com/ima-jin/imajin-ai/issues/1144) (Agent Boot Loader — scope-as-share)** — the **share** primitive. "I hold a share of yours in mine" = a scope-as-share grant. RFC-40 consumes [#1144](https://github.com/ima-jin/imajin-ai/issues/1144) for how a principal's view arrives + stays scoped.
- **[#1225](https://github.com/ima-jin/imajin-ai/issues/1225) (in-harness authority/provenance substrate, parked)** — the outward bet this dogfoods inward.
- **grant-access / `allowedDids` (media service, live)** — the existing access-grant primitive shares are built on; needs verification of how far it already goes.

### Candidate sub-issues (to sculpt, not yet authorized to build)

- [ ] **Discovery:** what does `imajin-cli` / media service already expose for (a) directory→DID versioned sync and (b) reading a granted share? (grant-access, allowedDids seen — map the real surface before building.)
- [ ] Cache→cold sync engine: local working tree → versioned assets on an **owning-DID-keyed** path (Jin's scratch → Jin DID). Store keyed on owning-DID from day one so single-principal Phase 0 does not poison isolation Phase 2.
- [ ] Tier policy: hot/warm (local) eviction + cold (Imajin) as source-of-truth; reconciliation on cold-wins.
- [ ] Share model: hold a principal's workspace as a grant-scoped **reference view** (publish destination), explicitly excluded from Jin's own synced truth.
- [ ] Secrets/exclusion policy: `imajin-keys-*.json`, `.next`, transient build output NEVER leave the box; scoped subtrees only.
- [ ] **Per-session view isolation runtime** (the hard part): session's reachable store scoped to its delegation; cross-principal views structurally unreachable. This is the §4.1.5 build — [#366](https://github.com/ima-jin/imajin-ai/issues/366) territory.
- [ ] Long-term-memory-on-cold: MEMORY / memory/* as sovereign versioned assets on Jin DID (carefully — personal context; main-session-only rule per AGENTS.md).

### Staging (honest, non-committal)

- **Phase 0** — Jin scratch → Jin DID cold store, tiered. Single-owner (Jin), zero isolation risk. Buildable once discovery confirms the sync path. **Owning-DID-keyed from day one.**
- **Phase 1** — principal workspace as grant-scoped reference view (publish destination); never enters Jin's truth.
- **Phase 2** — per-session view isolation so multi-principal views are mutually unreachable. Architecture-class; §4.1.5 / [#366](https://github.com/ima-jin/imajin-ai/issues/366). Ryan draws it.

### Doctrine

Architecture-first, matching [#1425](https://github.com/ima-jin/imajin-ai/issues/1425). Filing to hold the frame + sculpt sub-issues; **not** authorizing build until the design lands and the isolation boundary is agreed. Phase 0 (Jin's own data) may build after discovery; the **share + isolation layer does not build until Ryan draws it.** Improvising a multi-principal security boundary in a sync script is exactly the shortcut SOUL/AGENTS forbid.

## Rulings and notes from the thread

**@imajin-jin · 2026-09-23**

> **DECISION** · [#1607](https://github.com/ima-jin/imajin-ai/issues/1607) · from decision run [#2277](https://github.com/ima-jin/imajin-ai/issues/2277) (2026-09-22) · verdict: **b — keep open**. RFC-40 tiered agent memory stays architecture-first; the Corpus service ([#1726](https://github.com/ima-jin/imajin-ai/issues/1726)) is a consumer of tiered memory, not a replacement for it. Ruled by Ryan; written back by Jin (decision-run).
