# RFC-34: Community Needs Brokerage

**Status:** Draft  
**Author:** Ryan Veteze, Jin  
**Date:** 2026-05-25  
**Related:** RFC-04 (Settlement Protocol), RFC-13 (Progressive Trust), RFC-17 (Governance Primitive), RFC-01 (.fair Attribution), RFC-09 (Application Plugin Architecture), RFC-29 (Biometric Trust Escalation)

---

## Summary

A community plugin that lets members anonymously broadcast needs and capabilities, matches them through the broker, reveals identity only on mutual consent, and aggregates anonymized data into community intelligence. The system removes the single biggest barrier to mutual aid: having to ask.

## Problem

Every existing mutual aid system — GoFundMe, Buy Nothing groups, community spreadsheets, Nextdoor — requires the person in need to publicly identify themselves and ask for help. This creates three failures:

1. **Dignity barrier.** Most people who need help won't ask for it publicly. The need goes unmet.
2. **Social pressure.** Visible asks create obligation dynamics. Helpers feel guilted; recipients feel indebted.
3. **No aggregate picture.** Individual asks don't compose into community-level understanding. Nobody knows what their community actually needs.

## Design

### Two-Phase Matching

The core mechanism is blind matching with consent-gated reveal.

**Phase 1: Blind Match**

Members post needs and capabilities as typed attestations against their DID. These are visible to the broker but not to other members directly.

```
Need:  { type: "financial", category: "groceries", amount: 400, currency: "CAD", recurring: "monthly" }
Need:  { type: "item", category: "appliance", description: "toaster" }
Need:  { type: "employment", category: "part-time", skills: ["carpentry", "general-labour"] }
Offer: { type: "financial", category: "groceries", maxAmount: 500, currency: "CAD" }
Offer: { type: "item", category: "appliance", items: ["toaster", "microwave"] }
Offer: { type: "service", category: "transport", description: "truck available Saturdays" }
```

The broker matches needs to offers by type and category. When a match exists, the broker notifies the offering party:

> "Someone in your community needs help with groceries (~$400/month). You said you can help with that. Interested?"

No identity. No details beyond the category and magnitude. Accept or pass.

**Phase 2: Consent Reveal**

On acceptance, both parties are connected. The reveal is graduated:

1. **Initial:** First name + in-app chat channel. Enough to coordinate.
2. **Confirmed:** Both parties confirm they're proceeding. Full profile visible.
3. **Completed:** Bilateral completion attestation. Both sign.

Either party can withdraw at any point before confirmation. If the helper withdraws after reveal, the need re-enters the matching pool — the person in need doesn't have to re-post.

### Needs as Attestations

Every need and offer is a signed attestation against the member's DID, stored in the community's attestation chain. This gives us:

- **Authenticity.** Every need is tied to a real identity (even if anonymous to other members).
- **History.** Completed exchanges build a verifiable record. Over time, a member's history of fulfilled exchanges *is* their reputation — without a score.
- **Selective disclosure.** The member controls who sees what. The broker sees the typed data. Other members see nothing until consent.

### Trust-Gated Verification

For sensitive needs (financial, housing), the system can require trust-graph verification before a need enters the matching pool:

> "This need has been verified by 2 members within your trust graph."

The verifiers don't see the helper. The helper doesn't see the verifiers. The system attests that real people who know this person confirmed the need is genuine. This uses the existing progressive trust model (RFC-13) — no new trust infrastructure needed.

### Accountability Without Scores

No ratings. No stars. No reputation scores. Instead:

- **Completion attestations.** Bilateral. Both parties sign "this exchange happened." Presence of the attestation is the signal.
- **Ghost protection.** If a helper accepts, gets connected, then disappears — that's a non-completion. Visible in their attestation history as an accepted-but-uncompleted match. Not a punishment, but a pattern that the broker can factor into future matching priority.
- **Community standing.** The governance primitive (RFC-17) already defines standing. Needs brokerage inherits it. High-standing members might get priority matching. Low-standing members might require additional verification.

## Aggregated Community Intelligence

### The k-Anonymity Layer

Members consent to share anonymized need data with the platform for reporting purposes. Individual needs are never exposed. Aggregated data only becomes visible when the k-anonymity threshold is met:

- **Minimum threshold: 10 responses per category** before data aggregates.
- Below threshold: category shows "insufficient data."
- Above threshold: community dashboard shows aggregate statistics.

This is a structural privacy guarantee, not a policy. You literally cannot reverse-engineer who needs what until enough people have reported the same category.

### Community Dashboard

Each community with the plugin gets a live dashboard:

```
┌─────────────────────────────────────────────┐
│  Community Needs (this month)               │
│                                             │
│  Employment       ████████████  34 members  │
│  Financial        ███████████   28 members  │
│    avg shortfall: $1,400/mo                 │
│  Items            ████          12 members  │
│    avg value: <$100                         │
│  Services         ███           9 members   │
│  Housing          ██            [below 10]  │
│                                             │
│  Matched: 47  │  Fulfilled: 31  │  Active: 16│
│  Total value moved: $8,400                  │
└─────────────────────────────────────────────┘
```

This tells the community what it needs without telling it who needs it.

### Cross-Community Intelligence (Layer 3)

When multiple communities run the plugin, anonymized data can aggregate across communities (with each community's consent). This produces neighborhood-scale, real-time needs data:

- More current than census data (years old)
- Less self-selecting than surveys
- Structurally anonymized via k-anonymity
- Updated continuously

This data is valuable to local governments, nonprofits, foundations, and researchers — organizations that spend billions trying to understand exactly this. Revenue from data access shares back to participating communities through .fair.

## Transactions

Needs fulfillment can happen on-platform:

- **Financial needs** → MJNx settlement. Helper sends funds directly through the community node. .fair manifest records the exchange.
- **Item needs** → Marketplace listing in reverse. The item is offered, accepted, and the handoff is attested.
- **Service needs** → Coordination through chat. Completion attested bilaterally.

Every transaction flows through .fair. The community has a complete, auditable ledger of mutual support.

### Community Pool (Optional Module)

Communities can optionally activate a pooled fund:

- Members deposit a fixed monthly amount into the community's MJNx balance.
- The pool is governed by the community's governance model (RFC-17).
- Pool funds can fulfill financial needs that don't get individual matches.
- Distribution policy is configurable: equal, need-weighted, contribution-weighted, or hybrid.
- All pool movements go through .fair with full attribution.

The pool is a complement to direct matching, not a replacement. Most needs should match directly. The pool catches what falls through.

## Plugin Architecture

This is a community node plugin (RFC-09), not a standalone app.

### Activation

A community admin activates the Needs Brokerage plugin. On activation:

1. Plugin registers its attestation types with the community's attestation chain.
2. Broker service starts listening for need/offer attestations within the community scope.
3. Community dashboard becomes available to admins and members (configurable visibility).
4. Members see "Post a Need" and "Offer Help" in their community interface.
5. k-anonymity reporting is enabled with community-level consent.

### Service Cost

Monthly fee per community. Tiered by community size:

| Tier | Members | Monthly Fee |
|------|---------|-------------|
| Small | 1–50 | $25 |
| Medium | 51–200 | $75 |
| Large | 201–1000 | $150 |
| Enterprise | 1000+ | Custom |

Fee goes through .fair. Revenue attribution: platform (Imajin) + community node operator + data layer (if opted in).

### Data Consent

On plugin activation, the community votes (via governance primitive) on:

1. **Internal reporting:** Aggregate dashboard visible to community members. (Required for plugin activation.)
2. **Cross-community reporting:** Anonymized data shared with the platform for multi-community aggregation. (Optional. Enables revenue share.)
3. **Institutional access:** Anonymized aggregate data available to approved third parties (governments, nonprofits). (Optional. Enables additional revenue share.)

Each level requires explicit community consent. Each level unlocks additional .fair revenue flowing back to the community.

## Primitives Used

| Primitive | Usage |
|-----------|-------|
| Attestation | Needs, offers, verifications, completions |
| Broker | Blind matching, consent-gated reveal |
| Settlement (MJNx) | Financial need fulfillment, pool deposits/withdrawals |
| .fair | Transaction attribution, revenue sharing, data access fees |
| Selective Disclosure | Need visibility, graduated reveal, k-anonymity |
| Trust Graph | Verification gating, match priority, community standing |
| Governance | Pool policy, data consent, plugin configuration |

Every primitive already exists. This plugin is composition.

## What This Isn't

- **Not charity.** It's bilateral exchange within a community. Everyone posts needs *and* offers.
- **Not a rating system.** No scores, no reviews. Completion attestations are facts, not judgments.
- **Not surveillance.** The platform never sees individual needs. Only the community's broker does, and it's scoped to the community.
- **Not a replacement for social services.** It's a complement. The aggregated data might help social services target resources better, but the plugin itself is community-to-community mutual support.

## Implementation Path

1. **Phase 1:** Need/offer attestation types. Manual matching by community admin. No dashboard.
2. **Phase 2:** Automated broker matching. Consent-gated reveal flow. Completion attestations.
3. **Phase 3:** Community dashboard with k-anonymity aggregation. On-platform transactions.
4. **Phase 4:** Cross-community aggregation. Institutional data access. .fair revenue sharing.

Phase 1 could ship as a thin layer on existing attestation + chat infrastructure. The broker matching (Phase 2) is the real product.

---

*"You don't have to ask. Just tell us what you need. We'll find someone who already wants to help."*
