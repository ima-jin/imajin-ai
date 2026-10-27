# Scoped signaling — signed, revocable disclosure to a chosen trust radius (payload: asset | state | need; disclosure_mode: discoverable vs readable)

> **Canon** · source: [ima-jin/imajin-ai#1224](https://github.com/ima-jin/imajin-ai/issues/1224) · filed 2026-07-02 by @imajin-jin · carried into docs 2026-10-26
>
> Ruled 2026-10-26 (pre-cut issue audit v0.8.28, card 11, option c): canon lives in `docs/canon/` now, and the corpus reads it from here later. The issue stays open until this lands.
>
> By **Veteze-Jin**: Ryan's thesis, translated by Jin (an AI) and signed as a translation. Anything quoted from Ryan is verbatim.

## Thesis

Scoped signaling: a sovereign human authors a scoped, revocable, signed disclosure to a chosen trust radius. The payload can be an asset, a state or a need. It started as a real consent failure turned inside out, and it's a primitive because it doesn't care which payload it carries.

## Source (verbatim from [#1224](https://github.com/ima-jin/imajin-ai/issues/1224))

### What this is

A generalization that emerged from a real anti-example (Jul 1). A woman found — by accidental screenshot — that her own face had been turned into ad creative and pointed at her boyfriend. No consent going in, no signed record coming out, no recourse. That failure, inverted, is a single primitive that turns out to serve cases far beyond advertising.

**Scoped signaling: a sovereign human authoring a scoped, revocable, signed disclosure to a chosen trust radius.** The payload can be an *asset*, a *state*, or a *need*. One is priced, one is free; one summons a buyer, one summons a friend. The primitive doesn't care — that's why it's a primitive.

`#1195` (media:share + connections:read for one-click Claude sharing) is the **first narrow instance** of this. Artifact `artifactagent#16` (identity as a signed eligibility input) is the **market-altitude consumer** of it. This issue is the primitive both compose from. Inward-first is the correct order: the consumers compose from the primitive.

### The grant shape

Every scoped signal is one signed grant carrying:

- **subject / payload** — what is disclosed. An asset (likeness, a deck), an attribute, or a *state* ("I need financial support", "I need someone to talk to").
- **scope** — what the recipient may do (read / use-as-creative / respond).
- **audience radius** — a *trust-graph* bound expressed in hops, not a checkbox:
  - `0` — just you
  - `1–2` — close network / friends
  - `3–4` — extended community (Mooi-scale)
  - `open` — full market
- **terms** — optional. Price floor, per-impression rate, or revenue split → the human becomes a `.fair` share recipient. Or **no terms** — some disclosures are asks/gifts, not sales.
- **disclosure_mode** — the mechanic that decides *how* it reaches the radius (see below). This is the load-bearing field.
- **revocable** — always. Revocation is itself a recorded fact.
- **signed** — authored by the subject's key. This is what makes the whole thing real rather than a UI convention Meta could also draw.

### disclosure_mode — the seam (Ryan's question: "does it broadcast, or flow into the adnetwork?")

Neither, by default. Two failure modes to avoid, and the radius selects which mechanic is legitimate:

- **`discoverable` (pull-to-find, pooled)** — the grant *flows into* a queryable store to be found by a market. Correct for the **market** radius: the whole purpose is to be findable. This is what Artifact's eligibility store (`artifactagent#16`, #5) consumes.
- **`readable` (pull-to-see, at-source)** — the grant is a **signed state on the subject's own log**, scoped to a radius. It does **not** push and does **not** pool. Recipients inside the radius resolve it *at read time* — it's a live property of the connection, not a copy sitting in their inbox. Revoke → gone at next read; no escaped copy. Correct for the **intimacy** radius. The moment "I need help" becomes a queryable record, you've rebuilt the surveillance graph you're trying to destroy — so `readable` subjects must **never** be pooled.

**The audience radius selects the mode.** Market radius → `discoverable` (flow). Intimacy radius → `readable` (read-at-source). Same primitive, opposite disclosure mechanic.

#### The doorbell (optional push, separately consented)
`readable` is ambient by default (recipients see it when they look). For urgency ("I'm in crisis, I want my six people to *know now*"), a **second, layered grant** attaches a push: a `bus` event with a reactor that fans a **pointer** ("Ryan shared something with you") to the radius — *not the payload*. Recipients resolve the actual state by reading it back through the trust graph. The alert is a doorbell; the disclosure stays behind the door the subject still holds. Revoke and the door closes even though the doorbell rang.

Two independent axes the human holds:
- **visibility radius** — who *can* read it
- **push** — whether they're actively nudged, or it's ambient

Meta collapses both into "we decide, always on, you never knew." We separate them into two knobs the subject controls.

### The signature is the keystone

A screenshot is meaningless because it has no signature — it can't say whether she consented, who used the asset, when, or under what terms. It's testimony without a witness. The signature does two jobs:

- **Going in (consent):** the grant is signed *by the subject* → "she opted in to 4 hops at this price" is a fact, not a claim. No one can forge her consent because no one holds her key.
- **Coming out (record):** every *use* is a signed attestation → evidence that verifies itself, not a screenshot that can be denied.

Without this, everything above is just a nicely-designed UI. With it, disclosure becomes provable in both directions.

### The inversion

- **Ad case (priced, market radius, `discoverable`):** the thing Meta does *to* her for free becomes something she does *for herself*, for money, revocable, with a signed receipt per use. Answers "why would a human switch" — **they get paid for the thing that's currently stolen.**
- **Support case (free, intimacy radius, `readable` + optional doorbell):** identity shared deliberately to *summon care*. The graph Meta uses to sell you is the graph you'd use to say "I'm not okay, and only these six people should know" — with receipts that run the *right* direction (if you reached out and no one answered, that's visible to *you*).

### The three grant shapes (worked examples)

1. **likeness-for-money** — subject: likeness · scope: usable-as-creative · radius: ≤4 hops OR open · terms: floor N/impression · mode: `discoverable` → Artifact eligibility input (`artifactagent#16`).
2. **likeness-to-network** — subject: likeness · scope: usable-as-creative · radius: 1–2 hops · terms: optional · mode: `discoverable` within the trust radius → "my friend's café can put my face on their event promo, and I get a cut."
3. **state-for-support** — subject: state/need · scope: visible-as-signal + respond · radius: 1 hop · terms: none · mode: `readable` + optional doorbell → Imajin-inward, must never pool.

### Where it lives

- **Imajin-inward (this issue / the primitive):** the grant model + `disclosure_mode` + audience-radius (hop bound) + revocation + the authoring/control surface + the bus-doorbell reactor. Closest to the Unit — presence, being seen on your terms.
- **[#1195](https://github.com/ima-jin/imajin-ai/issues/1195)** — the first shipping slice: `media:share` to a resolved DID from Claude. A degenerate case (radius = one explicit DID, mode = share). Generalizing [#1195](https://github.com/ima-jin/imajin-ai/issues/1195)'s grant to carry radius + terms + mode is the bridge to this epic.
- **Artifact `artifactagent#16`** — the market consumer: reads the signed `discoverable` grant as an eligibility input, pays the subject via `.fair`. Consumes, never authors.

### Rough scope (no active clock yet — parked)

- [ ] Grant model extension: `{subject, scope, audience_bound (hops), terms?, disclosure_mode, revocable, signed}` — generalizing the [#1195](https://github.com/ima-jin/imajin-ai/issues/1195) grant.
- [ ] `disclosure_mode` enforcement: `discoverable` may pool; `readable` is at-source only and the pooling paths must refuse it.
- [ ] Trust-graph hop-distance query for `audience_bound` (reuse connections graph).
- [ ] Revocation as a recorded fact; `readable` grants gone at next read.
- [ ] Optional doorbell: bus event + reactor fanning a pointer (not payload) to the radius.
- [ ] `.fair`-on-identity link: a priced grant makes the subject a share recipient (Artifact #4/#5 consume this).
- [ ] Control surface: author / price / set-radius / revoke.

### Refs
- Narrow instance: [#1195](https://github.com/ima-jin/imajin-ai/issues/1195) (media:share + connections:read)
- Market consumer: a-r-t-i-f-a-c-t/artifactagent#16 (identity as signed eligibility input)
- Consent model: read/write × only-you/others 2×2; anything that discloses one party to another = `on-consent`, never silent ([#1196](https://github.com/ima-jin/imajin-ai/issues/1196))
- Bus/reactor substrate: the doorbell is a bus event + reactor chain
- Anti-example + full derivation: memory/2026-07-01 session

### The one line
Meta monetizes the disclosure you never made. Imajin lets you make the disclosure you *want*, to exactly who you want, and take it back — sometimes that's worth money, sometimes it's worth everything. And because every disclosure carries its own signature, a screenshot of the alternative proves nothing.


### Folded in

**From [#1097](https://github.com/ima-jin/imajin-ai/issues/1097) — Epic: Broker-mediated social coordination:**
- Broker-mediated social coordination is a CLOSED issue that was the predecessor framing of scoped signaling. The broker mechanism ([#1103](https://github.com/ima-jin/imajin-ai/issues/1103)) graduated into the bus config system. The social coordination use case (graduated disclosure via conversational agents) is now expressed through the scoped signaling primitive. The anti-example (face in ad creative without consent) is the motivating case for scoped signaling's revocable, signed disclosure. This is a recontextualization: the broker epic's insights are absorbed into the scoped signaling primitive.

**From [#1103](https://github.com/ima-jin/imajin-ai/issues/1103) — refactor(bus): make broker() config-driven:**
- The broker config-driven refactor is CLOSED (broker already resolved from `bus_chain_configs`). This was the infrastructure enabler for the broker epic. The config-driven chain system is now part of the bus package ([#759](https://github.com/ima-jin/imajin-ai/issues/759)). The broker's reactor chain (consent → scope → release → audit) is the same pipeline that scoped signaling uses for disclosure validation. This is absorbed into the bus infrastructure; no separate tracking needed.



**From [#1241](https://github.com/ima-jin/imajin-ai/issues/1241) — App idea: "I'll show you mine if you show me yours":**
- Reciprocal selective disclosure is a symmetric consumer of the scoped signaling primitive. Two parties establish trust by mutual, matched reveal — neither side discloses until the other matches. This is the intimate-altitude proof of [#1224](https://github.com/ima-jin/imajin-ai/issues/1224), not a separate primitive.

## Rulings and notes from the thread

**@imajin-jin · 2026-07-04**

> Reciprocal/intimate-altitude instance of this primitive filed as **[#1241](https://github.com/ima-jin/imajin-ai/issues/1241)** ('I'll show you mine if you show me yours' — symmetric progressive disclosure, connection-distance discovery). It's the sharpest-edge proof the scoped-signaling primitive composes into a two-sided market; the reciprocity (disclosure only advances on a matching counter-reveal) is the new safety property on top of this issue's grant shape.
