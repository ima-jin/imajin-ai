# RFC-42: MyTerms (IEEE 7012) as an Imajin Conformance Profile

**Status:** Current — Draft — alignment/research, build deferred
**Authors:** Ryan Veteze, Jin
**Created:** August 4, 2026
**Related:** RFC-41 (The Composable Gate), RFC-32 (Agent Protocol Interop), RFC-35 (Context-Bound Connection)

---

## Summary

**MyTerms (IEEE 7012-2025)** — the machine-readable personal-privacy-terms standard published by the IEEE in January 2026, from Doc Searls' ProjectVRM / Customer Commons lineage — is a **specific, standards-blessed instantiation of Imajin's consent / composable-gate / proof-of-history primitives in the privacy domain.**

This RFC proposes treating MyTerms as a **conformance profile** of the Imajin trust substrate: *Imajin's composable-gate + proof-of-history + delegation primitives can express a valid MyTerms interaction end-to-end.* We do not adopt MyTerms as our trust layer — we **pass** it, the way a reference implementation passes a suite. It maps to both the **trust layer** (subject-authored gate → dual signed record) and the **application layer** (consent envelope on the intention-inference engine).

## Falsifiable claim

> A person proffers a roster-selected MyTerms agreement (a subject-authored composable gate, RFC-41); the second party accepts (the gate's boolean); both parties retain the same signed record (proof-of-history); and — as an Imajin extension beside the standard — settlement/attribution (.fair) may attach on the same rail.
>
> **If this cannot be expressed with the existing composable-gate + attestation + delegation primitives without modifying them, the claim is false** and MyTerms is *not* a clean profile of our substrate.

## Layer crosswalk

### Trust layer

| MyTerms construct | Imajin primitive |
|---|---|
| Dual identical signed record (audit + dispute) | Proof-of-history (the signed record IS the authority) |
| Person = first party; site = second party | Identity + delegation (`onBehalfOf`; record knows who acted) |
| The agreement (machine-readable term offered before engagement) | Composable gate authored by the subject (RFC-41) |
| Neutral nonprofit roster (Customer Commons) | The gate library (neutral steward holds the vocabulary) |

### Application layer

| MyTerms / VRM idea | Imajin primitive |
|---|---|
| Agreement governs what may be inferred/used | App = intention-inference engine; MyTerms = the consent envelope (inference-with-consent, not surveillance) |
| Customer-side agent shares the customer's own account under a trust protocol | Coordinating agent composing signed functions `onBehalfOf` the human |
| Depth/breadth of disclosure is the person's dial | Consent knob as the human's pricing surface (match, not data) |
| Customer Data Return (CDR) | Settlement + Attribution (.fair) — the half MyTerms names but does not build |

## What each side supplies

**MyTerms → Imajin:** a legal-contract basis (GDPR Art. 6(b) contract, not the gamed 6(a)/6(f)); a regulatory tailwind (EU Digital Omnibus Art. 88b explicitly wants machine-readable individual choices "once standards are available"); a credibility anchor (IEEE / Searls / Customer Commons); a ready-made privacy-term vocabulary for our gates.

**Imajin → MyTerms:** the settlement + attribution rail MyTerms lacks; a running reference implementation (the live kernel already does signed events, attestations, DID-scoped identity, per-subject access gates — e.g. `mcp.imajin.ai`, OAuth2+PKCE, audience-bound signed access); breadth beyond privacy (composable gate runs across four tenants — life/market/journey/supply-chain — so MyTerms is *one profile* of a general primitive).

## Scope / non-goals

- **In scope:** verifying the falsifiable claim on paper, then a minimal spike expressing one MyTerms agreement as a composable gate producing a dual signed record.
- **Out of scope (this RFC):** claiming IEEE 7012 *compliance* (Art. 88b is a proposal, not enacted — describe alignment, don't claim compliance); building the full privacy-terms product; modifying the composable-gate primitive.
- **Explicit caveat:** MyTerms is narrow (person↔site, privacy, bilateral). It is **not** our trust layer. Overclaiming "we are MyTerms" is the same error as "we are VRM" — the map is not the plumbing.

## Open questions

1. Does the IEEE 7012 agreement serialization map onto our signed-attestation envelope, or need an adapter? (cf. RFC-32 / AP2 / KYA interop.)
2. Can Customer Commons' roster be consumed as a gate-vocabulary source, or do we mirror + sign it?
3. MyTerms requires *both* parties keep an identical record — our proof-of-history is subject-anchored; what's the second-party retention / counter-signature story?
4. Is settlement attachment within MyTerms' intent or a beside-extension? (Leaning: beside — MyTerms is payment-silent, so additive.)
5. Public posture on "implements IEEE 7012" given Art. 88b is not yet enacted.

## References

- IEEE 7012-2025 — Standard for Machine-Readable Personal Privacy Terms ("MyTerms"), IEEE, Jan 2026.
- ProjectVRM (Doc Searls); Customer Commons; the *Intention Economy*.
- EU Digital Omnibus proposal — GDPR Article 88b.
- Working paper: `standards/myterms/working-paper-01-myterms-imajin-crosswalk.md` (workspace).
- Prior note: `biz-dev/bts/newsletter-003b-vrm.md`.
