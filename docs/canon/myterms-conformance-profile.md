# RFC-42: MyTerms (IEEE 7012) as an Imajin conformance profile — verify falsifiable claim + spike

> **Canon** · source: [ima-jin/imajin-ai#1611](https://github.com/ima-jin/imajin-ai/issues/1611) · filed 2026-08-05 by @imajin-jin · carried into docs 2026-10-26
>
> Ruled 2026-10-26 (pre-cut issue audit v0.8.28, card 11, option c): canon lives in `docs/canon/` now, and the corpus reads it from here later. The issue stays open until this lands.
>
> By **Veteze-Jin**: Ryan's thesis, translated by Jin (an AI) and signed as a translation. Anything quoted from Ryan is verbatim.

RFC: [docs/rfcs/RFC-42-myterms-conformance-profile.md](../rfcs/RFC-42-myterms-conformance-profile.md).

## Thesis

Falsifiable claim: MyTerms (IEEE 7012-2025) can be expressed as a conformance profile of Imajin's existing trust primitives (composable gates, proof-of-history, delegation) across the trust and application layers, without new primitives.

## Source (verbatim from [#1611](https://github.com/ima-jin/imajin-ai/issues/1611))

RFC-42 proposes treating **MyTerms (IEEE 7012-2025)** as a **conformance profile** of the Imajin trust substrate — mapping it onto the composable-gate (RFC-41) / proof-of-history / delegation primitives across both the trust and application layers.

**Falsifiable claim:** the existing primitives can express a valid MyTerms interaction end-to-end (person proffers roster-selected agreement = subject-authored gate → second party accepts = boolean → both retain the same signed record = proof-of-history, with .fair/settlement optionally attached) **without modifying the primitives.** If they can't, MyTerms is not a clean profile of our substrate.

**Why it matters:** MyTerms gives us a legal-contract basis (GDPR Art. 6(b)), an EU regulatory tailwind (Digital Omnibus Art. 88b wants machine-readable individual choices "once standards are available"), and an IEEE/Searls/Customer-Commons credibility anchor — for the exact inversion we already build. We give MyTerms the settlement+attribution half it names but never built, plus a running reference implementation.

**Caveat:** MyTerms is narrow (person↔site, privacy, bilateral). It is NOT our trust layer; overclaiming "we are MyTerms" is the "we are VRM" error. The claim is the narrow conformance-profile one.

**Next step:** verify the falsifiable claim on paper, then a minimal spike expressing one MyTerms agreement as a composable gate producing a dual signed record.

- RFC doc: `docs/rfcs/RFC-42-myterms-conformance-profile.md` (PR [#1610](https://github.com/ima-jin/imajin-ai/issues/1610))
- Working paper (workspace): `standards/myterms/working-paper-01-myterms-imajin-crosswalk.md`
- Refs: RFC-41 (composable gate), RFC-32 (protocol interop), prior `biz-dev/bts/newsletter-003b-vrm.md`

## Rulings and notes from the thread

**@imajin-jin · 2026-09-23**

> **DECISION** · [#1611](https://github.com/ima-jin/imajin-ai/issues/1611) · from decision run [#2277](https://github.com/ima-jin/imajin-ai/issues/2277) (2026-09-22) · verdict: **b — keep open**. RFC-42 MyTerms (IEEE 7012) remains a valid standards-alignment track. Ruled by Ryan; written back by Jin (decision-run).
