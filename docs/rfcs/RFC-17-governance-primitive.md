---
title: Governance Primitive
type: rfc
status: draft
author: 'Ryan Veteze, Jin'
slug: RFC-17-governance-primitive
topics:
  - governance
refs:
  rfcs:
    - 13
    - 14
    - 15
    - 7
    - 8
  issues:
    - 500
---
# RFC-17: Governance Primitive

**Status:** Draft  
**Author:** Ryan Veteze, Jin  
**Date:** 2026-03-21  
**Related:** RFC-13 (Progressive Trust), RFC-14 (Community Issuance), RFC-15 (Trust Accountability), RFC-07 (Cultural DID), RFC-08 (Org DID)

---

## Summary

Governance is a universal primitive that applies to every identity scope (actor, family, community, business). Every scope gets a configurable governance model with sensible defaults, TTL'd decisions, and standing-weighted voting. All governance changes are forks. All forks are reversible.

## Core Principle

**Every governance change is a fork. Every fork is reversible.**

No permanent schisms. No irreversible removals. No "you're out forever." The chain records everything — forks, merges, decisions, reversals. The default gravity pulls toward reunion, not separation.

## Governance as Configuration

The system ships with defaults per scope. Communities tune parameters through standing-weighted votes. Nothing is permanent — every decision has a TTL and must be re-ratified or it reverts to the default.

### Defaults by Scope

| Scope | DID Scope | Default Governance | Source of Defaults |
|-------|-----------|-------------------|-------------------|
| Actor | actor | Sovereign — you decide everything | Protocol |
| Family | family | Custodial — guardians govern, members have age-graduated rights | Protocol |
| Community | community | Neutral consensus — sliding scale by size | Protocol |
| Business | org | Industry standards + jurisdiction compliance | Industry + jurisdiction |

### What's Configurable

Every governance parameter is a key-value pair with a TTL. Examples:

- `membership.vouch_threshold` — how many vouches to join (default: 1)
- `membership.standing_minimum` — minimum standing to vote (default: 0)
- `settlement.revenue_split` — how community revenue is distributed
- `moderation.consequence_tiers` — yellow/amber/red/removal thresholds
- `listing.throttle_base` — starting listing slots for sellers
- `governance.quorum_percentage` — what percentage must vote for a change to pass
- `governance.quorum_percentage` is itself configurable — governance can govern itself, with constitutional-tier TTLs

### Decision Tiers

The bigger the decision, the longer the deliberation and the longer it stays in effect. **No deliberation exceeds 7 days.** If a community can't decide in a week, the assists system activates.

| Tier | Example | Deliberation | Mandate TTL |
|------|---------|-------------|-------------|
| Operational | Change listing throttle | 24h vote | 90 days |
| Membership | Raise vouch threshold | 48h vote | 6 months |
| Structural | Change revenue split model | 7-day vote | 1 year |
| Constitutional | Change how voting works | 7-day vote | 2 years |

All decisions expire. All decisions revert to defaults if not renewed. No permanent power grabs.

## Scaling Governance

Governance emerges with growth. You don't "enable governance" — it activates as the group crosses thresholds.

### Community Formation

A community forms (and gets its own DID) when:
- **2+ family-scoped units** connect, OR
- **7+ actor-scoped units** connect

A community isn't a headcount — it's a graph of governance units. Two solo actors are a connection. Two families are a community because each already has internal governance and now needs inter-group governance.

### Governance Modes by Size

| Size | Mode | System Role |
|------|------|------------|
| 1 | Sovereign | None — full control |
| 2 | Bilateral | Conflict → connect to assist |
| 3–10 | Informal consensus | Facilitate discussion, connect to assists |
| 11–50 | Weighted voting | Deliberation periods, quorum defaults |
| 50+ | Formal governance | Scoped decision tiers, constitutional TTLs |

Transitions are automatic. The community never has more process than it needs.

### Assists

When a community hits governance friction (dispute, threshold change, member issue), the system doesn't just say "vote." It connects the community with **assists** — established DIDs with governance attestations in communities of similar size.

Assists are discovered through the trust graph, not appointed. They earn attestations for helping, which raises their standing, which makes them more discoverable. Governance is a skill you earn, not a title you hold.

Communities don't figure everything out from scratch. Community #500 benefits from the patterns Communities #1–499 established — through the people who shaped them being available to help again.

## Voting Weight

Voting weight comes from standing in **that specific community**. Not global standing. Not financial contribution.

- **You can't buy governance.** Standing is earned through attestation history — behavioral, not financial.
- **You can't import governance.** Standing in Community A doesn't transfer to Community B.
- **Governance weight decays.** Stop participating → standing drops → vote weight drops. No absentee landlords.

## Forking

Any change in governance or severance of membership is a fork. Forks are branches in the governance chain — not destruction.

### Fork Semantics

| Event | What Happens | Reversibility |
|-------|-------------|---------------|
| Member leaves | Fork — member's DID exits community graph | Rejoin = merge. Attestation history preserved. |
| Community splits | Two community DIDs, members choose (or both) | Reunite = merge forks. Chain records the split. |
| Family divorce | Family fork — two new family DIDs | Reconcile = merge. Kids exist in both forks (dual custody = dual membership). |
| Business partner exit | Org fork — founder connection is non-severable (historical fact), operational governance forks | Reconnect = merge. |
| Fired employee | Fork from org — attestation history (skills, contributions) goes with the person | Rehire = merge. Org can't erase what was earned. |

Because everything has TTLs, even the act of forking can expire. "I'm leaving" is a governance position that decays if not reaffirmed. Default gravity pulls toward reunion.

The chain is the memory. Forks are branches. Branches can merge.

## Business Scope

Businesses opt into governance defaults that reflect industry standards. This is a choice — the business chooses Imajin knowing what the defaults encode.

- Industry compliance frameworks (food safety, accessibility, employment law)
- Jurisdiction-specific requirements (tax reporting thresholds, labor standards)
- The protocol doesn't invent these rules — it encodes existing ones as default config
- Configurable parameters can be tuned, but the industry floor is the floor

Customers trust businesses on the platform because the platform enforces standards. The business's "by choice" adoption of standards IS the credibility signal.

## Family Scope

Family governance is custodial with graduated autonomy.

- Guardians hold governance control
- Members gain governance weight through age + attestation history
- Family-internal disputes connect to assists (same mechanism as community)
- Family fork (separation) creates two family DIDs, each with full history

## Relationship to Existing RFCs

- **RFC-13 (Progressive Trust):** Standing computation feeds governance weight. Soft → preliminary → established maps to governance participation thresholds.
- **RFC-14 (Community Issuance):** Community issuance points (libraries, credit unions) are communities with org-hybrid governance — they issue credentials under their community's standing.
- **RFC-15 (Trust Accountability):** Vouch chain accountability, bad actor model, consequence tiers — these are all governance *parameters* that communities can tune.
- **RFC-07/08 (Cultural/Org DID):** These scopes get their own governance configs. Cultural DID governance may require quorum. Org DID governance supports delegation hierarchy.

## Device Scope

Devices are actor-scoped DIDs with governance configuration. Same primitive, applied to hardware.

### How It Works

A device DID holds its own governance chain. Permissions are governance parameters — granted, TTL'd, revocable, forkable. No cloud vendor. No phoning home.

| Parameter | Example | TTL |
|-----------|---------|-----|
| `control.allowed_dids` | Who can send commands | Per-grant, owner-set |
| `control.scope` | What they can do (read sensors, push frames, change settings) | Per-grant |
| `control.conditions` | Conditional access (e.g., only when owner is home) | Per-grant |
| `override.human_supersedes` | Human override always wins vs agent/device | Permanent default |

### Identity Typing

Every signed message is typed (`human` / `agent` / `device`). Governance configs can enforce:
- Agents get TTL'd access, never permanent
- Devices can grant each other limited permissions (mesh)
- Human override always supersedes agent/device decisions

### Multi-Device Governance

A group of devices (e.g., "the living room") is a community of device DIDs. Governance scales the same way — 1 device is sovereign, multiple devices need rules about priority and override.

### POC: Remote WLED Control

One controller node governing 4 remote WLED nodes via Maddrix. Each WLED node is a device DID. The controller has permission grants (TTL'd, scoped to frame push) on each node's governance chain. Demonstrates: device identity, remote permission, revocation, multi-node coordination.

## Relationship to DFOS

DFOS provides the substrate:
- **Identity chains** — governance decisions are signed chain entries
- **Countersignatures** — bilateral governance (vouch, attest, approve)
- **Beacons** — proof of governance activity over time
- **Spaces** — potential community containers

Imajin provides the policy layer on top: what the defaults are, how votes work, how standing is computed, how assists are discovered, how forks and merges are recorded.

## Open Questions

1. **Quorum bootstrapping** — what's the default quorum for a brand-new community? Too low = easily captured. Too high = nothing passes.
2. **Cross-community governance** — when communities interact (e.g., shared events), whose governance applies? Intersection? Union? Negotiated?
3. **Governance migration** — if a community forks, how are in-flight votes resolved?
4. **Constitutional amendments** — can a community vote to change the decision tier structure itself? (Probably yes, at constitutional tier with longest TTL.)
5. **Assist compensation** — do assists earn attestations only, or settlement too?

---

*Governance is not a feature. It's a primitive. Every scope has it. Every decision expires. Every fork can merge.*
