# RFC-37: Corroboration Escrow — Disclosure That Nobody Has to Make Alone

**Status:** Draft
**Author:** Ryan Veteze, Jin
**Date:** 2026-07-11
**Related:** RFC-34 (Community Needs Brokerage), RFC-35 (Context-Bound Connection), RFC-13 (Progressive Trust Model), RFC-17 (Governance Primitive), RFC-15 (Trust & Accountability Framework), RFC-18 (Media Revocation & Attribution), RFC-10 (Sovereign User Data)
**Issues:** #1097 (broker-mediated social coordination), #1103 (broker config-driven), #1241 (reciprocal disclosure), artifactagent#18 (match-without-disclosure)

---

## Summary

A person holding a true, costly thing to say — an account of harm, misconduct, or abuse — faces two channels, both bad. **Broadcast it** and it becomes lossy, deniable, misquotable, and the teller often ends up on trial for the telling. **Swallow it** and the truth dies and the pattern continues. The whisper network (the "missing stair," the informal warning list) is the grassroots third option, and it works — but it is unattributable, legally radioactive for its carriers, and offers no protection against a single false whisper.

This RFC defines **corroboration escrow**: a sealed, attested account that stays private and surfaces *only* when an independent account names the same subject. The design removes the thing that makes coming forward unbearable — **being the first, and being alone** — because by the time anything is visible, a match already exists. It is the RFC-34 / #1097 broker invariant ("nothing leaves the broker unless a match already exists") applied to the highest-stakes disclosure a person can make.

**This system surfaces corroboration. It does not adjudicate truth.** That boundary is load-bearing and is stated first because getting it wrong hurts the people it is meant to protect.

## Problem

The core failure the #MeToo era exposed is an **information-asymmetry failure**, not a courage failure. A serial offender's power is that each person harmed is *isolated* — none of them can see that the pattern is a pattern, and each must decide whether to be the lone voice against a denial. The isolation is manufactured and it is the whole mechanism.

The existing responses each fail on a different axis:

1. **Public disclosure (broadcast).** Puts the entire burden and risk on the person going first: retaliation, defamation exposure, "why now / why you," and distortion as the account is re-told. The truth survives, but often at a cost the teller cannot pay.
2. **Silence.** Zero risk to the individual in the moment, but the pattern is invisible and continues. Every subsequent person also thinks they are the first.
3. **Whisper networks.** Better than silence and closest to the right shape — but unattributable, deniable, legally dangerous for the people maintaining the list (see: the "Shitty Media Men" list and the litigation against its creator), and offering no defense against a single malicious entry, because there is no corroboration gate.
4. **Vendor escrow (e.g. Callisto's matching model for campus assault).** Proves the *mechanism works and survivors will use it* — matching escrow has surfaced serial offenders. But it lives on a company's server: subpoenable, breachable, and mortal. When the vendor dies, the sealed accounts and the protection die with it.

The shape that works is **conditional disclosure gated on independent corroboration**, held on infrastructure the discloser owns rather than a vendor's database. Imajin already has the primitives.

## Design

### The invariant: nobody goes first

An account is sealed and attested but **not published**. It becomes visible to a downstream human process *only* when a second, independently sealed account names the same subject. The match fires on the arrival of the second account — exactly the broker latch of RFC-34 / #1097 (`consent → scope → release → audit`, state not event).

```
Discloser A ──seals account, names subject S──▶ escrow   (sealed, private, attested)
Discloser B ──seals account, names subject S──▶ escrow   (sealed, private, attested)
                                                  │
                          match on subject S ─────┘  ← surfacing event fires here, not before
```

- **You are never the first alone.** By the time anything surfaces, you are already the second (or ninth). The unbearable position — sole accuser against a denial — is dissolved by construction.
- **No match, nothing leaves.** A single sealed account sits inert and private indefinitely. The escrow reveals *the existence of corroboration*, never a lone account.
- **Symmetric and revocable.** This is the #1241 property set (atomic mutual reveal, nobody-goes-first, revocable) pointed at disclosure of harm. A discloser can revoke a sealed account before any match; revocation is itself on the record (RFC-18).

### The primitive: match-without-disclosure

The subject-matching predicate answers *only* "do two or more independent sealed accounts name the same subject?" — a signed yes/no. The accounts themselves do not leave their sealed state on the basis of the match alone; the match authorizes a **downstream human process**, it does not publish anything (artifactagent#18: the box answers a predicate locally, only a signed yes/no leaves).

Subject resolution is the hard, dangerous part and is treated as such: matching is over a **resolved subject identity** (a DID where one exists, or a carefully normalized descriptor where one does not), and the false-match threat model (below) governs how loose that resolution is allowed to be.

### The record: provenance, not verdict (load-bearing)

The escrow produces attestations of exactly two facts, and **no others**:

1. `"did:imajin:A signed this account at time T"` — provenance of the disclosure.
2. `"two or more independent accounts named subject S"` — existence of corroboration.

It does **not** produce, imply, or render `"S is guilty."` This mirrors the standing epistemics rule (RFC-15; the AgriFortress rule): **a signature proves the assertion was made and signed, not that the asserted thing is true.** A cryptographic accusation that *looks* like proof is more dangerous than a whisper, because it launders assertion into apparent fact. The UI, the data model, and every downstream consumer must treat a match as *"here is corroboration worth a human, consensual, due-process step,"* never *"here is a verified offender."*

### Surfacing is human and consensual, never automatic

A match does **not** trigger publication, notification of the subject, or any automated consequence. It unlocks an **option** for the disclosers:

- Each matched discloser is privately informed that corroboration exists.
- What happens next is *their* choice, individually and revocably: connect with the other discloser(s), bring in an advocate or counsel, initiate a formal process, or do nothing. The escrow's job ends at "corroboration exists — here are your options."
- No path in the system goes match → auto-publish. Ever.

### Threat model (stated up front, because the subject is a person too)

1. **False or weaponized accounts.** Coordinated bad-faith "matches," ex-partners, harassment campaigns. Mitigations: corroboration requires *independent* disclosers (anti-Sybil binding to real attested identity, RFC-13/RFC-29 escalation for weightier claims), matches route to human review not publication, and the subject retains recourse. The system must never be marketable as "the truth machine."
2. **Subject resolution errors.** Loose descriptor matching produces false links; strict matching misses real ones. This is a governance dial (RFC-17), not a default — erring toward strict, with human disambiguation.
3. **Escrow custody.** Sealed accounts are the most sensitive data the platform could hold. Sovereign custody (RFC-10) is the point — not a vendor honeypot — but the honest v1 custody boundary (node-sealed vs zero-custody; the Law of Custody) must be disclosed plainly to disclosers *before* they seal anything. A discloser must know exactly who could technically access what, and be able to revoke.
4. **Coercion / duress.** A discloser may be pressured to seal or to reveal. Revocability and the absence of any automatic consequence are the structural protections; the human-process gate is where duress is meant to be caught.
5. **Legal exposure & duty of care.** Jurisdiction, mandatory-reporting law, and the duty owed to a discloser who later needs to unseal, revoke, or is themselves in danger. **This is not an engineering problem and must not be shipped as one.**

## Non-goals

- **Not a verdict engine.** It surfaces corroboration; courts, investigators, and consensual processes adjudicate.
- **Not a publication tool.** There is no broadcast path.
- **Not a general reputation system.** Scope is disclosure of harm under corroboration gating, not scoring people.

## Relationship to prior RFCs

This RFC is the emotional and ethical extreme of machinery already specified elsewhere: the **broker latch** (RFC-34, #1097), **context-bound / consent-gated reveal** (RFC-35), **progressive & escalating trust** (RFC-13, RFC-29), **provenance-not-truth attestation** (RFC-15), and **revocable records** (RFC-18). It is the honest-record thesis — *end the information asymmetry between an isolated individual and a party that profits from that isolation, with an attributable record instead of a deniable whisper* — pointed at the person sitting alone with a true thing they cannot safely say.

## Open questions

1. **Advocates and lawyers before engineers.** No build ticket should precede review by people in the survivor-advocacy and legal space. What is the right partner org to pressure-test this?
2. **Subject resolution without a DID.** Most subjects will not be on Imajin. How loose is descriptor matching allowed to be before false-match risk dominates? (Governance dial, RFC-17.)
3. **Anti-Sybil for "independent."** What binds a sealed account to a distinct real person strongly enough that "two independent accounts" means what it says, without turning the escrow into an identity honeypot?
4. **Custody disclosure UX.** How is the Law-of-Custody reality communicated to a discloser, at seal time, in a way a frightened person actually understands?
5. **Duress and unseal.** What is the safe protocol for a discloser who needs to withdraw or is endangered by the existence of their own sealed account?

---

*Status note: Draft, and deliberately kept at concept/spec level. Given the stakes, RFC-37 should not become a build ticket until it has been read by survivor-advocacy and legal reviewers. The technology is the easy 20%.*
