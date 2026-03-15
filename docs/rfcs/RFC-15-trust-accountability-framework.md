# RFC-15: RFC: Trust Accountability Framework — bad actor detection, consequences, and vouch chain responsibility

**Status:** Draft
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/273

---

## Context

Greg Mulholland's onboarding proposal (March 2026) includes a detailed bad actor model that's currently missing from the Imajin architecture. The existing system has connections and trust graph queries but **no formalized consequence model** for bad behavior.

Related: #271 (Progressive Trust Model), #247 (Cultural DID), #248 (Org DID)

## The Gap

Currently, if someone behaves badly on the network, the only recourse is:
- Manual intervention by Ryan (doesn't scale)
- Removing connections (informal, no network-wide effect)
- Nothing

There's no flagging system, no consequence tiers, no vouch chain accountability, and no path for rehabilitation.

## Behavioral Categories (not ideological)

Imajin is not in the business of ideological policing. The model is **behavioral**, defining patterns that undermine trust, accountability, and non-extraction.

### Category A — Extraction and Exploitation
- Commercial solicitation in non-commercial community spaces
- Using trust graph access to harvest contact or behavioral data
- Manufacturing fake vouches or coordinated identity deception
- Sockpuppet or Sybil behavior to manipulate governance weight

### Category B — Relational Harm
- Harassment, sustained unwanted contact, boundary violation
- Behavior that causes a member to disengage or feel unsafe
- Abuse of the flagging system as a weapon against legitimate participants

### Category C — Network Integrity
- Circumventing physical attendance gates (ticket fraud, ID fraud)
- Coordinated manipulation of attestation accumulation
- Bad actor behavior by a vouched person that the voucher had reasonable cause to anticipate

## Detection Sources

No automated content moderation. Detection comes from three sources:

1. **Peer flagging** — by established DIDs, Cultural DID governance bodies, or EventDID operators. The flagger's trust weight is attached to the flag.
2. **Systemic anomaly detection** — unusual patterns in connection requests, attestation velocity, or check-in behavior that diverge from baseline.
3. **Vouch chain accountability** — if a vouched person exhibits bad behavior, the voucher is notified and their standing is reviewed.

All flags are initially **private** — visible only to the flagging party, the flagged party's direct trust graph, and governance. The flagged DID is not publicly identified.

> Imajin does not issue public verdicts. The trust graph renders judgment structurally. Exclusion comes through irrelevance, not public shaming.

## Consequence Tiers

### Level 1 — Yellow Flag
First incident or low-severity flag.
- DID is notified privately
- Standing adjusts marginally
- Cultural DID governance bodies are alerted with summary
- No access changes

### Level 2 — Amber Flag
Repeated or moderate-severity flags.
- Attestation accrual rate is throttled
- Applications to new Cultural DIDs surfaced with flag history visible to evaluators
- Direct messaging to non-connected DIDs suspended
- Established DID may be **demoted to preliminary** standing

### Level 3 — Red Flag
Sustained pattern or severe single incident.
- DID is demoted to preliminary (or soft) standing
- EventDID and Cultural DID operators notified
- Vouching DID takes a standing reduction
- Recovery path exists but requires formal review by a governance body

### Permanent Removal
Reserved for Category C violations or uncontested pattern of Category A + B.
- Cryptographic DID is blacklisted across the network
- Vouching DID takes significant standing penalty
- Threshold is intentionally high — over-punishment erodes trust as surely as under-punishment

## Vouch Chain Accountability

When you vouch for someone, you're not just saying "I know them." You're saying **"I'm sponsoring their onboarding, and my standing reflects how that goes."**

If your vouched person:
- Completes onboarding successfully → your standing gets a small positive attestation
- Gets flagged during onboarding → you're notified, your standing is reviewed
- Gets permanently removed → you take a significant standing hit

This makes vouching a **considered act** with real consequences. The social pressure is architectural, not performative.

## Implementation Notes

- **Flags are attestations** — typed, signed, attached to the flagged DID's identity record
- **Standing computation** incorporates flag history alongside positive attestations
- **Governance weight** for flag evaluation follows the Cultural DID model — weighted by contribution, corrected by inactivity
- **Privacy by default** — flags don't leak beyond the relevant governance scope
- **Appeals process** — flagged DID can request review by a higher-standing governance body

## Open Questions

1. Who has flagging rights? Only established DIDs? Or can preliminary DIDs flag too (with lower weight)?
2. How does cross-community flagging work? A flag in Cultural DID A — does it affect standing in Cultural DID B?
3. What's the decay rate on flags? Do yellow flags expire after N months of clean behavior?
4. How do we prevent coordinated flagging attacks (brigading)?
5. Should there be a "voucher score" — a visible track record of how your vouched people have performed?

## Credit

Bad actor model from Greg Mulholland's "Entering the Network" (March 2026). Vouch chain accountability refined in discussion with Ryan.
