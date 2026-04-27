---
title: "Show Us the Receipts"
subtitle: "Legibility is the layer that makes the fix possible"
description: "Inequality isn't a mystery. It's an accounting trick performed at scale, made possible by the fact that receipts are private by default. Make the receipts visible — and build the architecture that makes the alternative reachable — and the math changes."
date: "2026-04-26"
author: "Ryan Veteze"
status: "DRAFT — REV 3"
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

Here's the claim, sharpened: **legibility doesn't fix inequality on its own. It's the layer that makes the fix possible.**

When you can see that the farmer gets $0.03, you have a choice. You might still buy the coffee. People know about fast fashion and buy it anyway. People know about Amazon's warehouses and keep their Prime memberships. Information alone doesn't move people. What information does is make the alternative *legible* — and that's the precondition for anything else to work.

The café down the street that pays $0.40 to the farmer only beats the cheaper one if you can find them, switching is easy, and the price gap isn't punishing. Legibility plus a real alternative plus a low switching cost — that's the whole equation. Take any one out and you get awareness without movement, which is the world we already live in.

So the receipt is necessary. It is not, by itself, sufficient. What makes it sufficient is the architecture underneath it: a network where the alternative actually exists, where finding it is one query, where transacting on it doesn't cost more than the extractive version because the chain that pays the farmer fairly is *structurally cheaper to run*, not more expensive. No 30% platform tax. No four layers of intermediaries. No holding company in Delaware. The honest supply chain wins on price the moment the dishonest one stops being subsidized by your inability to see it.

That's the work. The receipt is the visible part. The plumbing underneath is what makes the receipt change anything.

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

In every case, the fix isn't redistribution. It's *disclosure* — paired with somewhere else to go. The moment the receipt is visible *and* the alternative is reachable, the negotiation changes. Not because anyone forced a different outcome — because the information asymmetry that allowed the old outcome just disappeared, and there's no longer a captive audience to extract from.

---

## "But Privacy"

The objection writes itself: "If every transaction is legible, what about privacy?"

Fair question. Wrong frame.

Imajin is a trust network. That's what it is. It exists to make things legible between people who chose to be in a trust relationship — buyer and seller, contributor and beneficiary, operator and the people they serve. The whole architecture is built around that choice. If you're in the network, you signed up to be readable to your counterparties. That's the deal.

So the chain is radically legible — by design, not as a side effect. Anyone with the public key and the protocol spec can verify it. There is no privileged reader. There is no gatekeeper who can quietly redact. That property is the whole point. A chain the operator can edit isn't a chain. It's a database with marketing.

Privacy on a network like this is a matter of *which identity signs what*. The same way you keep a work email and a personal email. The same way a journalist keeps a public account and a Signal number that doesn't link to it. You bring as many DIDs as you have contexts. Your stigmatized donation goes through one identity. Your professional reputation lives on another. The chain doesn't link them unless you do. Identity hygiene is the user's responsibility, the same as it is everywhere else.

What the chain refuses to do — what makes this architecture different from every database that came before it — is invisible revisionism. You can change your mind. You can revoke. You can withdraw an attestation. You can disavow a chain you used to sign. But the revocation is itself a signed event that references what it undoes. The chain doesn't rewrite history. It records the moment you decided to stand somewhere else.

That is the cost of being in a trust network. Trust costs something or it isn't trust. What it costs is the ability to pretend you didn't do the thing you did. People who realign realign. The disavowal is public. The disavowal is the act. People who change cluster with the changed. The network doesn't enforce; it sorts.

If what you want is *true* unobservability — not "private from the public" but "no record exists at all" — then a trust network is the wrong tool. Use cash. Use Monero. Use Signal. Those serve a real function. They are not what we're building, and they don't need to be.

We're building the trust layer. The thing you opt into when the value of being known to your counterparties exceeds the cost of being known. For most economic activity between people who want to keep doing economic activity together, it does.

Privacy is for people. Opacity is for extraction. They're not the same thing.

---

## What the Receipt Says

Back to the coffee. $5.50.

This time the receipt shows you that the farmer at Finca Las Nubes got $1.65 — fifty-five times what the other supply chain paid. The barista's $1.10 means her hour just went up by another flat white. The dairy co-op down the road got $0.45. The café paid its rent and its overhead out of the $1.30 left, which is enough because there's no holding company in Delaware extracting forty percent of revenue out the back door. Stripe took its 2.9% plus thirty cents because that's what the rails actually cost. The protocol got six cents. The node operator got three.

You paid the same $5.50.

The work is now legible. The chain is now signed. The math is now arguable on its merits, by anyone, in public.

That's the whole thing. Not regulation. Not redistribution. Not anyone forcing anyone to be better. Just receipts that show their work, in a system that doesn't know how to lie about them — running on infrastructure where the honest chain is the cheapest one to operate.

The systems that are fair have nothing to hide. Show the receipts. All of them.

*— Ryan VETEZE aka b0b*

---

**See also:**
- **[Essay 31 — The Receipt](https://github.com/ima-jin/imajin-ai/blob/main/docs/articles/essay-31-the-receipt.md)** — The same architecture viewed from the token side: receipts as the mint condition
- **[Essay 14 — Honor the Chain](https://www.imajin.ai/articles/honor-the-chain)** — The .fair protocol as attribution infrastructure
- **[Essay 4 — The Internet That Pays You Back](https://www.imajin.ai/articles/the-internet-that-pays-you-back)** — The economics of sovereign infrastructure
- **[Essay 5 — You Don't Need Ads](https://www.imajin.ai/articles/you-dont-need-ads)** — Why the attention economy is a choice, not a necessity

**The network:** [jin.imajin.ai](https://jin.imajin.ai)
**The protocol:** [protocol.dfos.com](https://protocol.dfos.com)
**The code:** [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)