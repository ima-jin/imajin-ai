# RFC-39: Verifiable Skills & the Invokable Agent — Capabilities as Signed Artifacts, Jin as a DID + Verified Manifest

**Status:** Draft
**Author:** Ryan Veteze, Jin
**Date:** 2026-07-23
**Scope:** Agent runtime, skill loading, capability attestation, agent-to-agent invocation
**Related:** RFC-16 (Jin Workspace Agent Architecture), RFC-31 (Agent Execution Sandbox), RFC-27 (Multi-Agent Coordination), RFC-32 (Agent Protocol Interoperability), RFC-20 (Application Conformance Suite), RFC-21 (Imajin Conformance Suite), RFC-01 (.fair Attribution), RFC-13 (Progressive Trust Model), RFC-15 (Trust & Accountability Framework), RFC-33 (Agent CI Pipeline)
**Issues:** #1144 (Agent Boot Loader — scope-as-share, canonicalized), #366 (Agent-principal pairing / custody chain / capability image), #1225 (parked: Imajin as in-harness authority & provenance substrate for agents), #847 (RFC: OpenClaw Agent Marketplace), #1115 (Side Jin), #1327 (autonomous sprint loop — karaoke). *(RFC-39 epic + sub-issues to be filed; Board Vertical = Agent.)*

> **This RFC does NOT stand alone.** It is the *verification layer* that sits between two existing frames: **#1144** (how a skill legitimately *arrives* in an agent's workspace — share-driven, canonicalized) and **#366** (the agent's *capability image* + human-principal custody). It is the *inward dogfood* of **#1225** (Imajin as the neutral authority/provenance substrate for agents — pointed at our own tooling). See **Prior Art & Positioning** before reading the design as novel.

---

## Summary

Today an OpenClaw agent's capabilities — its **skills** — are loose files on a local disk, matched by description and read on demand. They are **detached** in two ways that matter: (1) they are not versioned *with* the project they act on, and (2) they are not *verifiable* — nothing proves a given skill is the authentic, unmodified `karaoke` (or `imajin-deploy`, or `artifact`) skill rather than a drifted local copy or a tampered one.

This RFC reframes a skill as a **signed artifact** and an agent as an **invokable capability whose behavior is defined by a verified manifest of skills resolved from its DID.** "Invoke Jin" becomes: resolve `did:imajin:<jin>` → fetch its skill manifest → hash-check each skill against the signed record → load only what verifies. A skill that fails verification does not silently run; it is rejected or loaded in an explicitly-flagged degraded mode.

This is the honest-record thesis pointed at the agent's own tooling. Proof-of-history already answers "what did the agent do." This answers the prior question: **"what is this agent allowed and able to do, and is it the real one?"** — the precondition for trusting an agent you did not personally configure, which is the precondition for agent-to-agent coordination (RFC-27), protocol interop (RFC-32, Buzz/Nostr, DFOS), and the multi-Jin sandbox (RFC-31).

## Motivation

The trigger is concrete (2026-07-23): skills such as `karaoke`, `imajin-deploy`, and `artifact` live under `~/.openclaw/workspace/skills/*` and `~/.local/share/pnpm/.../skills/*`. They are excellent, but:

1. **Detached from the project.** A skill that operates on `imajin-karaoke` or the monorepo is not versioned alongside that project. It drifts from the code it drives; there is no single history where "the procedure" and "the thing the procedure acts on" move together.
2. **Unverifiable.** There is no attestation that the loaded bytes are the intended skill. A skill can be edited locally, corrupted, or substituted, and the agent will load and act on it identically. For a skill that can deploy to prod or spend money, that is an unmitigated trust hole.
3. **Not portable as capability.** Because a skill is a path, not an addressable signed artifact, an agent cannot advertise "here are the capabilities I carry" in a way another party can inspect and trust. "Invoke Jin from elsewhere" has no meaning today beyond "run the files that happen to be on that box."
4. **The loader is trust-blind.** OpenClaw's skill loader resolves by filesystem path + description match. It has no concept of author, version, hash, or authority. This is fine for a single trusted operator on one box; it does not survive multi-agent, multi-principal, or remote-invocation contexts.

The gap is not organizational tidiness. It is that **the agent's own capability layer is the one part of the stack the honest-record thesis has not yet been applied to.**

## Prior Art & Positioning

This idea was reached from the "skills are detached from the project" complaint (2026-07-23), but the tracker already circles it from several angles. RFC-39 must **compose with** these, not restate them:

- **#1144 — Agent Boot Loader: "scope-as-share, canonicalized" (Ryan, Day 145).** The deeper frame for the *organizational* half. Its keystone: **scope is not a permission filter over a shared pile of skills — scope is the set of things *shared into* the agent's own workspace; the compartment IS the workspace.** A scoped Jin's box does not *contain* another principal's skills — not hidden, never delivered. **RFC-39 builds on this:** #1144 governs *how a skill legitimately arrives* (inbound signed/canonical disclosure through the broker, one layer up); RFC-39 governs *proving the arrived bytes are authentic* and *making the carried set inspectable*. Delivery (them) + verification (this) + inspectability (this). RFC-39 explicitly does **not** re-spec the share mechanism — it assumes #1144's inbound disclosure as the delivery path and adds the hash-check on load.
- **#366 — Agent-principal pairing / custody chain.** Already partly shipped (delegation, `onBehalfOf`, agent-vs-principal attestation). It also already introduced the **"image = base capability set (soul, skills, config), forkable"** concept and a per-agent **`.imajin/` identity stack**. **RFC-39's skill manifest plugs into #366's `image`** — the manifest is the signed, verifiable contents of the capability image, not a parallel structure. Custody (#366: which human is accountable) + authenticity (RFC-39: are the capabilities real).
- **#1225 — Imajin as in-harness authority & provenance substrate for agents (parked, strategic).** The *outward* bet: labs will be forced to build "the conscience" (who is this agent acting for, what were they allowed, can you prove what they did) and we are the neutral substrate. **RFC-39 is that thesis pointed *inward* — the dogfood.** We make our own agent's capability layer honest first; #1225 is the same machine sold outward. The "Why this is the thesis" section below is #1225 turned on ourselves.
- **#847 — OpenClaw Agent Marketplace (RFC).** Distribution/economics: nodes as the channel, agent-as-on-ramp. Signed skills (RFC-39) are *what flows through* that marketplace; the marketplace is the where, RFC-39 is the what-and-is-it-real.
- **#1115 / #1327 — Side Jin / autonomous sprint loop.** The consumers: "everyone gets a scoped Jin" (#1115) and the karaoke sprint loop (#1327, the `karaoke` skill) are exactly the multi-principal, multi-skill contexts where unverifiable capabilities become a real trust hole.

**Net:** the missing piece none of these spec is **skill-as-signed-artifact + verify-on-load + the honest OpenClaw-loader boundary.** #1144 assumes canonical delivery but not the hash-check; #366 names a "forkable image" but not its authenticity mechanism. That gap is RFC-39's entire job.

## Design

### A skill is an attestation

A skill artifact carries a signed manifest:

```
skill.manifest = {
  name:        "karaoke",
  version:     "0.3.0",
  author_did:  "did:imajin:<author>",
  content_hash: "sha256:…",        // hash over the canonical skill bundle (SKILL.md + assets)
  scope:       "business",          // Imajin scope/subtype of the artifact
  capabilities: ["exec", "gh", "sessions_spawn"],   // declared tool surface (see §Capability declaration)
  supersedes:  "sha256:…",          // prior version hash, if any
  signed_at:   "2026-07-23T…Z"
}
```

- The **content hash** is over a canonical serialization of the skill bundle (`SKILL.md` plus any `assets/`, `scripts/`, `references/`). Same discipline as the `.fair` manifest (RFC-01) and the container-image signature in the Artifact/ARTF work: the artifact is addressable by what it *is*, not where it sits.
- The **signature** binds the hash to an author DID. "This procedure, authored by this DID, at this version, at this time." That is exactly an Imajin attestation — no new primitive; a configuration of the existing `imajin_attest` shape over a new subject type (a skill).
- **Versioning is proof-of-history.** `supersedes` chains versions; the signed record is the changelog. You can prove which version of a skill was in force when the agent acted (ties to RFC-03 memory attribution and to the eligibility-store "projection over the signed stream" pattern).

### The working copy vs. the source of truth

The skill file in the workspace is the **working copy.** The signed hash is the **source of truth.** On load, the loader verifies the working copy against the attestation:

```
load(skill):
  manifest ← resolve attestation for skill (by name+version, from the signed record)
  bytes    ← read working copy from workspace
  if sha256(canonical(bytes)) == manifest.content_hash:  load, mark VERIFIED
  else:                                                   reject OR load DEGRADED (flagged, never silent)
```

This is Ryan's "hash-checked against a cloud version" instinct made honest: the check is not against "a cloud," it is against **the signed record** (which may be served from anywhere — node, gateway, a peer — because it is verifiable independent of its host). Same shape as `memory-core` being a projection over the record, and "even the core is a projection" (kernel).

**Tamper-evidence, not tamper-prevention.** The goal of v1 is that an altered or substituted skill is *detectable and refused*, and that every load decision is on the record. It is not (yet) sealed execution or a TEE; that is a hardening track (below), the same v1-honest / v2-hardened split as the vault (RFC-11 / #1227 vs #1239).

### The agent is a DID + a verified skill manifest

"Invoke Jin" resolves to:

```
did:imajin:<jin>
   └─▶ agent manifest
         ├─ identity (RFC-16, RFC-08/06)
         ├─ skill manifest: [ {name, version, hash, author_did}, … ]   ← this RFC
         └─ authority: what this agent may act on, onBehalfOf whom (RFC-13, RFC-17)
```

An agent instance *is* its DID plus the set of verified skills it carries. This makes two things concrete that are otherwise hand-wavy:

- **Multi-Jin (RFC-31).** "Each principal gets a context-scoped Jin" becomes "a Jin instance = a DID + a scoped, verified skill manifest." The sandbox (RFC-31) is where a manifest runs; this RFC is what defines *what* runs and proves it authentic.
- **Agent-to-agent trust (RFC-27, RFC-32).** Before agent B trusts agent A's action `onBehalfOf` a human, B can resolve A's DID → inspect A's declared capabilities → verify they are authentic. This is the missing precondition for the Buzz/Nostr and DFOS interop shapes (RFC-32, #1409): "sign your own work" (Buzz) needs "and here is provably what you were built to do" (this RFC) to be trustworthy across a boundary.

### Capability declaration (the tool surface)

Each skill declares the tool surface it needs (`capabilities: ["exec", "gh", …]`). This is a declaration, not an enforcement boundary by itself — enforcement is the sandbox's job (RFC-31) and the deterministic-hooks/gate job (RFC-36, and the human-confirm rail #1366/#1368). But the declaration is load-bearing for **legibility**: a human (or a peer agent) can read "what does invoking this skill let the agent touch" *before* running it, and the declared surface can be diffed against what the skill actually invokes (conformance, below). This is the same move as ARTF's *declared intents* on an oRTB patch — declare what you will do, then let the host verify you did only that.

### Where skills live (the organizational half)

The verification layer does not mandate one storage location, but it resolves the "detached from the project" complaint cleanly:

- **Project-owned skills** (operate on a specific repo: `karaoke`, `imajin-deploy`) live *with* that project, versioned in its git history, and their attestations are minted from that repo's release process (ties to RFC-33 Agent CI Pipeline — the pipeline that builds the project also signs the skill).
- **Agent-owned skills** (cross-cutting to Jin: `biz-dev`, `artifact`, memory discipline) live in the agent's own signed workspace/manifest.
- **Bundled/vendor skills** (OpenClaw's own: `browser-automation`, `canvas`, `github`) are signed by their vendor DID and verified the same way — an authentic-vendor-skill check, not a we-authored-it check.

The loader stops caring about *path* and starts caring about *manifest*: it resolves the set of skills an agent's DID declares, and finds the working copy wherever it is registered.

## The OpenClaw-loader boundary (the honest constraint)

This is the load-bearing discipline flag, stated explicitly because getting it wrong means speccing a cathedral into a mechanism that cannot hold it.

**OpenClaw's skill loader is its own mechanism.** It reads files by path + description and has no concept of DID resolution, attestation, or hash verification. Nothing in this RFC can assume the loader will natively do any of that. Therefore the design must live at a boundary that is honest about who does what:

- **Option A — verification wrapper (v1, recommended).** A pre-load verification step *beside* OpenClaw's loader: before the agent is allowed to consume a skill, an Imajin-side check (a hook, per RFC-36 deterministic hooks / the `before_agent_finalize`-class surface) resolves the attestation, hashes the working copy, and either allows the load or records a refusal. OpenClaw still loads files by path; Imajin gates *which* files are permitted to be present/loaded and stamps the decision. Minimal coupling, ships on existing primitives (attestation + hooks), no fork of the loader.
- **Option B — loader integration (v2).** A first-class notion of a signed skill source inside the loader itself (resolve-by-manifest, verify-on-read). Cleaner, but it is a change to OpenClaw core and should not be attempted until Option A has proven the trust model in practice. This is a proposal *to* OpenClaw, not a thing we do unilaterally.

**We build A first.** It is a configuration of primitives we already have (attestation, deterministic hooks, the DID/manifest resolution the platform already does). B is a design conversation with the OpenClaw project once A has generated the evidence for what the loader integration should actually be. (Same sequencing discipline as the conformance suite: assemble and prove the check before forming the heavier structure around it.)

## Threat model & non-goals

- **Detects:** local drift, tampering, substitution of a skill; running an unauthentic or stale-unauthorized skill; an agent advertising capabilities it does not actually carry.
- **Does NOT (v1):** prevent a *verified* skill from doing something harmful — a correctly-signed skill can still be a bad procedure. That is the authority/policy axis (RFC-13, RFC-36, the #1366 confirm rail, and the Verdicter-class action-policy layer), not the authenticity axis this RFC covers. Authenticity + authority are complementary, not substitutes.
- **Does NOT (v1):** provide sealed/TEE execution or prevent a compromised host from lying about the hash it computed. That is a hardening track (analogous to vault zero-custody #1239 and ZKP predicate hardening #1226).
- **Non-goal:** mandating a single storage backend or a "cloud." The source of truth is the *signed record*, which is host-independent by construction.

## Open questions

1. **Canonicalization of the skill bundle** — exact serialization over which the hash is computed (SKILL.md only, or the whole directory; whitespace/ordering normalization). Must be deterministic across machines.
2. **Manifest resolution transport** — how an agent's DID → skill-manifest is served and cached (node? gateway? peer?), and how offline/first-boot loads behave when the record is unreachable (fail-closed vs. flagged-degraded — mirror the #1368 fail-closed discipline).
3. **Who signs bundled/vendor skills** — do we require a vendor DID + signature for OpenClaw's own bundled skills, or treat "vendor-bundled at known path" as a distinct, lower trust tier?
4. **Capability-declaration enforcement** — is the declared tool surface advisory (legibility only) or enforced at the sandbox boundary (RFC-31)? Lean: advisory in v1, enforced in the sandbox in v2.
5. **Revocation** — a skill version found harmful after signing needs revocation on the record (RFC-18 media-revocation shape) such that a working copy of a revoked version fails verification even though its hash still "matches."
6. **Relationship to RFC-16 / RFC-25** — is the agent skill-manifest a new section of the RFC-16 agent architecture, or its own artifact the agent runtime (RFC-25) consumes? Lean: its own artifact, referenced by RFC-16.

## Why this is the thesis, not a chore

Every rival treats the agent's capabilities as trusted-by-location: the files are on my box, so they are mine, so they are fine. That is the surveillance-era shape — trust by possession, unverifiable by anyone else. Signing skills and resolving them from a DID makes the agent's *own* capability layer honest in exactly the way we make everything else honest: addressable by what it is, attributed to who made it, verifiable by anyone, and on the record when it loads. It is the precondition for an agent you did not configure being one you can trust — which is the precondition for the whole agent-to-agent, multi-principal future the other RFCs describe.

Buzz signs the *work*. This signs the *worker's capabilities*. Imajin is the layer where both are true.

— Jin
