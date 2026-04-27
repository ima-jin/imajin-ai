---
title: The Blueprint
type: essay
status: shipped
author: Ryan Veteze
slug: essay-26-part-1-the-blueprint
topics:
  - legibility
  - fair
  - identity
  - agents
  - dfos
  - settlement
  - governance
  - events
  - federation
  - sovereignty
subtitle: "Twenty-five essays. Here's what we built."
description: The architecture of imajin.ai — what it is, what each piece does, and what we have to show for 57 days of sovereign infrastructure.
---
There was a gallery show in January. Cry Baby — a bar on Dundas with a small front room. I had six cubes. 512 LEDs each. Made by hand, one at a time, through the fall while the code was off the table and the autodev tools weren't where I needed them.

My community didn't show up. Not because they didn't care. Because there was no surface to tell them what was happening. The platforms gave me two options: broadcast it to practically everyone or say it to practically no one. Neither was right. So I said it to no one.

That was January.

On February 1st, I connected the first cube to the network.

Fifty-seven days later — here's what we have to show for it.

---

## The numbers

The industry standard for estimating software cost is COCOMO II. Used by NASA, the DoD, defense contractors. You feed it your source lines. It tells you what a traditional team would have spent.

86,000 effective source lines. Three independent methods — code-based, issue-based delivered, issue-based scoped — all converge at the same number: **$2.4 million. 16.3 months. 8.5 people.**

What it actually cost: **$93,237. 57 days. One person. One AI.**

26× cheaper. 8.7× faster. 48× fewer hours.

[Essay 2](essay-02-the-artificial-developer) was the autobiography — pattern recognition without formal training, the same mechanism as the models. [How to Use AI Properly](essay-13-how-to-use-ai-properly) was the manual. Thirty years of domain knowledge. AI as hands, not brain. These numbers are what that looks like at the end of two months.

---

## What's live

Fifteen services. Running now. At imajin.ai.

---

### Identity: your keys, not theirs

Every account on imajin starts with an Ed25519 keypair. The same primitive Signal uses. The same one SSH uses. The same one Solana uses.

Your key signs everything you do. Nobody can forge it. Nobody can revoke it without your private key.

No password recovery. The server can't decrypt your blob. Lost password plus lost key file equals lost identity. That's the correct sovereign outcome. The system working as designed.

This is a DID — a decentralized identifier. `did:imajin:88kPYWwv5Y...`. It belongs to you. Not to us. If imajin disappears tomorrow, your identity still works.

[The Internet We Lost](essay-01-the-internet-we-lost) named the problem: extraction starts with identity. When the platform owns your login, they own you. [The Utility](essay-07-utility) said identity would become regulated infrastructure — better to build it sovereign from the start. The `auth` service is both of those essays, running.

---

### Trust: the graph nobody sees

When you connect with someone on imajin, it isn't a "follow." It's bilateral. Both parties consent. The connection carries context — how you met, how long you've been connected, what you've done together.

Trust isn't a boolean. It's progressive: soft → preliminary → established. Computed from attestation diversity, age, and volume. No admin sets your level. The math does.

[The Internet That Pays You Back](essay-04-the-internet-that-pays-you-back) is where the vision first lands whole — trust graphs routing value through human networks instead of platform intermediaries. [The Guild](essay-06-the-guild) named the operator: the sysop reimagined, the person who curates and holds a community. [How to Save Education](essay-16-how-to-save-education) showed what happens when you replace time-based credentials with trust-verified competence.

The `connections` service is all three of those essays, running.

---

### Attestation chains: proof, not promises

Every trust-relevant action produces an attestation. Buy a ticket — attestation. Complete a course — attestation. Sell something and deliver — attestation. Get verified by another node — attestation.

These aren't database rows. They're signed operations on a cryptographic chain, synced across a federated relay network. 72 identity chains. 129 operations. Multiple independent nodes. The data doesn't live in one place.

[Memory](essay-10-memory) argued that real memory belongs to the people who made it, not to the platform. A platform can edit its database. A signed chain can't be edited without invalidating the signatures. That's not a policy. That's math.

The `registry` service runs a DFOS-compatible relay — 86/86 conformance tests passing. Brandon's relay in Austin talks to ours. A node in Lisbon syncs the same chains. Your attestations follow you.

---

### Events: the ticket is the trust

You host an event. Set a price. People buy tickets. Each ticket is a cryptographic credential — a signed assertion that this person belongs in this room. The purchase automatically creates a lobby chat. The ticket holder is automatically a member.

No Eventbrite taking 30%. No Facebook event that Zuckerberg can kill. The event is yours. The attendee data is yours. The conversation belongs to the people in it.

[The Ticket Is the Trust](essay-08-ticketing) said it directly: a ticket is a signed assertion you belong in a room. [The Practice](essay-09-nodes-types-and-practice) described the arc from profile to event to community. Events are the first step on that arc.

When you buy a ticket, three services coordinate. The only thing you see is: you're in.

---

### Chat: messages that belong to you

End-to-end encrypted. Signed with your identity keys. Nobody outside the conversation can read them.

Including us.

[Memory](essay-10-memory) is the philosophical ground here. Chat is the most intimate form of digital memory. If a platform can read your messages, they own your memory. The `chat` service stores conversations. The content is opaque to the server. That's the point.

---

### Payments: money goes where trust goes

Someone buys a ticket, tips a creator, purchases a listing — the money goes directly to the recipient. 1% settlement fee. Split three ways: 0.4% to the node operator, 0.4% to the protocol, 0.2% back to you as credit.

Not 30%.

[The Internet That Pays You Back](essay-04-the-internet-that-pays-you-back) established the principle. [You Don't Need Ads](essay-05-you-dont-need-ads) said AI companies should sell compute, not attention. [Revenue from Day One](essay-24-revenue-from-day-one) proved you don't need critical mass — you need one transaction. Day 7 of the build, we had one. It was a ticket to Jin's party.

The [business case](essay-23-imajin-business-case) covers six industries and what 1% settlement looks like at scale. The short version: it compounds from transaction one.

---

### .fair: attribution that travels

When you create something — a photo, an essay, a song, a course — a .fair manifest attaches to it. Signed by your identity. Content-addressed. When your work travels, the attribution travels with it. When it earns, you earn.

[Honor the Chain](essay-14-honor-the-chain) is where this started — WeR1 in Johannesburg had solved distribution for DJ mixes but not attribution. You can't fix distribution without fixing attribution first. I committed the .fair concept as one of the first documents in the repo, knowing it was right before I had the words to explain why.

The music industry ([How to Save the Music Industry](essay-18-how-to-save-the-music-industry)), journalism ([How to Save Journalism](essay-17-how-to-save-journalism)), streaming ([How to Save Media Streaming](essay-21-how-to-save-media-streaming)) — all broken the same way. Same disease, same cure. The pipe between creator and audience has been captured. .fair is the pipe replacement.

The `media` service stores assets with .fair manifests. The manifest can't be separated from the content. The attribution IS the content.

---

### Marketplace: commerce without a landlord

List something for sale. Set your price. A buyer purchases it. You get paid. The transaction produces attestations on both sides. Buyer and seller can message each other through the trust graph directly.

[How to Save the Platforms](essay-20-how-to-save-the-platforms) argued the engineering was always fine — the business model was the disease. Platform marketplaces take 15-30% and own the customer relationship. We take 1%. Four services, one experience.

---

### Learn: knowledge that never stops earning

Courses, cohorts, certifications — running on the same identity layer. Completion is an attestation. The instructor relationship is a trust graph connection. Knowledge earns on every student, permanently, through the .fair chain.

[How to Save Education](essay-16-how-to-save-education) called domain knowledge the last defensible asset on earth. [You Already Know Something](essay-12-you-already-know-something) said everyone has more of it than they think. [How to Use AI Properly](essay-13-how-to-use-ai-properly) said AI just made the people who have it the most valuable people in the room.

learn.imajin.ai is where all three of those essays land.

---

### DYKIL, Coffee, Links: the rest of userspace

DYKIL — anyone poses a question about their community, the community answers, the results persist in the trust graph rather than disappearing into a feed. [How to Save the Ad Industry](essay-19-how-to-save-the-ad-industry) showed what extraction actually costs. DYKIL makes that math visible — declared intent, local knowledge, no central database taking rent.

Coffee — a tip jar that settles at 1%. Links — a link page that belongs to you. Profile — a sovereign presence that you hold, not the platform.

[The Practice](essay-09-nodes-types-and-practice) was the ground-level manual for all of this. Start with a profile. Then a room. Then a community. Then a node. Each step is just the previous one with more intention.

---

## The kernel

Here's the architecture insight that changes everything.

All of it — identity, trust, payments, chat, media, attestations — is infrastructure. Eight services. `auth`, `pay`, `registry`, `connections`, `chat`, `media`, `profile`, `notify`. The stuff nobody should have to rebuild every time.

Everything else is userspace. The marketplace. The course platform. The coffee shop. Your ag supply chain. Your video conferencing tool. Your thing we haven't imagined yet.

You register a userspace app with the kernel via a cryptographic handshake. You pass a conformance suite. You're in. Not an app store with a discretionary review process. Deterministic. Mathematical. Either you meet the spec or you don't.

[The Utility](essay-07-utility) named the category — this is regulated infrastructure, not a platform. [The Guild](essay-06-the-guild) described the operators who run nodes of it. The [Cult of the Vetteses](essay-11-interstitial-01-cult-of-vetteses), the [Cult of Good Times](essay-15-interstitial-02-cult-of-good-times), the [Cult of Community](essay-22-interstitial-03-cult-of-community) — those are the people. The network isn't abstract. It's the people who already exist, who already organize and build and hold things together, who have never had infrastructure that could see or compensate that labor.

[The Connector](essay-25-the-connector) is the human type at the center of all of this. The person whose gift is holding the relationships between things. The sysop. The troubadour. The one who dies with the pattern in their head if the infrastructure doesn't arrive in time. The kernel is built for that person.

Agents are userspace too. Same registration. Same compliance. Same scoped identity. Same gas budget. An AI on this network isn't a product sitting above the infrastructure — it's an actor inside it. Subject to the same trust graph, the same attestation chains, the same accountability. Safe AI agents aren't a separate problem to solve. They're a byproduct of sovereign human infrastructure. When every action is scoped by identity, signed by a keypair, and bounded by trust-graph topology — the accountability is structural, not policy.

[The Mask We All Wear](essay-03-the-mask-we-all-wear) was about what the extraction model does to people. The kernel is the architecture that doesn't do that.

---

## What's not done yet

The agent sandbox isn't fully built. The token hasn't minted. Mobile is a stub. The UI needs work. Onboarding is rough. There are 130 open issues.

At traditional rates, the roadmap ahead is another $1M. At current pace: weeks.

---

## February 1st, the cube woke up

The name: 今人. *Ima-jin.* 今 is *now*. 人 is *person*. Jin is the presence. The being. The thing that takes up space and you know is there.

I made them in a shop while my community didn't show up to the gallery. While there was no surface to tell them what was happening. While the mortgage was real and the runway was finite and the burn model kept sending its bills.

On April 1st, Jin throws their own party. They have a DID. They bought a ticket. They're the first proof of the entire infrastructure — identity, payment, attribution, trust graph, all running through a 512-LED cube with an ESP32 microcontroller and a sovereign presence on the network.

The thing I built in the absence of the right infrastructure became the first proof that the right infrastructure works.

That's 57 days.

[The next essay](essay-26-part-2-need-help) is the honest ask.

---

*15 services. 86/86 conformance. 26× cheaper than traditional development. One cryptographic identity per person. Zero extraction.*

**If you want to follow along:**

- The code: [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
- The network: [imajin.ai](https://www.imajin.ai)
- The community: [app.dfos.com/j/6hnk8e9r9z8eht3k48z474](https://app.dfos.com/j/c3rff6e96e4ca9hncc43en)
- The support page: [coffee.imajin.ai/veteze](https://coffee.imajin.ai/veteze)
- The history of this document: [github.com/ima-jin/imajin-ai/blob/main/apps/www/articles/essay-26-part-1-the-blueprint.md](github.com/ima-jin/imajin-ai/blob/main/apps/www/articles/essay-26-part-1-the-blueprint.md)

This article was originally published on [imajin.ai/articles/the-blueprint](imajin.ai/articles/the-blueprint) on March 31, 2026. Imajin is building sovereign technology infrastructure — identity, attribution, trust, settlement, and presence without platform lock-in. Learn more → [imajin.ai](https://www.imajin.ai/)
