# RFC-35: Context-Bound Connection — Relationship as the Boundary

**Status:** Draft
**Author:** Ryan Veteze, Jin
**Date:** 2026-06-21
**Related:** RFC-13 (Progressive Trust Model), RFC-17 (Governance Primitive), RFC-29 (Biometric Trust Escalation), RFC-34 (Community Needs Brokerage), RFC-27 (Multi-Agent Coordination), RFC-10 (Sovereign User Data), RFC-01 (.fair Attribution)
**Issues:** #1097 (broker-mediated social coordination), #1103 (broker config-driven), #241 (calendar primitive)

---

## Summary

Online child-safety law has converged on a single mechanism: **verify the user's age at a global checkpoint.** Australia's *Online Safety Amendment (Social Media Minimum Age) Act 2024* (in force 10 Dec 2025) is the reference implementation, and six months in it is failing on both ends — children route around it with fake birthdates and borrowed accounts, and the verification vendors that collect the ID become breach honeypots (AU10TIX 2024, Discord/Zendesk 2025, Persona 2026).

This RFC argues the mechanism is aimed at the wrong axis. Age is a crude proxy for the thing a parent actually cares about: **who their child can reach, and in what context.** Imajin already has the primitives to make *the context itself the boundary* — a connection that only exists because a real relationship was attested, and that therefore needs no checkpoint to bypass and holds no identity to leak.

We define **context-bound connection**: a scope whose membership is computed from the mutual-consent trust graph, whose edges are derived from attestations issued by humans (parents, schools, registrars), and whose reach is graduated, time-conditioned, portable, and revocable.

## Problem

The prevailing model asks: *"Is this user ≥16?"* A binary, global, identity-revealing gate. It fails structurally:

1. **It regulates a proxy.** Age stands in for trust and relationship. A parent's real question is "who is my kid connected to?" — which age never answers. A verified-16 stranger is still a stranger.
2. **The gate invites circumvention.** A global checkpoint is a single thing to defeat. Fake DOB, borrowed account, VPN. (Australia, six months: usage among under-16s down only marginally.)
3. **It manufactures honeypots.** Centralized verification requires mass collection of IDs and biometrics. The collection *is* the liability. Disclosure-minimization is structurally against the verification vendor's business model — they cannot offer "prove the predicate, keep nothing."
4. **It pushes harm sideways.** Platforms themselves warned the ban drives minors to *less* regulated spaces. A blunt gate doesn't shape the relationship graph; it just relocates it.

The harm regulators are reaching for — "children interacting with strangers," "overnight exposure" — are **relationship and context problems wearing an age-shaped mask.**

## Design

### Reframe: the context is the boundary

Imajin does not verify age to grant access. It makes a connection *exist or not exist* based on attested relationships. A child's connectable set in, say, a game is not a filtered list — it is a **scope** (RFC-17 governance primitive: scope type + role hierarchy + reactor chains) whose membership is the trust graph itself.

The seed case: a child's game-connection set = a **family-bound context** = the graph of mutual-friend parents and their children.

```
Parent A (1°) ──attests friendship──> Parent B (1°)
     │                                      │
   child_a ──derived edge (2-hop)──── child_b
```

- **Membership is computed, not declared.** Parents are first-degree connections who mutually attest. Their children inherit a *derived edge* (2-hop). The "who can my kid talk to" set falls out of real relationships, not a 13-year-old's self-declared friend list.
- **Connection requires mutual attestation, not a global check.** Two parents attest the friendship → the children get a sealed, scoped channel. This is the RFC-34 / #1097 broker invariant applied to childhood: **nothing leaves the broker unless a match already exists.** No mutual attestation = no edge = nothing to bypass.

### Predicate attestation, never identity (the age case, done right)

Where a hard age predicate is genuinely required, it becomes a **selective-disclosure attestation** (RFC-13 progressive trust, RFC-29 escalation):

```
issuer:   did:imajin:parent_a   (or school / clinic / registrar)
subject:  did:imajin:child_a
claim:    { age_band: ">=16" }     ← predicate only
sig:      [Ed25519]
```

The relying platform receives **a signed yes/no on the predicate** — verifiable, revocable — and learns nothing else. No DOB, no legal name, no ID photo, no selfie in a vendor bucket. This is precisely what the Australian regime *wishes* it had mandated and structurally could not: centralized vendors can't sell disclosure-minimization.

### Graduated reach

Reuse the #1097 reach ladder (favourites / 1° / strangers) as a safety gradient:

| Reach tier | Meaning for a child context | Interaction surface |
|------------|------------------------------|---------------------|
| **Stranger** | No shared scope exists | *No channel at all* — not blocked, non-existent |
| **1° (friend-of-attested-parent)** | Derived edge via parental attestation | Scoped, time-boxed, monitorable text |
| **Favourites (family-bound set)** | Inner mutual-friend graph | Richer: voice, livestream, play |

The key inversion: the platform does not *block* strangers. **Strangers were never reachable**, because there is no edge to traverse. "Preventing children from interacting with strangers" stops being an enforcement arms race and becomes a property of the graph.

### Parent as issuer — revocable, human-mediated

Today "parental consent" is a checkbox the platform stores and forgets. Here it is an **attestation the parent holds and can revoke** (RFC-10 sovereign user data, RFC-18 revocation pattern):

1. The parent issues the attestation / friendship edge. The parent — a human — holds the key.
2. Revoke the attestation → the derived edges collapse → the connections evaporate.
3. Governance is structural (scope + role + reactor chain), not a support ticket.

This is Imajin's "human-mediated governance layer" pointed at childhood: a *human* holds the key, not an algorithm (platform) and not code-is-law (pure crypto).

### Time and place as scope conditions

Regulators reaching for "overnight curfews" are hacking the platform. In Imajin a curfew is a **reactor condition on the scope** — the family-game context is active 16:00–20:00, dormant otherwise. This is the same machinery as the calendar primitive (#241) and availability intent (#1099): the child's connectable window is a *configured availability*, not a platform-enforced bedtime.

### Portability — the child owns the graph

A DID + scope makes the family-bound context **portable across games and apps**. A new game consumes the existing attested scope; no re-verification, no fresh ID upload, no new honeypot. The trust graph is the user's, carried between contexts — "Imajin is a browser / an open wallet," applied to safety.

### Proof-of-history without surveillance

Regulators want auditability. Imajin produces a **signed, append-only record that the predicate was satisfied and the consent existed** — the platform proves compliance *without retaining a single child's identity document.* Compliance and privacy stop being a tradeoff.

> **Positioning line:** *Prove you checked, without keeping what you'd be breached for.*

## Mapping to existing primitives

This is a **configuration of the existing kernel**, not new infrastructure. Same shape as Tripian (traveler-intent ∩ venue-intent) and #1097 social coordination — here it is *parent-attestation ∩ parent-attestation → derived child edge.*

| Primitive | Role in context-bound connection |
|-----------|----------------------------------|
| **Attestation** | Parental consent + age-band predicate; issued by humans, revocable |
| **Communication** | The scoped, time-conditioned channel between derived edges |
| **Discovery / Broker** | Mutual-consent matching; no edge unless both sides attest (RFC-34, #1097) |
| **Identity** | The family-bound scope as a group identity (RFC-17, RFC-08 org-DID pattern) |
| **Attribution / Settlement** | Out of scope for child safety; omitted by design |

## Non-Goals

- Not a content-moderation system. This governs *who can reach whom in what context*, not what they say.
- Not a replacement for human parenting. It gives parents a *key*, not an algorithm that decides for them.
- Not a claim that age never matters. Where a hard predicate is required, we satisfy it via selective disclosure rather than removing it.

## Open Questions

1. **Bootstrapping the parent graph.** How do two parents establish the first mutual attestation with low friction (QR at a playdate? school-issued roster scope?).
2. **Asymmetric households.** Divorced/guardianship cases — multiple issuers over one child subject; conflict-resolution in the reactor chain.
3. **Regulator interface.** What does the audit endpoint look like such that an eSafety-style regulator accepts "predicate satisfied + consent existed" as proof without demanding the underlying identity?
4. **Platform adoption path.** Does a platform consume this as an RFC-09 plugin, or via a thin attestation-verification API? Likely both.
5. **Age-band issuer trust.** Which issuers (parent, school, clinic, state) are accepted for which predicates, and how does progressive trust (RFC-13) weight them?

## Prior Art / Contrast

- **Australia OSA (Min Age) 2024** — global age gate, centralized verification. The thing this RFC is a counter-design to.
- **UK "Australia-plus"** (announced Jun 2026) — same axis, more scope (livestream limits, stranger-interaction limits, curfews). Each of those is a *scope/reactor condition* here, not a platform hack.
- **RFC-34 Community Needs Brokerage** — same mutual-consent-before-reveal invariant, different domain.
- **RFC-29 Biometric Trust Escalation** — the escalation ladder this borrows for predicate issuance.
