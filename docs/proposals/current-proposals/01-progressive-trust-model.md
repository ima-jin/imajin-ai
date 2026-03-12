## 1. Progressive Trust Model — Tiered Onboarding

**Author:** Greg Mulholland (concept), refined with Ryan Veteze and Jin
**Date:** March 2026
**Related upstream:** #247 (Cultural DID), #248 (Org DID), #244 (Delegated App Sessions), #271 (Progressive Trust Model)
**Addresses:** Outstanding Concerns: Governance Equity, Cultural DID specification gaps

### Context

The current identity model has a binary gap: Soft DID (email-verified, almost no access) vs. Hard DID (keypair-based, full access). There is no graduated middle ground. The proposal separates *entry* from *full participation* by computing standing from attestation history rather than from DID type.

Ryan's refinement: graduated permissions on *existing* DID types rather than introducing new DID types. Same keypair throughout. Same `did:imajin:*`. What changes is **standing**, computed from attestation history.

### The Model: Three Permission Levels, Two DID Types

**Soft DID — Visitor**
- Attend events, hold tickets, enroll in courses
- No profile, no apps, no wallet
- Created via email/magic link or event check-in

**Hard DID (Preliminary) — Resident**
- Full profile (avatar, bio, handle)
- Connect payment rails (wallet active, can transact)
- Use apps (coffee, links, learn, dykil, etc.)
- Message direct connections
- See markets/offers within immediate trust graph
- Browse Cultural DID lobbies, apply to join
- ❌ Cannot vouch for or invite others
- ❌ Cannot create events, Cultural DIDs, or Org DIDs
- ❌ Cannot see extended trust graph (direct connections only)

**Hard DID (Established) — Host**
- Everything above, plus:
- Vouch for Preliminary DIDs (starts their onboarding period)
- Create events, Cultural DIDs, Org DIDs
- See extended trust graph
- Eligible for governance weight in communities
- Standing visible to the network

### Progression

**Soft → Preliminary:** Generate a keypair. Register. Immediately a Preliminary hard DID.

**Preliminary → Established:** Requires both:
1. A vouch from an Established DID — someone in good standing sponsors onboarding
2. Milestone completion during onboarding period — the vouch starts a probation window, not instant graduation

**Onboarding Milestones** (examples, governance-configurable):
- N verified interactions with Established DIDs
- N event attendances (verified physical presence)
- N days on the network (time-gating prevents rush)
- Zero unresolved flags

**Accelerated path:** An Established DID can manually vouch and accelerate — but their standing is on the line. Reckless vouching has consequences (see Trust Accountability Framework below).

**Automated path:** If no one vouches but a Preliminary DID accumulates sufficient attestations organically (through events, check-ins, interactions), the system can surface them to governance bodies for evaluation. The network doesn't require a personal relationship with an existing member — just demonstrated relational behavior.

### Clarification on Preliminary DID Connections

Preliminary DIDs can *receive and accept* connections from Established DIDs. They can message within those direct connections. What they cannot do is vouch, invite, or initiate connections to other Preliminary DIDs.

The network comes to you through people who are already trusted. The preliminary phase is immediately useful — you're not in a waiting room. The restriction is on outbound trust actions (vouching, inviting), not on inbound relationships.

### Implementation Notes

- Standing is computed, not assigned — it's a query over attestation history on `auth.identities`
- Attestations are the mechanism: "attended event X", "vouched by DID Y", "checked in at Org Z" — typed, signed, verifiable
- No new DID type needed — `did:imajin:*` with a `standing` field derived from attestations
- Permission checks happen at the service level — each API checks the caller's standing tier
- Greg's "context tokens" map to attestation count + diversity — not a new token primitive, just a query shape

### Open Questions

- What are the right milestone thresholds? Network-wide defaults or per-Cultural-DID configurable?
- How long is the onboarding period? Fixed or variable based on activity velocity?
- Should Preliminary DIDs see that they're in an onboarding phase, or is it invisible until they try to do something they can't?
- Can an Established DID be demoted back to Preliminary? (See Trust Accountability Framework)

---

