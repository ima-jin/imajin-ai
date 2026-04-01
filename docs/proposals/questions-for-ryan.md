# Open Questions for Ryan

**Compiled:** March 29, 2026
**Source:** All open proposals (P05–P31), outstanding concerns (C02–F6), problems (P6–P9), and business plan placeholders.
**Author:** Greg Mulholland (Tonalith)

This document consolidates every unresolved decision across the proposal system that requires Ryan's input. Organized by urgency and category.

---

## Immediate — Before April 1

These decisions affect the demo and should be resolved before launch.

| # | Question | Source | Context |
|---|----------|--------|---------|
| 1 | Is April 1 demo scoped to the three remaining wiring tasks only, or has scope crept? | P28 | .fair → events, events → settlement, platform fee recording |
| 2 | Can `event.attended` attestation be added before April 1? | P29 | Highest-value trust signal from the demo |
| 3 | Can `supporter.founding` attestation type be added before April 1? | P28, P29 | Unblocks #474 (Founding Supporter tier) within a week of demo |
| 4 | Is April 1 event on dev or production infrastructure? | P28 | Determines if real money flows through settlement |
| 5 | Does `PLATFORM_DID` exist yet? What DID receives the protocol's 0.4% fee? | P28 | Required for `.fair` attribution chain in settlement |

## Week 1 Post-Demo

| # | Question | Source | Context |
|---|----------|--------|---------|
| 6 | Are founding supporter rates (20:1 / 25:1 / 30:1 MJN per dollar) decided, or do they need RFC-12 first? | P28, P31 | Determines when #474 can ship |
| 7 | Who closes ~30 stale issues — Ryan, or can Greg draft closure comments for review? | P28 | 119 open issues; ~30 are superseded. Target: reduce to <70 |
| 8 | Does `emitAttestation()` accept arbitrary types or is vocabulary enforced? | P29 | Determines if adding new attestation types requires code changes |
| 9 | Should standing computation go live before or after attestation coverage is complete? | P29 | Premature standing on sparse data may be worse than no standing |

## Pre-Seed Planning

| # | Question | Source | Context |
|---|----------|--------|---------|
| 10 | Pre-seed valuation cap for SAFE round? | Business plan §9 | Currently listed as TBD. Pre-pre-seed cap is CAD $5M. |
| 11 | Founding supporter tier: SAFT, contribution model, or other legal structure? | Business plan §9, P28 | Needs legal counsel opinion before launch. Budgeted in raise. |
| 12 | Advisory board — any candidates identified? | Business plan §8 | Currently "to be formed post-fundraise" |

## Fee Governance & Tokenomics

| # | Question | Source | Context |
|---|----------|--------|---------|
| 13 | Where is the fee rate enforced — kernel code (upgradeable) or Solana contract (immutable)? | P31 | Same question applies to fee decay thresholds |
| 14 | Fee governance voting mechanism — trust-graph-weighted, MJN-weighted, or one-DID-one-vote? | P31 | Each has different capture dynamics |
| 15 | When does governance authority transfer from founders to the trust graph? | P31, P14 | Path dependency risk if not specified early |
| 16 | In a federated network, how do nodes agree on the current fee rate? | P31 | Multi-node consistency problem |

## Foundation Governance

| # | Question | Source | Context |
|---|----------|--------|---------|
| 17 | Does Network of Souls influence translate into Foundation governance votes? | P14 | If yes: power problem needing counterbalance. If no: document it. |
| 18 | Is Foundation governance built on attestation history, Cultural DID delegates, or founding team authority? | P14 | Determines who governs protocol evolution |
| 19 | What is the transition path from founding team governance to the target mechanism? | P14 | Without a path, founding team governance becomes permanent |

## Technical Architecture

### Consent Primitive (P18, F6)

| # | Question | Source | Context |
|---|----------|--------|---------|
| 20 | Is consent per-exchange or per-relationship? | P18 | Per-exchange is granular but heavy; per-relationship is practical |
| 21 | Does consent live in `auth.attestations` or separate table? | P18 | Schema ownership question |
| 22 | Is Stream 2 opt-in (Declared-Intent Marketplace) a consent declaration? | P18 | If yes, needs signing infrastructure |
| 23 | Does RFC-268 (Embedded Wallet) need consent scope in delegated keys? | P18 | Agent key authority bounds |

### Attestation Schema (P22, P29)

| # | Question | Source | Context |
|---|----------|--------|---------|
| 24 | Add `client_hint JSONB` and `category TEXT` fields to `auth.attestations` now? | P22 | Cheap now, expensive later against live data. Enables archaeology view. |
| 25 | Is `legacy.seed` backfill acceptable for historical records, or clean start? | P29 | Determines whether 120+ existing DIDs have standing history |
| 26 | Type diversity multiplier in initial standing formula? | P29 | Complexity vs. accuracy tradeoff |
| 27 | Does bilateral attestation requirement (#163) block progressive trust (#321)? | P29 | Dependency ordering |

### Family DID (P25)

| # | Question | Source | Context |
|---|----------|--------|---------|
| 28 | New `auth.identities` type `'family'` or separate `auth.family_identities` table? | P25 | Family DIDs carry governance fields not on core identity |
| 29 | Dependent references — placeholder in family chain or soft DID issued by guardian? | P25 | Placeholder is simpler; soft DID is more consistent |
| 30 | Family DID keypair custody — guardian-held vs. threshold signature? | P25 | Single custody = single point of risk |
| 31 | Solo guardian family DID permitted? | P25 | Real use case: single parent forming family before other members |

### Org DID (P10)

| # | Question | Source | Context |
|---|----------|--------|---------|
| 32 | Minimum `org.claim.vouch` threshold for Org DID claims? | P10 | Greg proposes 3 Established DIDs minimum |
| 33 | Minimum soft-loading count for Org DID claims? | P10 | Greg proposes 15 distinct Person DIDs |
| 34 | Who writes the first covenant document? | P10 | Must exist before first Org DID claim is processed |

### Agent Architecture (P24)

| # | Question | Source | Context |
|---|----------|--------|---------|
| 35 | Can soft-tier DIDs do agent things? | P24 | Soft DIDs have no keypair — can't sign |
| 36 | What level of agent isolation is needed? | P24 | Sandbox? Process? Cryptographic scope bounds? |
| 37 | Can a person run multiple agent instances? Unique DID each or versioned? | P24 | Instance tracking model |

### Other Technical

| # | Question | Source | Context |
|---|----------|--------|---------|
| 38 | Default k-anonymity threshold for declarations — 5, 10, or higher? | P12 | Privacy framework calibration |
| 39 | Should BaggageDID be auto-issued on all departures or only voluntary/dissolution? | P05 | Affects privacy model |
| 40 | Should `docs/philosophy/` folder be created for P21 Section 3 content? | P21, P23 | Ryan confirmed interest; needs creation |

## Attestation Vocabulary Governance (P29)

| # | Question | Source | Context |
|---|----------|--------|---------|
| 41 | Hard-coded vocabulary, configuration-based, or open vocabulary with naming convention? | P29 | Greg recommends configuration-based for MVP |

---

## Resolution Tracking

As questions are answered, note the decision and date here:

| # | Decision | Date | By |
|---|----------|------|----|
| — | — | — | — |

---

*This document is maintained by Tonalith and updated when proposals are added or questions are resolved.*
