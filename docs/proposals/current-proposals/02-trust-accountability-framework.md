## 2. Trust Accountability Framework — Bad Actor Model

**Author:** Greg Mulholland (concept), vouch chain accountability refined with Ryan Veteze
**Date:** March 2026
**Related upstream:** #271 (Progressive Trust Model), #247 (Cultural DID), #248 (Org DID), #273 (Trust Accountability Framework)
**Addresses:** Outstanding Concerns: Governance Equity (by establishing consequence model)

### Context

The existing system has connections and trust graph queries but no formalized consequence model for bad behavior. Current recourse: manual intervention (doesn't scale), removing connections (informal), or nothing. No flagging system, no consequence tiers, no vouch chain accountability, no rehabilitation path.

### Behavioral Categories

The model is **behavioral, not ideological** — defining patterns that undermine trust, accountability, and non-extraction.

**Category A — Extraction and Exploitation**
- Commercial solicitation in non-commercial community spaces
- Using trust graph access to harvest contact or behavioral data
- Manufacturing fake vouches or coordinated identity deception
- Sockpuppet or Sybil behavior to manipulate governance weight

**Category B — Relational Harm**
- Harassment, sustained unwanted contact, boundary violation
- Behavior that causes a member to disengage or feel unsafe
- Abuse of the flagging system as a weapon against legitimate participants

**Category C — Network Integrity**
- Circumventing physical attendance gates (ticket fraud, ID fraud)
- Coordinated manipulation of attestation accumulation
- Bad actor behavior by a vouched person that the voucher had reasonable cause to anticipate

### Detection Sources

No automated content moderation. Detection from three sources:
1. **Peer flagging** — by Established DIDs, Cultural DID governance bodies, or EventDID operators. The flagger's trust weight is attached to the flag.
2. **Systemic anomaly detection** — unusual patterns in connection requests, attestation velocity, or check-in behavior that diverge from baseline.
3. **Vouch chain accountability** — if a vouched person exhibits bad behavior, the voucher is notified and their standing is reviewed.

All flags are initially private — visible only to the flagging party, the flagged party's direct trust graph, and governance. The flagged DID is not publicly identified. Imajin does not issue public verdicts. The trust graph renders judgment structurally. Exclusion comes through irrelevance, not public shaming.

### Consequence Tiers

**Level 1 — Yellow Flag** (first incident or low-severity)
- DID notified privately
- Standing adjusts marginally
- Cultural DID governance bodies alerted with summary
- No access changes

**Level 2 — Amber Flag** (repeated or moderate-severity)
- Attestation accrual rate throttled
- Applications to new Cultural DIDs surfaced with flag history visible to evaluators
- Direct messaging to non-connected DIDs suspended
- Established DID may be demoted to Preliminary standing

**Level 3 — Red Flag** (sustained pattern or severe single incident)
- DID demoted to Preliminary (or Soft) standing
- EventDID and Cultural DID operators notified
- Vouching DID takes a standing reduction
- Recovery path exists but requires formal review by a governance body

**Permanent Removal** (Category C violations or uncontested pattern of Category A + B)
- Cryptographic DID blacklisted across the network
- Vouching DID takes significant standing penalty
- Threshold intentionally high — over-punishment erodes trust as surely as under-punishment

### Vouch Chain Accountability

When you vouch for someone, you're saying "I'm sponsoring their onboarding, and my standing reflects how that goes."

- Vouched person completes onboarding → your standing gets a small positive attestation
- Vouched person flagged during onboarding → you're notified, your standing is reviewed
- Vouched person permanently removed → you take a significant standing hit

This makes vouching a considered act with real consequences. The social pressure is architectural, not performative.

### Implementation Notes

- Flags are attestations — typed, signed, attached to the flagged DID's identity record
- Standing computation incorporates flag history alongside positive attestations
- Governance weight for flag evaluation follows the Cultural DID model — weighted by contribution, corrected by inactivity
- Privacy by default — flags don't leak beyond relevant governance scope
- Appeals process — flagged DID can request review by a higher-standing governance body

### Open Questions

- Who has flagging rights? Only Established DIDs? Or can Preliminary DIDs flag too (with lower weight)?
- How does cross-community flagging work? Does a flag in Cultural DID A affect standing in Cultural DID B?
- What's the decay rate on flags? Do Yellow flags expire after N months of clean behavior?
- How do we prevent coordinated flagging attacks (brigading)?
- Should there be a "voucher score" — a visible track record of how your vouched people have performed?

---

