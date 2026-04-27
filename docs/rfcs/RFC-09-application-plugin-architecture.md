---
title: Application Plugin Architecture — Third-Party Apps, Launcher Dock, and Dev Bounties
type: rfc
status: draft
date: TBD
author: TBD
slug: RFC-09-application-plugin-architecture
topics:
  - legibility
  - fair
  - agents
  - settlement
  - governance
  - events
  - sovereignty
refs:
  issues:
  - 249
  - 244
  - 248
  - 247
  - 246
  - 114
---
# RFC-09: Application Plugin Architecture — Third-Party Apps, Launcher Dock, and Dev Bounties

**Status:** Discussion
**Authors:** TBD
**Created:** TBD
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/254

---

*Migrated from #249*

---

## Parent: #244

## Summary

An open application ecosystem where developers build apps that plug into the Imajin stack. Users choose which apps appear in their launcher/dock. Apps authenticate through delegated sessions (#244), settle through pay, and attribute through .fair.

This extends #244 (delegated app sessions) from "apps can use Imajin auth" to "apps are first-class citizens of the network."

## How It Works

### For Users
1. Browse available apps in the registry (registry.imajin.ai already exists)
2. Add an app to their launcher/dock
3. Agree to the app's usage policy and data scope (granular consent from #244)
4. App appears in their nav alongside core services
5. Revoke anytime — app loses access, disappears from launcher

### For Developers
1. Build an app to the delegated session spec (#244)
2. Register it in the Imajin registry with: name, description, required scopes, hosting model
3. App is discoverable by all users (or tier-gated)
4. Earn revenue through settlement fees on transactions within the app
5. .fair attribution on the app itself — if someone forks/extends your app, you get attributed

### Hosting Models
- **Remote** — developer hosts the app on their own infrastructure, authenticates via delegated session
- **Node-hosted** — app package installable on a community node (like a WordPress plugin)
- **Hybrid** — light frontend on node, heavy compute remote

## App Ideas (Third-Party Bounties)

### Music & Creative
- **Label management** — release scheduling, royalty splits (.fair native), catalog
- **Digital distribution** — push to DSPs, reporting, .fair revenue tracking
- **Gallery/portfolio** — curated media showcase with .fair attribution

### Business & Commerce
- **Booking/scheduling** — trust-graph-scoped availability, appointment management
- **Inventory/POS** — for Org DIDs (#248) running physical locations
- **Accounting** — transaction reporting from pay.imajin.ai settlement data
- **Invoicing** — DID-to-DID billing with .fair attribution

### Community
- **Email/newsletter** — trust-graph-scoped broadcasts (sovereign, not Mailchimp)
- **Surveys/polls** — community decision-making, DYKIL-adjacent
- **Governance tools** — for Cultural DIDs (#247), weighted voting UI
- **Ticketing extensions** — season passes, memberships, recurring events

### Infrastructure
- **Cloud hosting** — node infrastructure as a service
- **Analytics** — node operator dashboard, traffic, settlement volume
- **Backup/export** — sovereignty insurance, portable data packages
- **Monitoring** — health checks, uptime, alerting for node operators

## Bounty Model

Apps specced as GitHub issues with:
- `bounty` label
- Clear spec + required scopes + data model
- Settlement-fee-sharing model (app developer earns ongoing % from usage)
- Acceptance criteria

Developer picks up the bounty → builds to spec → submits for review → ships to registry → earns from usage.

This is not a one-time payment. The developer earns settlement fees for as long as their app generates transactions. Aligned incentives.

## Registry Integration

The app launcher already exists and is registry-driven. Extensions needed:

- [ ] App listing with install/uninstall per user
- [ ] Per-user launcher customization (which apps appear in your dock)
- [ ] Usage policy display and consent flow
- [ ] App review/rating system (trust-graph-scoped reviews, like #246 for places)
- [ ] Developer dashboard — installs, usage, revenue

## Dependencies
- Delegated app sessions (#244) — the auth foundation
- Registry (exists — needs app listing extensions)
- App launcher (exists — needs per-user customization)
- Pay service (exists — needs app-scoped settlement)
- .fair (exists — app attribution)

## Open Questions
- App review/vetting process before appearing in registry? Or open and community-moderated?
- Sandboxing for node-hosted apps — what can a plugin access on the node?
- App versioning and update mechanism
- Revenue share model — what % goes to app dev vs node operator vs protocol?
- Can an app require specific DID tiers? (e.g., "only available to Org DIDs")
- Plugin dependency management — can apps depend on other apps?

## References
- #244: Delegated App Sessions
- #247: Cultural DID (governance tools as app)
- #248: Org DID (business tools as apps)
- #246: Check-ins
- #114: Declared-Intent Marketplace
