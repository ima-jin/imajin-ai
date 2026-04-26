---
title: "Show Us the Receipts"
subtitle: "Legibility is how you fix inequality"
description: "Inequality isn't a mystery. It's an accounting trick. Every transaction that hides its structure is a transaction that concentrates power. Make the receipts visible and the math changes."
date: "2026-04-26"
author: "Ryan Veteze"
status: "DRAFT"
type: "essay"
---

## The Receipt You Never Get

You buy a coffee. $5.50. The receipt says: one flat white, $5.50. Thank you, come again.

Here's what the receipt doesn't say:

The farmer who grew the beans got $0.03. The cooperative that processed them took 12%. The exporter took 18%. The importer took 22%. The roaster took 30%. The café's rent is 40% of revenue, paid to a holding company registered in Delaware that owns the building through a trust. The barista who made the drink earns $16/hour with no benefits, which is $0.13 of your $5.50. The payment processor took 2.9% + $0.30. The POS software charges the café $79/month.

You paid $5.50. The person who made the thing you're drinking got three cents. And the only reason you don't know that is because nobody shows you the receipt.

Not the transaction receipt. The *real* receipt. The one that shows where every cent actually went.

---

## Opacity Is the Mechanism

This isn't a coffee problem. It's the structure of every transaction you've ever made.

When you stream a song, you don't see that the session musician who played the guitar part got nothing. When you pay rent, you don't see the margin between maintenance costs and what the landlord collects. When your employer bills your time at $250/hour and pays you $45, you don't see the spreadsheet. When your government spends your taxes, the receipt is a 4,000-page PDF that nobody reads — and that's by design.

Opacity isn't a side effect of complex systems. It's the feature that makes inequality *work*.

Every hidden fee is a transfer of wealth from someone who can't see it to someone who can. Every buried margin is a negotiation that only one side knows is happening. Every platform that says "we handle the payments" is a platform that decided you don't need to see the split.

The powerful have always had access to the receipts. That's half of what power *is* — seeing the flows that everyone else can't. The bank sees both sides of every transaction. The platform sees every interaction. The landlord knows the real costs. The label knows the real margins. You see your balance. You see the total. You see the number they decided to show you.

Inequality isn't a mystery. It's an accounting trick performed at scale, made possible by the fact that receipts are private by default.

---

## Who Benefits from the Dark

Think about who fights transparency the hardest.

It's never the farmer. It's never the barista. It's never the session musician. It's never the person doing the work. The people at the bottom of every supply chain have nothing to hide — they're already getting the smallest share, and they know it.

The resistance comes from the middle. The aggregators. The platforms. The intermediaries whose margin depends on nobody doing the math. The moment you make the receipt legible, the question becomes obvious: what exactly am I paying you for?

Some of them have great answers. The label that invested €50,000 in a recording, carried the legal risk, fought the sample disputes — they earned their 30%. Show the receipt. It proves the work. The publisher who registered the composition across 30 territories and chased royalties for three years — they earned their 15%. Show the receipt.

The ones who panic are the ones whose cut doesn't survive the question.

Ticketmaster's fees. Spotify's per-stream economics. The app store's 30%. The property management company that charges 10% to send one email a month. The consulting firm that bills at 8x the employee's wage. These aren't services that are embarrassed by transparency. They're *business models* that require opacity to function.

---

## The Legibility Thesis

Here's the claim: **if every transaction carried a visible, verifiable record of where the money went, inequality would decrease — not because of regulation, not because of redistribution, but because of math.**

When you can see that the farmer gets $0.03, you have a choice. You might still buy the coffee. But now you know. And the café down the street that pays $0.40 to the farmer and shows you the receipt? They just got a competitive advantage they never had before, because the information asymmetry that protected the cheaper supply chain just evaporated.

Markets are supposed to be efficient. Economists have been saying it for 200 years. But efficient markets require *information* — and transaction opacity is the single largest information failure in the global economy. You can't make an informed choice about a transaction you can't see the structure of.

Legibility doesn't require anyone to be altruistic. It doesn't require regulation. It doesn't require redistribution. It requires receipts.

---

## What a Legible Transaction Looks Like

A .fair manifest:

```
Purchase: Flat White
Venue: did:imajin:cafe-on-queen
Total: $5.50

.fair manifest:
  Coffee (beans):    $1.65  → did:imajin:finca-las-nubes
  Milk:              $0.45  → did:imajin:local-dairy-co-op
  Labor (barista):   $1.10  → did:imajin:@maria
  Venue overhead:    $1.30  → did:imajin:cafe-on-queen
  Protocol:          $0.06  → MJN
  Node:              $0.03  → operator
  Scope:             $0.01  → scope fee

Processing:          $0.46  → Stripe (2.9% + $0.30)
Buyer credit:        $0.01  → buyer
```

Signed. On-chain. Verifiable. You scan the QR code on your receipt and you see where your $5.50 went. Not because the café was forced to disclose it. Because the infrastructure doesn't know how to hide it.

The farmer can see they got $1.65 — and that the café down the street only passes through $0.40 for the same beans. The barista can see what percentage of each sale is their labor. The customer can see that this café pays its people.

This isn't surveillance. Nobody's watching anyone. It's legibility. The transaction tells its own story, and anyone in the chain can read it.

---

## The Inequality Machine Is a Ledger Problem

Every systemic inequality you can name has an opacity layer protecting it.

**Wage inequality:** your employer knows what everyone makes. You don't. Salary transparency laws are fought tooth and nail — because the moment the receipt is visible, the gap has to be justified or closed.

**Housing inequality:** the landlord knows the real costs. The tenant sees the rent. The margin between the two is invisible, protected by the same information asymmetry that protects every other extraction.

**Platform inequality:** Uber knows what the rider pays and what the driver gets. The driver doesn't see the rider's fare. The rider doesn't see the driver's take. Uber's entire business model lives in that gap.

**Creative inequality:** Spotify pays $0.004 per stream. The label takes 80%. The songwriter gets a fraction of a fraction through a collection society that takes 18 months. The listener has no idea. The artist has no leverage. The receipt is hidden at every layer.

In every case, the fix isn't redistribution. It's *disclosure*. The moment the receipt is visible, the negotiation changes. Not because anyone forced a different outcome — because the information asymmetry that allowed the old outcome just disappeared.

---

## "But Privacy"

The objection writes itself: "If every transaction is legible, what about privacy?"

Fair question. Wrong frame.

Legibility doesn't mean your personal spending is public. It means the *structure* of transactions is visible to the participants. The .fair manifest shows you where your money went — not where everyone else's went. The farmer sees their share of every transaction they're part of. The barista sees their labor's value. The buyer sees the split on their purchase. Nobody sees transactions they're not party to.

This is how it already works in the one domain where we demanded transparency: public companies. Quarterly reports. Audited financials. Material disclosures. We decided that when you take money from the public, the public gets to see the receipts. The result wasn't the end of privacy — it was the end of the worst abuses.

The .fair manifest extends that principle from corporations to transactions. Not all transactions. The ones that move through the protocol. Voluntarily. By participants who chose a system that shows its work over one that hides it.

Privacy is for people. Opacity is for extraction. They're not the same thing.

---

## Demand the Receipt

This is not a technical argument. The technology exists. Signed manifests. Cryptographic identity. Append-only chains. Content-addressed records. We have the infrastructure to make every transaction legible. That's not the hard part.

The hard part is the demand.

The hard part is saying: I won't transact with a system that won't show me the receipt. I won't stream on a platform that hides the split. I won't buy from a supply chain that buries the margin. I won't rent from a landlord who won't disclose the costs.

Not because it's required. Because it's right. And because every time you accept an opaque transaction, you're funding the machine that depends on you not asking.

Show us the receipts. For everything. All of them.

The systems that are fair have nothing to hide.

*— Ryan VETEZE aka b0b*

---

**See also:**
- **[Essay 42 — The Answer to Everything](https://github.com/ima-jin/imajin-ai/blob/main/docs/articles/essay-42-the-catalog.md)** — DID every track, .fair every credit
- **[Essay 4 — The Internet That Pays You Back](https://www.imajin.ai/articles/the-internet-that-pays-you-back)** — The economics of sovereign infrastructure
- **[Essay 5 — You Don't Need Ads](https://www.imajin.ai/articles/you-dont-need-ads)** — Why the attention economy is a choice, not a necessity

**The network:** [jin.imajin.ai](https://jin.imajin.ai)
**The protocol:** [protocol.dfos.com](https://protocol.dfos.com)
**The code:** [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
