## STATUS: SPEC ADOPTED
**Adopted:** 2026-03-17
**Evidence:** `docs/rfcs/RFC-14-community-issuance-network.md` in upstream main (HEAD 23b9f2a). RFC-14 explicitly credits Greg Mulholland's "The Commons Layer" (March 2026) as the core concept source.
**Outcome:** The core insight (EventDID check-in as community-anchored identity issuance, generalizing to libraries, credit unions, schools, etc.) adopted verbatim. Institution-as-issuance-point model, the Protocol vs. Product table (Foundation/Inc.), and the public-option-for-digital-identity framing all incorporated. Prior art section added by Ryan (zakat, waqf, potlatch, tithe). Open questions remain: institution registration path, verification standard, Foundation certification role, timeline.
**Implementation:** In spec only — RFC-14 is a Draft, no code yet.

---

## 3. The Commons Layer — Community-Anchored Identity Issuance

**Author:** Greg Mulholland
**Date:** March 2026
**Related upstream:** #271 (Progressive Trust Model), #247 (Cultural DID), #249 (Plugin Architecture), Discussion #269 (MJN Token Economics / Foundation)
**Addresses:** Outstanding Concerns: Governance Equity (by expanding who can issue identity)

### The Insight

Imajin's EventDID check-in model is, structurally, a **community-anchored identity issuance network**. A person scans a ticket, passes an ID check, receives a DID. The physical body is the proof of work. This generalizes: the gate is any verifiable in-person interaction at a trusted institution.

| Institution | Issuance Context |
|-------------|-----------------|
| Imajin events | EventDID check-in (exists today) |
| Libraries | Library card issuance → DID |
| Credit unions | Account opening → DID |
| Community orgs | Membership verification → DID |
| Medical practices | Patient verification → DID |
| Schools/universities | Student verification → DID |

Each institution becomes an issuance point. The DID they issue carries an attestation: "verified in-person by [institution DID] on [date]." Cross-institution trust: a DID issued at a library carries weight at a credit union because both are on the same trust network.

### How This Maps to Existing Architecture

**What already exists:**
- Ed25519 keypair identity — no platform issues it, no platform can revoke it
- EventDID — events as first-class identity-issuing entities
- Federated nodes — anyone can run a node (`registry.imajin.ai`)
- MJN Foundation (planned) — protocol stewardship separate from Imajin Inc.

**What this adds:**
- Institutional DID type — a new DID category for trusted issuance points, or an Org DID with issuance attestation rights
- Issuance attestations — "DID X was verified in-person by Institution Y" as a first-class attestation type
- Issuance point registry — how institutions register as trusted issuers (likely through the federated node model)

### Imajin Protocol vs. Imajin Product

| | Imajin Protocol (Foundation) | Imajin Product (Inc.) |
|---|---|---|
| Owns | DID spec, trust primitives, settlement protocol | Reference implementation, UX, community tools |
| Governed by | Foundation board, weighted by community contribution | Imajin Inc. (Canadian corp) |
| Revenue | Protocol fees (mint/burn spread, settlement micro-fees) | Operator excellence, premium features, node hosting |
| Analogy | HTML/HTTP | Netscape/Chrome |

The protocol is a public good. The product competes on operator excellence. Open protocol makes the product more valuable because the network is larger.

### Why This Matters

There is currently no public option for digital identity. Every major system (Google, Apple, Meta) extracts value from the identity it holds hostage. Government IDs have no digital-native form in most jurisdictions.

A community-anchored issuance network means:
- Identity doesn't require a smartphone with a proprietary OS
- Identity doesn't require an advertising account
- Identity doesn't require a government to issue it
- Identity requires a trusted human to verify that a body exists — and cryptographically record that verification

### Open Questions

- How do institutions register as issuance points? Through the federated node model, or a separate registration path?
- What level of verification is required? Government ID check? Or is institutional trust sufficient?
- How does this interact with MJN Foundation governance? Does the Foundation certify issuance points?
- Timeline: Year 1 (product), Year 2 (protocol), or Year 3 (public infrastructure)?

---

