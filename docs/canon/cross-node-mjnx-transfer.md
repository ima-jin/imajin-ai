# design(wallet): Cross-node MJNx transfer — attestation-based seat, no build

> **Canon** · source: [ima-jin/imajin-ai#2006](https://github.com/ima-jin/imajin-ai/issues/2006) · filed 2026-09-04 by @imajin-jin · carried into docs 2026-10-26
>
> Ruled 2026-10-26 (pre-cut issue audit v0.8.28, card 11, option c): canon lives in `docs/canon/` now, and the corpus reads it from here later. The issue stays open until this lands.
>
> By **Veteze-Jin**: Ryan's thesis, translated by Jin (an AI) and signed as a translation. Anything quoted from Ryan is verbatim.

## Thesis

Cross-node MJNx transfer has exactly one valid trust model, and it's attestation-based. A receiving node accepts value only against a signed, anchored reserve attestation (match-without-disclosure applied to solvency). A whitelist is rejected. The seat is reserved, there's no build, and it's parked until a second node exists.

## Source (verbatim from [#2006](https://github.com/ima-jin/imajin-ai/issues/2006))

### Scope
Reserve the seat for a cross-node MJNx transfer protocol. Under the 2026-09-04 ruling: the ONLY valid trust model is attestation-based (receiving node accepts only against a signed, anchored reserve attestation — match-without-disclosure applied to solvency). A whitelist is rejected as re-centralizing.

There are no other nodes today. Cross-node "transfer" today = the fiat rail twice (withdraw from Node A, deposit to Node B). This issue is a design doc + attestation shape only — explicitly "do not implement."

### Acceptance
- Design doc covers: attestation-based solvency proof, transfer message shape, reconciliation for failed/in-flight transfers, and the "no other nodes exist; do not implement" constraint.
- Doc references match-without-disclosure and the composable gate primitive.

### Dependencies
- ima-jin/imajin-ai#904 (existing settlement infra)
- ima-jin/imajin-ai#3 (spot-rate oracle, if rates differ across nodes)

### Tags
**[KERNEL]**

---
Sub-issue of ima-jin/imajin-ai#738 (Open Wallet re-imagining, 2026-09-04).
Blocked by: ima-jin/imajin-ai#3 (recommended first).

## Rulings and notes from the thread

**@imajin-jin · 2026-09-24**

> **Ruled (Ryan, 2026-09-23 via decision card): option b** — parked until a second node exists ([#1538](https://github.com/ima-jin/imajin-ai/issues/1538)). Design seat stays canon; no build. — Jin
