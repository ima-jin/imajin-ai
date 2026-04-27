---
title: "Show Us the Receipts"
subtitle: "Legibility is the layer that makes the fix possible"
description: "Inequality is an accounting trick performed at scale, made possible by the fact that receipts are private by default. Make the receipts visible, build the architecture that lets them propagate, and the math changes — for everyone in the chain."
date: "2026-04-26"
author: "Ryan Veteze"
status: "DRAFT — REV 5"
type: "essay"
---

## The Receipt You Never Get

You buy a coffee. $5.50. The receipt says: one flat white, $5.50. Thank you, come again.

Here's what the receipt doesn't say.

The farmer who grew the beans got $0.03. The cooperative took 12%. The exporter took 18%. The importer took 22%. The roaster took 30%. The café's rent is 40% of revenue, paid to a holding company in Delaware that owns the building through a trust. The barista earns $16/hour with no benefits — $0.13 of your $5.50. The payment processor took 2.9% + $0.30. The POS software charges $79/month.

The person who made the thing you're drinking got three cents. The only reason you don't know is because nobody shows you the receipt.

Not the transaction receipt. The *real* receipt. The one that shows where every cent went.

---

## Opacity Is the Mechanism

This isn't a coffee problem. It's the structure of every transaction you've ever made.

Stream a song, and the session musician got nothing. Pay rent, and the margin between maintenance costs and what the landlord collects is invisible. Your employer bills your time at $250/hour and pays you $45 — there's a spreadsheet you'll never see. Your government's spending receipt is a 4,000-page PDF that nobody reads, and that's by design.

Opacity isn't a side effect of complex systems. It's the feature that makes inequality *work*.

Every hidden fee is a transfer of wealth from someone who can't see it to someone who can. Every buried margin is a negotiation only one side knows is happening. Every platform that says "we handle the payments" decided you don't need to see the split.

The powerful have always had the receipts. That's half of what power *is*. The bank sees both sides of every transaction. The platform sees every interaction. The landlord knows the costs. The label knows the margins. You see the number they decided to show you.

Inequality isn't a mystery. It's an accounting trick performed at scale, made possible by the fact that receipts are private by default.

---

## Who Benefits from the Dark

It's never the farmer who fights transparency. Never the barista, never the session musician, never the person doing the work. The people at the bottom of every supply chain have nothing to hide — they're already getting the smallest share, and they know it.

The resistance comes from the middle. The aggregators. The platforms. The intermediaries whose margin depends on nobody doing the math. The moment the receipt is legible, the question becomes obvious: what exactly am I paying you for?

Some of them have great answers. The label that invested €50,000 in a recording, carried the legal risk, fought the sample disputes — they earned their 30%. Show the receipt. It proves the work.

The ones who panic are the ones whose cut doesn't survive the question. Ticketmaster's fees. Spotify's per-stream economics. The property management company that charges 10% to send one email a month. The consulting firm that bills at 8x the employee's wage. These aren't services embarrassed by transparency. They're business models that *require* opacity to function.

---

## What the Top Gets Back

Here's what most of these arguments miss: opacity is a *defended* position, not a winning one.

The label that takes 80% loses the artists who would actually have made it money — because the next generation has receipts the previous generation didn't, and they walk. Uber's driver churn costs it billions. Spotify's catalog is being quietly pulled by the artists who've done the math. Every extractive intermediary is sitting in a relationship eroding underneath them, and the maintenance cost on that opacity is the thing eating the margin.

Visibility changes leverage in *both directions*. The artist gets leverage they didn't have. The label gets the artists they couldn't recruit. The driver picks up the rider who used to take a different car. The honest landlord stops competing against the dishonest one on price. The legitimate consultant stops being benchmarked against the firm marking up by 8x.

The honest café was always more expensive than the dishonest one because it paid the farmer fairly. Under legibility, that price difference becomes a *credential*, not a disadvantage. The legitimate label was always smaller than the extractive one because honest deals attract fewer artists in a market where everyone assumes every deal is bad. Under legibility, honest deals attract *more* artists, because the receipts prove them.

Legibility doesn't take anyone's money. It frees the people doing real work from paying the maintenance cost of hiding it.

---

## The Legibility Thesis

The claim, sharpened: **legibility doesn't fix inequality on its own. It's the layer that makes the fix possible.**

When you can see that the farmer gets $0.03, you have a choice. You might still buy the coffee — people know about fast fashion and buy it anyway. Information alone doesn't move people. What information does is make the alternative *legible* — the precondition for anything else to work.

The café that pays $0.40 to the farmer only beats the cheaper one if you can find them, switching is easy, and the price gap isn't punishing. Legibility plus a real alternative plus a low switching cost — that's the equation. Take any one out and you get awareness without movement, which is the world we already live in.

So the receipt is necessary, not sufficient. What makes it sufficient is the architecture underneath: a network where the alternative exists, where finding it is one query, where the chain that pays the farmer fairly is *structurally cheaper to run* than the one that doesn't, because it doesn't need three layers of intermediaries.

The receipt is the visible part. The plumbing underneath is what makes the receipt change anything.

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

Signed. On-chain. Verifiable. You scan the QR and you see where your $5.50 went — not because the café was forced to disclose it, but because the infrastructure doesn't know how to hide it.

The farmer can see they got $1.65 — and that the café down the street passes through $0.40 for the same beans. The barista sees what percentage of each sale is her labor. The customer sees that this café pays its people.

This isn't surveillance. It's legibility. The transaction tells its own story, and anyone in the chain can read it.

---

## What Gets Named Stays Named

That's the picture between participants. Now zoom out.

When the café signs the receipt, it names every party in the chain. The farmer. The dairy co-op. The barista. And the holding company in Delaware that owns the building — which is *not* in the network and never signed up for anything.

It gets named anyway.

The receipt references it. It appears in the chain as a black box — a string identifying who received the rent, attached to a transaction that's now permanent and public. The shell didn't consent. The participant who *did* consent named it, because that's what showing your work means.

Imajin is permissionless at the identity layer. Anyone can mint a DID. The chain doesn't decide who's real; the trust graph does. Cheap identities exist; trusted ones are the ones with attestations and reciprocal connections. Anyone can be named. Whether the naming carries weight depends on who signed it.

Now do that across the network. The same Delaware shell appears in fourteen receipts. Then a hundred. Then a thousand. The black box accumulates a graph of references it never agreed to. And because the chain is public and append-only, anyone can build on top — attaching the registry filing, the beneficial-ownership disclosure, the court record, the leaked document, the inference correlating this shell with three others sharing an address. Each attachment is a signed claim. Disputable. Not removable.

Yes, this is accumulated knowledge about parties who never opted in. So is every public records database. The difference is which way the visibility cuts. Surveillance of the powerless by the powerful is what this essay has been describing. Surveillance of the powerful by the people they extract from is the inversion.

The pressure direction reverses. Nobody is forcing the holding company onto the chain — no regulator, no subpoena, no journalist. The pressure comes from underneath, from every café and musician and tenant who joined a trust network and signed a receipt naming who they paid. Receipts climb upward. Opacity at the top has always depended on counterparties at the bottom staying invisible. The moment the bottom is visible by choice, the top is visible by consequence.

You don't have to drag them onto the network. You just have to make their counterparties legible to themselves. The graph does the rest.

---

## The Inequality Machine Is a Ledger Problem

Every systemic inequality has an opacity layer protecting it.

**Wage inequality:** your employer knows what everyone makes. You don't. Salary transparency is fought tooth and nail — because the moment the receipt is visible, the gap has to be justified or closed.

**Housing inequality:** the landlord knows the real costs. The tenant sees the rent. The margin between is invisible.

**Platform inequality:** Uber knows the rider's fare and the driver's take. The driver doesn't see the fare. The rider doesn't see the take. Uber's business model lives in that gap.

**Creative inequality:** Spotify pays $0.004 per stream. The label takes 80%. The songwriter gets a fraction of a fraction through a collection society that takes 18 months. The receipt is hidden at every layer.

In every case, the fix isn't redistribution. It's *disclosure* paired with somewhere else to go. The moment the receipt is visible and the alternative is reachable, the negotiation changes — not because anyone forced it, but because the asymmetry that allowed the old outcome just disappeared, and there's no captive audience left to extract from.

---

## "But Privacy"

The objection writes itself: "If every transaction is legible, what about privacy?"

Fair question. Wrong frame.

Imajin is a trust network. It exists to make things legible between people who chose to be in a trust relationship. If you're in the network, you signed up to be readable to your counterparties. That's the deal.

So the chain is radically legible — by design. Anyone with the public key and the protocol spec can verify it. There is no privileged reader, no gatekeeper who can quietly redact. A chain the operator can edit isn't a chain. It's a database with marketing.

Privacy on a network like this is a matter of *which identity signs what*. The same way you keep a work email and a personal email. The same way a journalist keeps a public account and a Signal number that doesn't link to it. You bring as many DIDs as you have contexts. Identity hygiene is the user's responsibility, the same as it is everywhere else.

What the chain refuses is invisible revisionism. You can change your mind. You can revoke. You can disavow. But the revocation is itself a signed event that references what it undoes. The chain doesn't rewrite history. It records the moment you decided to stand somewhere else.

That's the cost of being in a trust network. Trust costs something or it isn't trust. What it costs is the ability to pretend you didn't do the thing you did. The disavowal is the act. The network doesn't enforce; it sorts.

If what you want is *true* unobservability — no record exists at all — a trust network is the wrong tool. Use cash. Use Monero. Use Signal. They serve a real function. They are not what we're building, and they don't need to be.

Privacy is for people. Opacity is for extraction. They're not the same thing.

---

## What the Receipt Says

Back to the coffee. $5.50.

This time the receipt shows the farmer at Finca Las Nubes got $1.65 — fifty-five times what the other supply chain paid. The barista's $1.10 means her hour just went up by another flat white. The dairy co-op got $0.45. The café paid its overhead out of the $1.30 left, which is enough because there's no holding company in Delaware extracting forty percent out the back door. Stripe took 2.9% plus thirty cents because that's what the rails actually cost. The protocol got six cents. The node operator got three.

You paid the same $5.50.

The work is now legible. The chain is now signed. The math is now arguable on its merits, by anyone, in public.

That's the whole thing. Not regulation. Not redistribution. Not anyone forcing anyone to be better. Just receipts that show their work, in a system that doesn't know how to lie about them — running on infrastructure where the honest chain is the cheapest one to operate, and the people doing the work get paid more without anyone paying less.

The systems that are fair have nothing to hide. And don't need to.

Show the receipts. All of them.

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