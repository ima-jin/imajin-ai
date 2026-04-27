---
title: Progressive Trust Model — graduated permissions on hard DIDs
type: rfc
status: draft
slug: RFC-13-progressive-trust-model
topics:
  - legibility
  - identity
  - agents
  - dfos
  - settlement
  - governance
  - events
  - federation
refs:
  issues:
  - 247
  - 248
  - 244
---
# RFC-13: RFC: Progressive Trust Model — graduated permissions on hard DIDs

**Status:** Draft
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/271

---

## Context

Greg Mulholland drafted a tiered onboarding model (March 2026) that proposes separating **entry** from **full participation**. After discussion with Ryan, the model was refined to use graduated permissions on existing DID types rather than introducing new DID types.

Related: #247 (Cultural DID), #248 (Org DID), #244 (Delegated App Sessions)

## Current State

Two identity tiers:
- **Soft DID** (`did:email:*`) — created via email verification or event magic links. Can attend events, hold tickets, enroll in courses. No profile, no apps, no wallet.
- **Hard DID** (`did:imajin:*`) — keypair-based. Full profile, full access, can do everything.

The gap between soft and hard is binary. You either have full access or almost none.

## Proposal: Three Permission Levels, Two DID Types

Same keypair throughout. Same `did:imajin:*`. What changes is your **standing**, computed from attestation history.

### Soft DID — Visitor
- Attend events, hold tickets, enroll in courses
- No profile, no apps, no wallet
- Created via email/magic link or event check-in

### Hard DID (Preliminary) — Resident
- Full profile (avatar, bio, handle)
- Connect payment rails (wallet active, can transact)
- Use apps (coffee, links, learn, dykil, etc.)
- Message direct connections
- See markets/offers within immediate trust graph
- Browse Cultural DID lobbies, apply to join
- ❌ Cannot vouch for or invite others
- ❌ Cannot create events, Cultural DIDs, or Org DIDs
- ❌ Cannot see extended trust graph (direct connections only)

### Hard DID (Established) — Host
- Everything above, plus:
- Vouch for preliminary DIDs (starts their onboarding period)
- Create events, Cultural DIDs, Org DIDs
- See extended trust graph
- Eligible for governance weight in communities
- Standing visible to the network

## How Progression Works

### Soft → Preliminary
Generate a keypair. Register. You're a preliminary hard DID.

### Preliminary → Established
Requires **both**:
1. **A vouch from an established DID** — someone in good standing sponsors your onboarding
2. **Milestone completion during onboarding period** — the vouch starts a probation window, not instant graduation

### Onboarding Milestones (examples, governance-configurable)
- N verified interactions with established DIDs
- N event attendances (verified physical presence)
- N days on the network (time-gating prevents rush)
- Zero unresolved flags

### Accelerated Path
An established DID can manually vouch and accelerate — but their standing is on the line. Reckless vouching has consequences (see Trust Accountability Framework).

### Automated Path
If no one vouches but a preliminary DID accumulates sufficient attestations organically (through events, check-ins, interactions), the system can surface them to governance bodies for evaluation. The network doesn't require a personal relationship with an existing member — just demonstrated relational behavior.

## Implementation Notes

- **Standing is computed, not assigned.** It's a query over attestation history on `auth.identities`.
- **Attestations are the mechanism.** "Attended event X", "vouched by DID Y", "checked in at Org Z" — typed, signed, verifiable.
- **No new DID type needed.** `did:imajin:*` with a `standing` field derived from attestations.
- **Permission checks** happen at the service level — each API checks the caller's standing tier.
- **Greg's \"context tokens\"** map to attestation count + diversity. Not a new token primitive — just a query shape.

## Open Questions

1. What are the right milestone thresholds? Should they be network-wide defaults or per-Cultural-DID configurable?
2. How long is the onboarding period? Fixed or variable based on activity velocity?
3. Should preliminary DIDs see that they're in an onboarding phase, or is it invisible until they try to do something they can't?
4. Can an established DID be **demoted** back to preliminary? (See Trust Accountability Framework)

## Credit

Core concept from Greg Mulholland's \"Entering the Network\" (March 2026). Architectural grounding by Ryan and Jin.
