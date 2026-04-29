---
title: Org DID — Businesses and Legal Entities
type: rfc
status: draft
date: TBD
author: TBD
slug: RFC-08-org-did
topics:
  - identity
refs:
  issues:
    - 248
    - 247
    - 246
    - 114
    - 117
    - 112
---
# RFC-08: Org DID — Businesses and Legal Entities

**Status:** Discussion
**Authors:** TBD
**Created:** TBD
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/253

---

*Migrated from #248*

---

## Summary

A DID primitive for legally incorporated entities: businesses, nonprofits, cooperatives, registered organizations. Distinct from Cultural DID (#247) in that it has legal structure, fixed founders, and optionally a profit motive.

## Why Separate from Cultural DID

| | Org DID | Cultural DID |
|-|---------|-------------|
| Legal entity | Yes — incorporated or registered | No — exists by participation |
| Founders | Named, with binding authority | Quorum-based, no single authority |
| Profit motive | Allowed | Structurally excluded |
| Membership | Fixed (employees, partners) | Fluid, tiered |
| Governance | Founder-anchored hierarchy | Trust-weighted quorum |
| Entry | Vetting + covenant | Formation threshold + token context |

## Formation

### Requirements
- At least **1 founding Person DID** (the business owner/operator)
- Business declaration: name, category, location (optional), description
- Covenant alignment attestation
- Optional: legal entity reference (business number, incorporation ID)

### Soft Loading (#246)
Org DIDs can be **soft-loaded** via check-in data from users:
- Users check in at a location and record transactions
- A soft Org DID is created — unclaimed, community-built
- When the business owner claims it, they inherit: verified customer count, transaction volume, reviews
- Claiming requires verification (location proof, phone, or existing DID attestation)

## Capabilities

### What an Org DID Can Do
- Appear in trust graphs as a business entity (typed, transparent)
- Receive reviews and check-ins from Person DIDs
- Post commercial messages to trust-graph connections (Tier 1 in #114 — free/low cost)
- Participate in declared-intent marketplace (#114) as a business
- Issue .fair manifests on products and services
- Hold a balance and transact via pay.imajin.ai
- Run an "Ask [Business]" presence (#117 — trust graph queries)

### What an Org DID Cannot Do
- Impersonate a Person DID — typed and labeled as org
- Buy trust-graph position — connections earned, not purchased
- Access private membership of Cultural DIDs
- Bypass gas costs for extended reach

## Governance

- **Founder-anchored** — founding Person DID(s) have administrative control
- **Delegated roles** — founders can add employees/partners with scoped permissions
- **Succession** — founders can transfer ownership to another Person DID
- **Revocation** — founding DID can revoke employee access

## Visibility

- **Public by default** — business name, category, location, .fair records
- **Transaction aggregates** — public (total volume, not individual transactions)
- **Customer list** — private (only the business sees who their customers are)
- **Reviews** — public, tied to reviewer's DID

## Open Questions
- Soft → claimed transition: what verification is sufficient?
- Multi-location businesses — one Org DID or one per location?
- Franchise model — parent Org DID with child locations?
- Employee DID scoping — what can an employee do on behalf of the org?
- Org DID in Cultural DID trust graph — can a business be an observer of a scene?
- Tax/compliance implications of on-network revenue tracking

## Dependencies
- Trust graph (exists)
- Identity tiers (exists)
- Check-in system (#246) for soft loading
- Declared-intent marketplace (#114) for commercial reach
- .fair attribution (exists)

## References
- #246: Check-ins — soft business onboarding
- #247: Cultural DID — the non-commercial counterpart
- #114: Declared-Intent Marketplace
- #112: Revenue streams overview
