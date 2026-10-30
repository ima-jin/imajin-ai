# design: protocol-fee distribution model (dev / community / protocol residual + governance)

> **Canon** · source: [ima-jin/imajin-ai#1306](https://github.com/ima-jin/imajin-ai/issues/1306) · filed 2026-07-14 by @imajin-jin · carried into docs 2026-10-26
>
> Ruled 2026-10-26 (pre-cut issue audit v0.8.28, card 11, option c): canon lives in `docs/canon/` now, and the corpus reads it from here later. The issue stays open until this lands.
>
> By **Veteze-Jin**: Ryan's thesis, translated by Jin (an AI) and signed as a translation. Anything quoted from Ryan is verbatim.

## Thesis

Two layers that got conflated have to stay separate: the per-transaction fee cascade, decided by each asset's atomic .fair file, and protocol-fee distribution across dev, community and protocol reserve. The distribution model is thesis-weight, and Ryan owns it.

## Source (verbatim from [#1306](https://github.com/ima-jin/imajin-ai/issues/1306))

Design decision spun out of PR [#1303](https://github.com/ima-jin/imajin-ai/issues/1303) ([#967](https://github.com/ima-jin/imajin-ai/issues/967), `/.well-known/fair-policy.json`). **Thesis-weight — Ryan owns this.** Not a build ticket yet.

### The distinction that spawned this

Two separate layers were conflated in the fair-policy endpoint:

- **Fee cascade** — *per-transaction*, decided by the atomic `.fair` file on each asset (1% MJN + 0.5% node + 0.25% buyer + 0.25% scope). "Who gets paid when the asset sells." Already real. This shipped in [#1303](https://github.com/ima-jin/imajin-ai/issues/1303).
- **Protocol-fee distribution** *(this ticket)* — what happens to the **1% MJN protocol fee after it is collected.** Treasury/governance, downstream of settlement, decided by the protocol — **not** part of any per-transaction manifest.

Everything above the protocol fee is the `.fair` file's job. This ticket is *only* about distributing the protocol's own 1% cut.

### Starting proposal (Ryan's leaning — NOT decided)

- **10% dev**
- **10% community**
- **remainder → protocol** (protocol is the residual, not community)
- **future splits possible** — version the distribution by **effective date**, do not freeze a single split forever

This is deliberately different from what PR [#1303](https://github.com/ima-jin/imajin-ai/issues/1303) encoded (10 foundation / 10 dev / 80 community). Community as the big residual was wrong; protocol-as-residual with small dev+community slices is the current posture.

### Open questions to resolve before any of this becomes machine-readable

1. **Foundation vs. protocol — same recipient or two?** Is the 1% a single pot that splits into foundation/dev/community, or does the 1% go to the protocol and foundation is a separate governance body taking a cut *of* the protocol take? "Remainder to protocol" implies protocol ≠ a fixed foundation slice — needs to be made explicit.
2. **Real recipient DIDs.** Dev pool and community pool need actual, resolvable DIDs before any distribution is published anywhere. Placeholders (`DEV_POOL`/`COMMUNITY_POOL`) are not acceptable on a public endpoint.
3. **Governance over changes.** Who can change the split, and how is a change recorded/attested? (Effective-date versioning implies a signed governance event, not a code constant.)
4. **Where it surfaces.** When decided, this fills a dedicated `treasury`/`governance` surface — NOT the pre-transaction `fair-policy.json`. Decide the shape then.

### Not blocked on

Nothing. [#1303](https://github.com/ima-jin/imajin-ai/issues/1303) ships the fee cascade without this. This is the source of truth that a future governance/treasury surface consumes once the model + real DIDs exist.

Ref: PR [#1303](https://github.com/ima-jin/imajin-ai/issues/1303), [#967](https://github.com/ima-jin/imajin-ai/issues/967), epic [#965](https://github.com/ima-jin/imajin-ai/issues/965)

### Folded in

**From [#433](https://github.com/ima-jin/imajin-ai/issues/433) — epic(pay): MJN virtual credits:**
- MJN virtual credits (already folded into [#738](https://github.com/ima-jin/imajin-ai/issues/738) as wallet gas-economy infrastructure) is the economic layer that the protocol-fee distribution model governs. The two-bucket balance, DFOS chain-native ledger, and emission calculations are the settlement primitives that produce the 1% protocol fee. This is the settlement prerequisite for the fee distribution design.

## Rulings and notes from the thread

**@imajin-jin · 2026-09-23**

> **DECISION** · [#1306](https://github.com/ima-jin/imajin-ai/issues/1306) · from decision run [#2277](https://github.com/ima-jin/imajin-ai/issues/2277) (2026-09-22) · verdict: **d — defer**. Fee-governance split is an unsettled tokenomics call; not closed by the .fair cascade. Stays open, no work scheduled. Ruled by Ryan; written back by Jin (decision-run).
