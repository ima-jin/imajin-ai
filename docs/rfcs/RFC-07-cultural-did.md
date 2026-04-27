---
title: Cultural DID — Identity Primitive for Collectives, Scenes, and Communities of Practice
type: rfc
status: draft
author: "Greg ([@anonymous_observer](https://github.com/anonymous_observer))"
slug: RFC-07-cultural-did
topics:
  - legibility
  - fair
  - identity
  - agents
  - dfos
  - settlement
  - governance
  - events
  - sovereignty
refs:
  issues:
  - 247
  - 114
  - 246
---
# RFC-07: Cultural DID — Identity Primitive for Collectives, Scenes, and Communities of Practice

**Status:** Discussion
**Authors:** Greg ([@anonymous_observer](https://github.com/anonymous_observer))
**Created:** 2026-03-09
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/252

---

*Migrated from #247*

---

## Author
Greg ([@anonymous_observer](https://github.com/anonymous_observer)) — March 9, 2026

## Summary

A fourth identity primitive for entities defined by shared practice rather than legal structure or commercial purpose: art collectives, music scenes, mutual aid networks, festival communities, open-source creative projects.

Neither Person DID nor Org DID captures these. They have no legal incorporation, no single founder, fluid membership, collective creative output, and identity that persists across membership changes.

## Formation Requirements

### Minimum Founding Membership
- Requires **5–7 founding Person DIDs**
- Each founding member must meet a **token context threshold** — trust graph depth, .fair contribution history, attestation count, activity recency
- This is a **performance qualifier, not a financial barrier** — rewards real participation, not capital

### Formation Process
1. Qualifying Person DIDs submit a formation proposal: collective name, declared cultural domain, statement of alignment with network covenant
2. Founding members attest to each other and to the collective identity — each attestation carries the attesting DID's trust weight
3. Combined trust weight of founding members must meet a network-defined threshold
4. Cultural DID is issued — publicly visible identity, privately held membership roster

## Governance Model

### Trust-Weighted Participation
Governance authority is a living reflection of who is actually carrying the collective — measured by contribution history (.fair), activity recency, and trust graph weight within the group.

- Decisions require attestation from members whose combined internal trust weight crosses a **quorum threshold**
- Voting weight is proportional to demonstrated contribution — not one-person-one-vote
- Members with higher token context and .fair contribution records hold greater governance weight
- Stronger Person DIDs can elevate other members into governance positions as membership evolves

### Entry and Removal
- A member enters governance when their token context and contribution weight crosses the governance threshold — not by appointment alone
- A member is removed from governance if they fall below the activity and token context threshold — inactivity is a natural disqualifier
- A member can be removed by weighted quorum if they display behaviour misaligned with the collective's declared values
- **No single Person DID can hold unilateral control** — any action concentrating authority beyond the quorum threshold is structurally blocked
- **Anti-abuse safeguard:** if one Person DID accumulates governance weight beyond a defined ceiling, redistribution is triggered automatically

## Membership Tiers

| Tier | Description |
|------|-------------|
| **Governing Member** | Meets governance threshold. Holds weighted vote on collective decisions. Visible to other governing members. |
| **Active Member** | Meets formation threshold. Full participation in collective activity and .fair splits. Not yet at governance weight. |
| **Participant** | Below formation threshold. Can contribute to collective work and receive .fair attribution. No governance access. |
| **Observer** | Connected via trust graph. Sees public identity and output. No internal access. |

## Membership Privacy

### Public
- Cultural DID identity — name, declared domain, covenant alignment status
- Creative output and .fair attribution records on published work
- Transaction history at the collective level (aggregate, not individual)
- Governance quorum results — decisions reached, not deliberation content

### Private
- Membership roster — who belongs is not publicly visible
- Individual member contribution weights — visible only to governing members
- Internal deliberation and governance activity
- Participant-tier membership — not disclosed externally

### Tiered Visibility
- Full roster: governing members only
- Active member list: active members and above
- External Person DIDs — even trusted ones — see only public identity and published output
- Visibility gates enforced by trust graph and token context level, not manual permissions

## Structural Properties

| Property | Person DID | Org DID | Cultural DID | Agent DID |
|----------|-----------|---------|-------------|-----------|
| Default visibility | Private | Public | Public face, private interior | Scoped to parent |
| Governance | Individual | Anchored founders | Trust-weighted quorum | Parent DID |
| Entry condition | Invite | Vetting + covenant | Quorum + token threshold | Parent authorization |
| Profit motive | N/A | Possible | Structurally excluded | N/A |
| Membership | Individual | Fixed (founders) | Fluid, tiered | Scoped |

## Representative Use Cases
- Art and music collectives producing work under a shared identity
- Intentional festival communities with recurring events and evolving organizers
- Sound healing, meditation, or wellness communities with shared lineage
- Neighbourhood mutual aid networks with rotating coordination
- Open-source creative projects with multiple contributors over time
- Community venues governed by changing stewards
- Local scenes — music, food, craft — wanting shared infrastructure without incorporation

## Open Questions
- Minimum founding member count: 5 or 7? What about legitimate small collectives (trio of artists)?
- Token context threshold values — what counts as 'enough' participation?
- Dissolution mechanics — what happens when active membership drops below formation threshold?
- Treasury management — who signs for collective funds? Quorum-based multi-sig?
- Relationship to pods — Cultural DID as a pod with public identity + governance layer?
- .fair attribution splits within the collective — per-work or standing ratio?
- Cross-node Cultural DIDs — can a collective span multiple nodes?
- Dispute resolution between governing members at quorum deadlock

## Relationship to Existing Primitives
The Cultural DID likely builds on top of the existing **pod** primitive in connections. A pod already has membership and shared context. The Cultural DID adds: public identity, governance model, formation threshold, tiered membership, and treasury capability.

## References
- Current DID types: human, event, service, presence
- Pods: connections.imajin.ai
- .fair attribution: packages/fair
- #114: Declared-Intent Marketplace (Cultural DIDs as economic entities)
- #246: Check-ins (Cultural DIDs as location-associated scenes)
