---
title: Community Issuance Network — trusted institutions as identity entry points
type: rfc
status: draft
slug: RFC-14-community-issuance-network
topics:
  - identity
  - agents
  - dfos
  - settlement
  - governance
  - events
  - federation
refs:
  issues:
  - 271
  - 247
  - 249
  - 269
---
# RFC-14: RFC: Community Issuance Network — trusted institutions as identity entry points

**Status:** Draft
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/272

---

## Context

Greg Mulholland's "Commons Layer" proposal (March 2026) argues that Imajin's identity architecture has implications beyond the product — it's a prototype for **public digital identity infrastructure**. The key insight: any trusted institution can be an identity issuance point.

Related: #271 (Progressive Trust Model), #247 (Cultural DID), #249 (Plugin Architecture), Discussion #269 (MJN Token Economics / Foundation)

## The Insight

Imajin's EventDID check-in model is, structurally, a **community-anchored identity issuance network**. A person scans a ticket, passes an ID check, receives a DID. The physical body is the proof of work.

This generalizes. The gate is any **verifiable in-person interaction** at a trusted institution:

| Institution | Issuance Context |
|---|---|
| Imajin events | EventDID check-in (exists today) |
| Libraries | Library card issuance → DID |
| Credit unions | Account opening → DID |
| Community orgs | Membership verification → DID |
| Medical practices | Patient verification → DID |
| Schools/universities | Student verification → DID |

Each institution becomes an **issuance point** on the network. The DID they issue carries an attestation: "verified in-person by [institution DID] on [date]."

## How This Maps to Existing Architecture

### What already exists
- **Ed25519 keypair identity** — no platform issues it, no platform can revoke it
- **EventDID** — events as first-class identity-issuing entities
- **Federated nodes** — anyone can run a node (registry.imajin.ai)
- **MJN Foundation** (planned) — protocol stewardship separate from Imajin Inc.

### What this adds
- **Institutional DID type** — a new DID category for trusted issuance points (or an Org DID with issuance attestation rights)
- **Issuance attestations** — "DID X was verified in-person by Institution Y" as a first-class attestation type
- **Issuance point registry** — how institutions register as trusted issuers (probably through the federated node model)
- **Cross-institution trust** — a DID issued at a library carries weight at a credit union because both are on the same trust network

## Imajin Product vs. Imajin Protocol

Greg's framing (and Ryan's existing architecture) separates these cleanly:

| | Imajin Protocol (Foundation) | Imajin Product (Inc.) |
|---|---|---|
| **Owns** | DID spec, trust primitives, settlement protocol | Reference implementation, UX, community tools |
| **Governed by** | Foundation board, weighted by community contribution | Imajin Inc. (Canadian corp) |
| **Revenue** | Protocol fees (mint/burn spread, settlement micro-fees) | Operator excellence, premium features, node hosting |
| **Analogy** | HTML/HTTP | Netscape/Chrome |

The protocol is a public good. The product competes on operator excellence. Open protocol makes the product *more* valuable because the network is larger.

## Why This Matters

There is currently **no public option** for digital identity. Every major system (Google, Apple, Meta) extracts value from the identity it holds hostage. Government IDs have no digital native form in most jurisdictions.

A community-anchored issuance network means:
- Identity doesn't require a smartphone with a proprietary OS
- Identity doesn't require an advertising account
- Identity doesn't require a government to issue it
- Identity requires a **trusted human to verify that a body exists** — and cryptographically record that verification

## Open Questions

1. How do institutions register as issuance points? Through the federated node model, or a separate registration path?
2. What level of verification is required? Government ID check? Or is institutional trust sufficient (library card, membership roll)?
3. How does this interact with the MJN Foundation governance? Does the Foundation certify issuance points?
4. Timeline: is this Year 1 (product), Year 2 (protocol), or Year 3 (public infrastructure)?

## Credit

Core concept from Greg Mulholland's "The Commons Layer" (March 2026). Architectural grounding from Imajin's existing federated node model and MJN Foundation plans.

## Prior Art: Protocol-Level Redistribution

The idea of building wealth redistribution into a systems rules — rather than leaving it to voluntary charity — has deep historical precedent.


## Prior Art: Protocol-Level Redistribution

The idea of building wealth redistribution into a system's rules — rather than leaving it to voluntary charity — has deep historical precedent.

### Zakat (Islamic finance, ~624 CE)
An obligatory 2.5% levy on net assets held for one year. Not charity — a structural mechanism. Key properties that align with MJN:
- **Formulaic, not discretionary** — clear rates on specific asset classes, no committee debates
- **Individual accountability** — assessed and distributed by the holder, not a central authority
- **Penalizes idle wealth** — only applies to assets held without productive use, incentivizing circulation
- **Directed to specific categories** — the poor, debtors, travelers, new community members (8 defined categories in Quran 9:60)

### Waqf (Islamic endowments, ~7th century)
Permanent assets (land, buildings, funds) whose revenue is directed to community benefit in perpetuity. The asset itself cannot be sold or inherited — only the yield flows. Structurally similar to protocol-level fee pools where the protocol is the permanent asset and micro-fees are the yield.

### Potlatch (Pacific Northwest Indigenous, pre-contact)
Ceremonial redistribution where status is earned by *giving away* wealth, not accumulating it. Leadership through generosity. Analogous to the trust graph model where reputation is built through contributions and attestations, not extraction.

### Tithe (Judeo-Christian, ~1500 BCE)
10% of produce directed to community infrastructure (temples, priests, the poor). Evolved into the first "subscription model" — but originally a protocol-level community funding mechanism.

### The Pattern

Every major civilization independently discovered that sustainable communities require **structural redistribution** — wealth circulation baked into the rules, not dependent on goodwill. MJN's fee model (capped micro-fees, attention marketplace, community-directed flow via trust graph) is the same pattern with protocol-level tooling. The mechanism is 1,400+ years old. The implementation is new.
