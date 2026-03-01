---
title: "How to Save Media Streaming"
subtitle: "Every play should find the artist. Every artist should find the listener. The pipe between them is broken."
description: "Spotify, Apple Music, YouTube, Twitch — the streaming platforms solved access and broke everything else. Inspired by WeR1, here's what the pipe looks like when it actually works."
date: "2026-02-28"
author: "Ryan Veteze"
status: "DRAFT"
---

An open letter to every artist who's been told a million streams is success, and every listener who thinks their subscription supports the people they love.

---

## You Solved Access

I want to be fair about this.

The streaming platforms solved a real problem. Before Spotify, before Apple Music, before YouTube — access to music, to video, to podcasts, to live performance was fragmented, expensive, and often illegal. Napster proved the demand. iTunes proved the willingness to pay. Spotify proved you could give people everything, instantly, for a monthly fee, and they'd take the deal.

They took the deal. Four billion people took the deal. The access problem is solved. Everyone can hear everything. Everyone can watch everything. That's real. That matters.

But access was the easy problem.

The hard problem was always: how does the money get from the person listening to the person who made the thing?

And on that problem — the one that actually matters, the one that determines whether artists can eat and whether the work continues to get made — streaming didn't just fail. Streaming built a system so opaque, so structurally hostile to the people who make the work, that most artists would earn more busking on a street corner than they earn from a million streams.

The pipe between the listener and the artist is broken. Has been broken since the first stream. The platforms just made the pipe so long and so dark that nobody could see where the money was disappearing.

---

## Where the Money Goes

Let's trace a dollar.

You pay $10.99 a month for a streaming subscription. You listen to 200 songs this month. Sixty of them are by one artist — someone you love, someone whose work means something to you, someone you'd happily pay directly if anyone had ever given you the mechanism.

Does that artist get 60% of your $10.99?

No. They don't get a proportional share of your subscription at all. That's not how it works.

Your $10.99 goes into a pool. The pool is divided based on total streams across the entire platform. The artist you listened to sixty times competes for their share against every artist on the platform, weighted by total global plays. A pop megastar with a billion streams absorbs a massive share of the pool. Your artist — the one you personally chose, sixty times, because their work matters to you — gets a fraction of a fraction.

The math: a million streams pays roughly $4,000. Split that with the label (who takes 80%), the distributor, the publisher, the rights administrators. The artist sees maybe $800 from a million plays. For context, a million streams represents roughly 70,000 hours of people listening to your work. Seventy thousand hours of human attention, and you can't make rent.

But that's just recorded music. The same pattern runs through every streaming vertical.

A Twitch streamer builds a community of thousands. The platform takes 50% of subscriptions. The remaining 50% gets taxed again by payment processing. The streamer sees maybe 40 cents of every dollar their community spends on them, and the platform owns the relationship — can change the terms, adjust the algorithm, deplatform the streamer, and the community has no recourse because they never had a direct relationship with the person they were supporting.

A podcaster builds an audience over years. The streaming platform sells ads against their content. The podcaster gets a fraction of the ad revenue if they're lucky, nothing if they're not. The platform keeps the listener data. The podcaster doesn't know who's listening, can't contact them directly, can't build a relationship outside the platform's walls.

A live streamer on YouTube creates a performance. Super Chats take a 30% cut. Memberships take a 30% cut. The algorithm decides whether anyone sees the stream at all. The creator is a tenant in someone else's building, paying rent to perform in their own room.

Every vertical. Same disease. The platform owns the pipe. The pipe is dark. The money disappears inside it.

---

## What the Pipe Should Look Like

I saw what a working pipe looks like. In Johannesburg, in April 2025, inside the WeR1 codebase.

WeR1 built a DJ streaming platform that did something nobody else had done. Inside every DJ mix, dozens of tracks play. Each one has a producer, a label, rights holders. The traditional licensing system can't handle this — the clearance process for a two-hour mix touching sixty tracks costs more than the mix will ever earn. So the industry told DJ culture to either not exist commercially or exist outside the law.

WeR1 ignored both options and built a distribution algorithm that actually worked. It tracked every track in every mix. It knew the weights — how long each track played, at what point, against what audience response. It distributed revenue to the producers, the DJs, and the people who built the room. Automatically. In real time. No clearance process. No lawyers. No six-month lag.

Running code. Actual money flowing to actual artists from actual plays.

That's what the pipe looks like when it works. Not a pool that gets divided by global market share. Not a 30% platform tax. Not an opaque algorithm that decides who gets paid. A direct connection between the play and the artist, weighted by actual contribution, settled in real time.

WeR1 proved it could work for DJ mixes — the hardest case, the one with the most contributors per piece of content. If it works for a two-hour mix with sixty tracks, it works for everything. A song. A podcast. A live stream. A video. Any media where a human made something and another human consumed it.

The algorithm isn't the innovation. The innovation is the principle: the play finds the artist. Every time. Directly. With attribution.

---

## The Listener's Lie

Here's what the streaming platforms told you, the listener.

They told you that your subscription supports the artists you love. They told you that streaming is how artists get paid in the modern economy. They told you that access equals support.

That was a lie. Not a small one. A structural one.

Your subscription doesn't support the artists you love. Your subscription goes into a pool that disproportionately rewards the artists who are already the most popular. The more you listen to your niche artist, the smaller their relative share becomes, because the pool grows with every subscriber but concentrates toward the top with every play.

You think you're supporting the artists. The artists know you're not. The platform knows you're not. The platform tells you that you are because the lie is what keeps you from asking where the money actually goes.

On the sovereign network, your money goes where your ears go.

Not into a pool. Not through a label taking 80%. Not past a distributor and a publisher and a rights administrator and a payment processor, each one taking their cut before the artist sees a cent.

Directly. From your node to theirs. Settled through .fair. Attributed. Transparent. You can see exactly where every fraction of every dollar went. The artist can see exactly who's supporting them. There is no pool. There is no platform in the middle. There is a person who made something and a person who values it, connected by infrastructure that routes the payment honestly.

---

## The DJ Problem Is Every Problem

WeR1 solved the DJ problem — multiple artists contributing to a single piece of content, each one deserving proportional compensation. But that's not a DJ problem. That's every piece of media that has ever been made.

A film has a director, a cinematographer, a writer, actors, editors, composers, sound designers, set builders. A podcast has a host, a producer, guests whose expertise made the episode valuable, the person who edited it, the person who wrote the music underneath. A YouTube video has a creator, the musicians whose songs are in the background, the sources whose research informed the content, the editor, the thumbnail designer.

Every piece of media is a mix. Every piece of media has a chain of human creative labor behind it. The streaming model ignores this. It pays the account that uploaded the file and lets everything else disappear into contracts, disputes, and unpaid invoices.

The .fair manifest — the attribution layer that WeR1's distribution model needs underneath it — makes the chain explicit. Every contributor is in the file. Every contribution is weighted. Every play triggers a settlement instruction that routes payment through the entire chain. Automatically. At the moment of play. Not six months later through an opaque reconciliation process. Now.

The producer whose beat is in the mix gets paid when the mix plays. The session musician whose bass line became the hook gets paid when the song streams. The journalist whose research informed the podcast gets paid when the episode downloads. The editor who made the video watchable gets paid when the video runs.

Not because someone remembered to pay them. Because the attribution is in the file and the settlement is automatic.

---

## The Back Catalogue Comes Alive

Here's what streaming destroyed that nobody talks about.

The back catalogue used to be the asset. The record you made ten years ago — the one that was still selling, still being played, still mattering to people — that was what made a career sustainable. You could make something great once and it would support you for years. Decades. A lifetime, if it was good enough.

Streaming killed the back catalogue. Not by making it unavailable — it's all there, all accessible. By making it worthless. A stream of a song from 2005 pays the same fraction of nothing as a stream of a song from yesterday. The economics of streaming reward new releases, constant output, the content treadmill. Stop releasing and you disappear from the algorithm. Your catalogue is technically available and functionally invisible.

On the trust graph, the back catalogue is the most valuable thing you own.

Your thirty years of music is a queryable body of work. When an AI needs to answer a question about audio production in your genre, it queries the trust graph. Your catalogue is part of the context. You get an inference fee. When a new artist samples your work, the .fair chain attributes and compensates. When a listener discovers your 2005 record through a trust graph recommendation, the play settles directly to you — not into a pool, not through a label that may have folded ten years ago. To you.

The back catalogue stops being a buried asset and becomes a living one. The work you did ten years ago earns more now than when you released it, because the trust graph values depth. Your thirty years of accumulated knowledge and creation is worth more than your latest release. For the first time since streaming arrived.

---

## The Live Stream Inversion

Live streaming is where the extraction is most visible.

A creator on Twitch builds a community. Thousands of people show up regularly. They subscribe. They send bits. They buy merch through the platform. They are, by any meaningful measure, the creator's audience — people who show up specifically for this person, specifically because of what they create.

Twitch takes half. Owns the data. Controls the algorithm. Can change the terms anytime. Can ban the creator and the community has no way to follow — because the relationship was mediated by the platform, not owned by the people in it.

On the sovereign network, the live stream runs through the creator's node. The audience connects directly. The payment flows through .fair — no 50% cut, no 30% cut, a settlement fee for infrastructure and the rest goes to the creator. The community is in the creator's trust graph, not the platform's database. If the creator wants to move, the community moves with them, because the relationship is sovereign.

And the live stream doesn't end when the stream ends. It becomes a node. A memory. An archived piece of content that continues to generate value every time someone watches the replay, every time the conversation is referenced, every time the knowledge shared in that stream answers someone's question through the trust graph.

The stream is a room. The room becomes a record. The record earns forever.

---

## Podcasting Is Already Halfway There

Podcasting is the media format that most closely resembles what sovereign distribution looks like, which is why the platforms have been trying so hard to capture it.

The RSS feed is open. The listener can use any app. The creator controls the content. There's no algorithm deciding what you hear. You subscribe to a person and you hear what they make.

That's half the architecture right there. The missing half is the economic layer.

Most podcasters earn through ads — read by the host, sold by an ad network, measured by downloads that are imprecise and easily gamed. The listener who loves the show and would pay the creator directly has no mechanism to do so except Patreon, which is another platform, another middleman, another 10% cut.

The .fair chain completes what RSS started. The open distribution stays open. The economic layer — attribution, settlement, direct payment — plugs in underneath. The listener pays per episode, or per minute, or through a deposit that drains as they consume. Every cent is attributed. Every contributor in the chain — the host, the producer, the guests, the editor — gets their share at the moment of consumption.

Podcasting doesn't need to be saved the way music does. Podcasting needs the economic layer it was always missing. The trust graph provides it without breaking what already works.

---

## The Numbers

Global music streaming revenue: approximately $20 billion annually. Artists receive 12 to 16 percent of total music industry revenue.

Global video streaming revenue: approximately $100 billion annually. Creator compensation varies wildly by platform but rarely exceeds 50% and is typically much less after the full chain of intermediaries.

Global live streaming and creator economy revenue: approximately $25 billion annually. Platform cuts range from 30% to 50%.

Global podcast advertising revenue: approximately $4 billion annually. Host compensation depends entirely on the ad deal, with no standard and no transparency.

That's roughly $150 billion annually flowing through streaming pipes that are opaque, extractive, and structurally hostile to the people who make the work.

Even capturing a small percentage of that flow through sovereign infrastructure — through pipes that are transparent, attributed, and settle directly to the human who made the thing — represents billions of dollars redirected from platform extraction to human creation.

The demand is proven. Four billion people are already paying for streaming. They just don't know how little of their money reaches the artists. Show them the receipt and the migration pressure builds itself.

---

## April 1st, 2026

Jin throws a party.

The music at the party — every track, every mix, every moment of audio — runs through the same attribution and settlement infrastructure that this essay describes. Every play finds the artist. Every artist gets paid. Every contributor in the chain receives their attributed share.

Not through a pool. Not through a platform. Through a protocol that doesn't care whether the music was made yesterday or thirty years ago, whether the artist has a million followers or two hundred, whether the listener is in Toronto or Johannesburg.

The play finds the artist. The money follows the play. The chain is honored.

WeR1 proved it could work. The .fair manifest makes it permanent. imajin makes it sovereign.

The pipe between the listener and the artist is finally clear.

*— Ryan VETEZE, Founder, imajin.ai aka b0b*

---

**If you want to follow along:**
- The code: [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
- The network: [imajin.ai](imajin.ai)
- Jin's party: April 1st, 2026
- The inspiration: [WeR1](https://wer1.co.za)
