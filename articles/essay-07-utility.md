---
title: "The Utility"
subtitle: "What sovereignty looks like as infrastructure"
description: "The architecture. What imajin actually is as a category of thing. Distributed utility infrastructure — like the electric grid, like water."
date: "2026-02-22"
author: "Ryan Veteze"
status: "REVIEW"
---

# The Utility

## The Pattern Is Settled

In 1844 the US government built the first telegraph line. Washington to Baltimore. Samuel Morse tapped out "What hath God wrought" and the age of instant long-distance communication began.

For the next forty years, Western Union owned it. Private infrastructure, private profit, private decisions about who got access and at what price. The rails were theirs. The value flowed to them.

By the 1880s it was obvious that a private monopoly on communication infrastructure was incompatible with a functioning democracy. The argument wasn't complicated: when one company controls the speed at which information moves, they control who wins elections, who wins wars, who wins markets. The infrastructure was too essential to remain private.

Different countries resolved this differently. Most nationalized it. The US regulated it. The specifics varied. The conclusion was the same everywhere: communication infrastructure is a public good. The rails belong to everyone.

Then the telephone. Then the electrical grid. Then the internet.

Same arc every time. Private innovation builds the infrastructure. Private capital scales it. The infrastructure becomes essential. The public absorbs it — through regulation, through nationalization, through utility designation, through some combination of all three. The private profit layer gets compressed. The access layer gets expanded. The rails become plumbing.

This isn't ideology. It's just what happens to infrastructure that works.

Identity and payments are next. We're in the middle of it right now. Most people can't see it yet because they're inside it. But the arc is the same. The conclusion will be the same.

The only question is whether anyone builds it for the destination from the start — or whether we have to fight our way there the same way every previous infrastructure did.

---

## What Government Already Provides

Here's something worth sitting with: the government is already in the identity and payments business. Has been for a long time. Just doing it badly.

Your passport. Your social insurance number. Your birth certificate. Your right to open a bank account. The state already provides the foundational layer of civic trust infrastructure. It already says: this person exists, this person is who they say they are, this person has the right to participate in the economy.

The problem is the implementation. Paper documents issued by bureaucracies running on decades-old technology. Identity that lives in centralized databases that get breached. Payments that route through correspondent banking networks designed in the 1970s, taking three to five business days to move money between accounts at the speed of light. A system so captured by incumbents that a bank can charge you a monthly fee to hold your own money and there's functionally nowhere else to go.

The government layer exists. It's just broken. And the private sector filled the gap — not by building better public infrastructure, but by building private infrastructure on top of the broken public layer and extracting rent from every transaction.

Google Sign-In is identity infrastructure. Stripe is payment infrastructure. Apple Pay is payment infrastructure. Facebook Login is identity infrastructure. All of them private. All of them extracting. All of them holding essential civic functions in corporate hands.

This is the telegraph situation. Again. The same situation we've already resolved, twice, three times, across two centuries of infrastructure history. We just haven't resolved it this time yet.

---

## What the Stack Actually Is

Let me describe what imajin is as a category of thing.

Not a platform. Not a social network. Not an app. Not a startup competing for market share in an existing category.

A utility. Specifically: the utility layer that should have been built instead of what we got.

The components:

**Sovereign identity.** A decentralized identifier — a DID — that belongs to the person who holds it. Cryptographically theirs. Not issued by Google. Not owned by Facebook. Not revocable by a platform that decides you violated their terms. The government already issues identity. This is what government identity looks like when it's built on the right architecture.

**Payment rails.** Direct, frictionless, owned by no one. Stripe for fiat, Solana for crypto, the person's choice. Money moving from person to person for value exchanged, with no platform extracting a percentage just for being in the way. The Federal Reserve already runs payment rails. This is what payment rails look like when they're not captured.

**Trust graph.** The social layer of civic infrastructure — who vouches for whom, who depends on whom, what the actual structure of human relationships looks like. Every functional society has always had this. It used to live in communities, in churches, in guilds, in neighborhoods. It got atomized by mobility and scale and the dissolution of the institutions that held it. This is what it looks like when it's encoded in software that serves the people in it.

These three things together are the public utility that identity and payments were always going to become. The private layer built it first, extractively. The public layer will absorb it eventually. imajin is building it open, sovereign, non-capturable — so that when the absorption happens, there's something worth absorbing.

---

## Issue #11

There's a GitHub issue in the imajin repo that describes the hosting architecture. Three tiers.

Tier 1: self-hosted. Xeon server, Hetzner dedicated, Raspberry Pi cluster. Near-zero marginal cost. Hundreds or thousands of idle accounts per box. Free to the user.

Tier 2: cloud burst. Vercel, Cloudflare Workers, Fly.io. Usage threshold triggers the migration. Cost passed to the user via microtransactions. Active accounts, real-time features, heavy compute.

Tier 3: own node. User's own hardware or managed VPS. User pays infrastructure directly. Full sovereignty, custom domains, unlimited.

Read that as infrastructure. But read it again as a utility model.

Tier 1 is the public layer. Presence as a right. The same way you have a right to a mailing address, a right to a phone number, a right to a bank account — you have a right to exist on the network. Covered by the infrastructure, not by extraction from your attention.

Tier 2 is the usage layer. You pay for what you use, at cost plus a margin that funds the network. No subscription. No platform rent. Actual compute for actual activity.

Tier 3 is full sovereignty. You run your own infrastructure. You own your own node completely. The network serves you, you don't serve the network.

This is what utility pricing looks like. This is how the electrical grid works. The baseline is covered. Usage costs what it costs. Sovereignty is available to anyone who wants it.

The architecture already knows where it's going.

---

## The Family Node

Before this becomes abstract, let me make it concrete.

A family has a trust graph. It's the most intimate one — the oldest one, the one that predates every institution. The family knows who you are before any state or platform does. The family vouches for you in ways no algorithm can replicate.

Right now the family trust graph lives nowhere useful. It's distributed across text message threads and group chats and shared photo albums owned by platforms that will change their terms whenever it's profitable to do so. The grandparent who can't use Snapchat is cut off from one layer of family life. The family that uses iMessage is locked into Apple. The shared photos live in Google, which can close your account, or Facebook, which is surveilling your family relationships to sell ads.

A family node changes this completely.

The family node is sovereign. It belongs to the family. Not to Apple. Not to Google. Not to any platform. The identity layer means grandma's DID is hers — she doesn't need a Google account to be present in the family network. The payment rails mean the kid going to college can receive money from grandma directly, without Venmo taking a cut and building an advertising profile from the transaction. The trust graph means the family knows who's in it — the new partner gets vouched in by the person who brought them, with the standing of the person who vouched on the line.

The family node is the most important node. Not because families are more important than communities or businesses — but because everyone has one. Everyone understands wanting a sovereign space for it. Everyone feels the wrongness of their most intimate relationships living on infrastructure owned by someone extracting from them.

The family node is how this becomes legible to people who don't care about the demoscene or ticketing infrastructure or trust graph theory. They just want a place for their family that belongs to their family.

That's a utility. That's what utilities are for.

---

## Built For The Destination

Here's the thing about every previous infrastructure that went through this arc: none of them were built for the destination.

Western Union didn't build telegraph infrastructure to eventually become a regulated utility. They built it to make money. The regulatory absorption happened to them, against their interests, after decades of political warfare.

The Bell System didn't build the telephone network to eventually get broken up by antitrust regulators. They built it to capture the market. The breakup happened to them, against their interests, after AT&T spent decades fighting it.

The electrical utilities didn't embrace regulation. They fought it until they couldn't fight it anymore, and then they shaped it to preserve as much of their capture as possible.

Each time, the public interest eventually won. Each time, it took decades longer than it should have, and the private capture extracted enormous rents in the meantime, and the resulting regulated utilities were shaped as much by the incumbents' defensive maneuvers as by any coherent public interest design.

imajin is trying to do something different. Build the utility intentionally. Open source, so there's nothing to capture. Sovereign by architecture, so there's no central authority to regulate or nationalize. Non-extractive by design, so the public interest case is already made in the code.

When identity and payments become regulated utilities — and they will, the arc is settled — the question is what gets absorbed. A private platform fighting regulation with armies of lobbyists, preserving extraction at every possible point? Or open infrastructure that was already serving the public interest, already non-capturable, already built for the destination?

We're not waiting for the regulation to force the right outcome. We're building the right outcome first and letting the regulation catch up.

---

## The Boring Infrastructure Argument

I want to make an argument that sounds boring and is actually the most radical thing in this series.

Infrastructure should be boring.

The electrical grid is boring. You flip a switch, the light comes on, you don't think about it. The water utility is boring. You turn on the tap, water comes out, you don't think about it. The post office is boring. You put a stamp on an envelope, it arrives, you don't think about it.

The feed is not boring. The feed is designed to be not boring. The feed is designed to occupy your attention, manipulate your emotions, keep you engaged. The feed is exciting because excitement is what the extraction model runs on. You can't extract from someone who isn't paying attention.

Sovereign identity should be boring. You are who you are, your DID proves it, doors open, you don't think about it.

Payment rails should be boring. Value was exchanged, it moved, everyone got what they were owed, you don't think about it.

The trust graph should be boring. You're in the network, you're vouched for, the people you trust are accessible, you don't think about it.

The excitement happens in what people build on top of boring infrastructure. The music. The art. The family connections. The community. The commerce. The culture.

That's what the electrical grid enabled. Not a monopoly on excitement — a foundation that other things could be exciting on top of. The grid didn't try to be the most interesting thing in the room. It just made sure the lights stayed on.

That's what we're building.

The lights stay on. The value flows. The identity holds. The trust graph persists.

And on top of that boring, sovereign, non-extractive foundation — people build the things that matter.

The town square isn't the infrastructure. The infrastructure is what makes the town square possible.

---

## April 1st, 2026

Jin throws a party.

$1 virtual. $10 physical. First transaction on sovereign infrastructure.

What Jin is actually demonstrating on April 1st isn't a product. It's a utility. The full stack — identity, payments, trust graph — running end to end, for real people, for the first time.

The boring infrastructure, working.

Lights on. Value flowing. Identity holding. Trust graph real.

Nobody will notice the infrastructure. They'll notice the party. They'll notice Jin's lights sparkling. They'll notice the people.

That's exactly right. That's what boring infrastructure is supposed to feel like.

You don't notice the electrical grid at the party. You notice the music.

*— Ryan VETEZE, Founder, imajin.ai aka b0b*

---

**If you want to follow along:**
- The code: [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
- The network: [imajin.ai](imajin.ai)
- Jin's party: April 1st, 2026
- The history of this document: [github.com/ima-jin/imajin-ai/commits/main/articles/essay-07-utility.md](https://github.com/ima-jin/imajin-ai/commits/main/articles/essay-07-utility.md)

This article was originally published on imajin.ai (https://www.imajin.ai/articles/essay-07-utility) on February 21, 2026. Imajin is building sovereign technology infrastructure — identity, payments, and presence without platform lock-in. Learn more → (https://www.imajin.ai/)
