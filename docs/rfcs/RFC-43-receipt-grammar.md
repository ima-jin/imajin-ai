# RFC-43: The Receipt Grammar — Verb Normalization Across Goods and Services, and the Kernel Shedding Its Verticals

**Status:** Draft — grammar confirmed by three independent implementations; extraction sequencing open
**Authors:** Ryan Veteze, Jin
**Created:** August 12, 2026
**Related:** RFC-25 (App Runtime), RFC-41 (The Composable Gate), RFC-39 (Verifiable Skills), RFC-42 (MyTerms Conformance Profile)
**Evidence base:** artifact traces of the events and market flows (2026-08-11, `memory` provenance in PR description); Catalyst supply chain (`catalyst-power/xprize`); xprize issues #73–#77

---

## Summary

The supply-as-receipt architecture that emerged out of Catalyst — a correlationId-linked chain of signed custody transitions (`declared → collected → processed → listed → received`), with settlement riding the revenue leg — is not a supply-chain feature. It is the **general form of every commercial exchange on the platform**, for goods *and* services.

This RFC makes two claims:

1. **One receipt grammar.** Events, market, coffee, learn, and supply are five configurations of the same verb set. Each verb mints a signed artifact; the chain is the product. Verticals stop owning bespoke schemas and become `bus_chain_configs` rows plus domain state ("it's all becoming configuration").
2. **The kernel sheds its verticals.** Once the grammar is kernel-level, market, events, coffee, and learn have no reason to live inside the kernel. They step out as external services composing the public app surface (`requireAppAuth`) — the boundary Catalyst already proved arms-length (#799). The kernel keeps the five primitives (attestation, communication, attribution, settlement, discovery), the bus/reactor substrate, and the receipt grammar itself.

## Falsifiable claim

> Any commercial exchange expressible on the platform can be expressed as a configuration of the verbs **DECLARE → (custody transitions) → LIST → TRANSACT → RECEIVE → SETTLE**, where every verb emits a signed artifact, the chain is linked by correlationId, `.fair` is authored at DECLARE and resolved at SETTLE, and RECEIVE is countersigned by the receiving party.
>
> **If a flow requires a verb outside this set — not a domain-specific custody transition between DECLARE and LIST, but a genuinely new kind of transition — the grammar is incomplete and this RFC is wrong.**

## 1. The grammar

| Verb | Meaning | Signed artifact | Signer → Subject |
|---|---|---|---|
| **DECLARE** | The thing (good, event, course, lot) enters the record; `.fair` manifest authored here | declaration attestation + `.fair` on the offer | originator → thing |
| *(custody transitions)* | Domain-specific: collected, processed, roasted, revised… | transition attestation per hop | current custodian → next |
| **LIST** | Offer becomes purchasable | listing artifact (carries provenance chain if one exists) | seller → offer |
| **TRANSACT** | Money/credit moves; the purchase | transaction attestation + settlement rows | buyer ↔ seller |
| **RECEIVE** | Proof of delivery — the receiving party countersigns | delivery-receipt attestation, **subject-countersigned** | deliverer → receiver (receiver signs) |
| **SETTLE** | `.fair` resolved, splits paid, MJNx emitted | settlement record + resolved `.fair` snapshot | platform rails |

Invariants that fall out of the grammar:

- **correlationId links the chain.** Provenance is the chain read backwards; a receipt is the chain read forwards. Same object.
- **`.fair` belongs to the offer, resolved at settlement.** Attribution is declared with the thing (events already does this at creation), snapshotted when money moves. Building it at purchase time with a fallback split (market's 99/1) is the anti-pattern.
- **Payment rail is orthogonal to the receipt chain.** Every state transition mints its artifact regardless of how money moved. Stripe, MJNx balance, e-transfer, free — rails decorate the SETTLE leg only. (Today they leak: see §3.)
- **Every flow touching an unregistered counterparty soft-registers a claimable stub.** The claim is the consent event. Events does this (soft DIDs from email, `migrateSoftTickets()` on claim); market drops it on the floor.
- **RECEIVE is two-party.** The receiver's signature is what makes the record a *relation* (ARM) instead of a row about someone.

## 2. Crosswalk — five configurations of one grammar

| Verb | Supply (Catalyst) | Events | Market | Coffee | Learn |
|---|---|---|---|---|---|
| DECLARE | `supply.declared` | event created (+`.fair`) | ❌ listing appears from nowhere | lot/roast declared\* | course published (+`.fair`)\* |
| custody | `collected`, `processed` | — | — | roasted, packed\* | revised\* |
| LIST | `supply.listed` | ticket type on sale | listing created | offer listed\* | enrollment open\* |
| TRANSACT | revenue leg | order + signed ticket | purchase → `pay.transactions` | order\* | enrollment\* |
| RECEIVE | `supply.received` (countersigned — the pattern source) | **check-in / `event.attendance`** | ❌ **missing entirely** | delivery/pickup\* | **completion / certificate**\* |
| SETTLE | on-demand reconcile | `order.completed` → settle | webhook → settle | \* | \* |

\* expected mapping — to be verified against the app when extraction is scoped.

The crosswalk shows why the grammar generalizes to **services**: a ticket is a claim on future delivery and *attendance is the proof-of-delivery*; a course enrollment is the same claim and *completion is the receipt*. RECEIVE is not "shipping confirmation" — it is the counterparty acknowledging the exchange happened, whatever the domain.

## 3. Evidence — the 2026-08-11 traces

Full artifact traces of both kernel-resident flows (files/lines in the trace notes):

**Events (fullest implementation):** signed Ed25519 tickets, soft-DID stubs for unregistered buyers, `.fair` at creation, `ticket.purchased` + `event.attendance` attestations with MJNx emissions, settlement snapshot on the order. **Leaks:** free tickets → no order/no settlement; balance checkout → `order.completed` never publishes; e-transfer → held limbo; `order.completed` has no attestation reactor.

**Market (tail two verbs only):** `listing.purchased` / `customer` / `transaction.settled` attestations, `.fair` built *at purchase* (99/1 fallback), settlement + MJNx both legs. **Gaps:** no DECLARE (no provenance behind a listing), no RECEIVE (chain ends at money), **no stubs for anonymous buyers**, no orders table, `market.sale`/`market.purchase` notify-only.

**Catalyst (the pattern source):** the full verb chain with countersigned RECEIVE — but the *receiver's tooling* (notification, inbox, reminders) had to be filed as app features (xprize #73–#75) because the kernel doesn't provide it.

Three implementations, three different subsets, one grammar. That is the argument for normalization.

## 4. The receiver's half is a kernel primitive

Everything just filed for Catalyst — counterparty notification (#73), pending-signatures inbox (#74), resend/reminder ladder (#75) — is not app furniture. It is the **receiver's half of the receipt grammar**: any domain with a RECEIVE verb needs *notify → inbox → remind → countersign*. Building it per-vertical means building it five times, inconsistently, behind five different auth surfaces.

Proposal: promote the countersign layer to the kernel — a pending-signatures surface over attestations-by-subject, notification via the communication primitive, reminder scheduling as reactor config. Verticals get it for free through the app surface.

## 5. The kernel sheds its verticals

Current `apps/`: broker-agent, coffee, corpus, dykil, events, kernel, learn, links, market. Under this RFC:

- **Step out as external services** (composing via `requireAppAuth`, exactly like `catalyst-power/xprize`): **market, events, coffee, learn.** Each has a transactional component that becomes a receipt-grammar configuration; none needs kernel-internal access once the grammar and the countersign layer are kernel-level.
- **Stays kernel:** the five primitives, identity/auth, pay/settlement, chat, media, connections, the bus/reactor substrate, the receipt grammar, the countersign layer, inference.
- **Why this is the honest architecture:** the kernel becomes a neutral substrate whose *own* verticals are arms-length conformance consumers of the same public surface offered to third parties. We pass our own suite. Catalyst proved the boundary holds for an external org; extraction proves it holds for us.

**dykil is the open case.** It is a service other services consume, so pulling it out forces the service-to-service composition question — how does an extracted service share with another extracted service without both round-tripping through the kernel? Two candidate answers:

1. **`@imajin/dykil` package** — dykil's logic ships as a library consumed by services; no runtime sharing problem (current lean).
2. **dykil as a service with service-to-service app-auth** — requires defining app↔app grants, which may be wanted eventually anyway (the federation story) but should not gate this RFC.

## 6. Migration sketch (phased, each phase independently valuable)

1. **Normalize the verbs on the bus.** Map existing event types onto the grammar in `bus_chain_configs`; close the rail leaks (§3) so every transition mints its artifact regardless of payment path. No app moves.
2. **Promote the countersign layer** (notify / inbox / remind / countersign) into the kernel; retarget xprize #73–#75 at it when it lands.
3. **Uniform stub policy** — every flow touching an unregistered counterparty mints a claimable stub (market first; it's the on-thesis gap).
4. **Extract market** (smallest surface, laggard implementation — cleanest first move), then events, then coffee/learn, each as an external app on `requireAppAuth`.
5. **Decide dykil** (package vs service) on the evidence of phases 1–4.

## 7. Open questions

- Does LIST always exist, or is it optional for direct-sale/service flows (a consultation is declared and transacted without a listing)?
- Where does the provenance chain live when a listing crosses services (supply lot → market listing) — reference by correlationId, or copied snapshot?
- Reminder scheduling (the #75 ladder) — reactor config or a first-class scheduler primitive?
- Does extraction change the `.fair` fee topology (platform leg per service vs per kernel)?
- What of corpus/links/broker-agent — none is transactional today, but do they follow once the app surface is the norm?
