---
title: "The Mask We All Wear"
subtitle: "On exhaustion, performance, and the gap we found when the world stopped"
description: "The psychological and emotional core. The office and the feed as one system. Exhaustion as the product. The most personal essay in the series."
date: "2026-02-22"
author: "Ryan Veteze"
status: "REVIEW"
---

# The Mask We All Wear

I have felt it my entire adult life and I could never name it.

The moment I walked into a corporate building — any corporate building, startup loft, sales pitch room, open-plan office with the exposed ductwork and the cold brew on tap — something in my body would go wrong. A low-frequency revulsion. Not at the people. Not exactly. Something more like watching a nature documentary where the behavior on screen is technically human but the thing behind the eyes isn't quite there.

I spent decades thinking it was me. That I was the broken one. That everyone else had decoded something I was missing — some social contract I hadn't been handed. That the problem with the office was that I didn't belong in it.

I was half right.

---

We know the choreography by heart. We learned it so young we can't remember learning it.

The hallway greeting. "Morning!" — bright, automatic, landing somewhere between your left ear and the wall behind you. The coffee ritual that is not about coffee. The standup that is not about standing up. The all-hands where hands are never all-in. The pizza party, which is not a party. The cheer when the numbers go up, the silence when they don't, and the careful, careful way everyone watches the room to calibrate how hard to cheer and how long to hold the silence.

We do this in startups. We do this in sales pitches. We do this in boardrooms and Slack channels and Zoom backgrounds chosen to signal exactly the right amount of personhood. The costume changes. The choreography doesn't.

And we know — we all know — that none of it is real.

That's the thing nobody says out loud. It's not that the mask is invisible. It's that pointing at it violates the only rule that actually matters: the performance only works if everyone agrees to perform.

---

Here's what took me thirty years to understand.

It's not culture. It's not personality types or office politics or bad management, though it wears all those costumes.

It's our relationship to money.

Act like this and you will get paid. That's the entire instruction. That's what we're actually learning when we learn the hallway greeting and the standup and the cheer. We're learning the behavioral syntax of someone who will be compensated. And we practice it until it's fluent. Until it runs without thinking.

And then — this is the part that breaks my heart — we protect it.

When someone refuses the performance, or names it, or just can't do it well enough to hide the gap — we come for them. Not out of cruelty. Out of necessity. Because we have worked so fucking hard to make ourselves repulsive to even ourselves, and we need to believe it was required. We need the sacrifice to have been the only option. The person who doesn't perform isn't just annoying. They're an existential threat. If they're right, the cost was optional. And we cannot afford for the cost to have been optional.

---

I can tell you exactly what it costs. Not in theory. In weeks.

I was the person who knew the system. The legacy booking platform — a billion dollars in transactions, a decade of accumulated complexity — lived in my head more than it lived in any documentation. I was the pattern library. I knew where the rot was working its way in. I could feel the load distribution eighteen months before the edge cases started compounding. That's not analysis. That's what happens when a brain like mine has been inside a system long enough. The system starts talking to you.

I asked to move to the marketing team. I'd been carrying that platform for years and I wanted a change of pace. They built a small dev team around me. A VP above. A director inserted between us. Three devs. The project: rebuild the entire consumer website from scratch. PHP/Laravel stack. Straightforward in concept. Genuinely hard in practice, because the legacy system was so complex that nobody fully understood it anymore.

Except me. And I'd moved myself out of the stack.

I'd done PHP dev over the years, but not at scale, and never in a way that stuck. And Laravel — with its layers of abstraction, its command-line cruft, its package ecosystem — was a different species from the environments I'd lived in. I'd been working closer to the architecture level for years. Visual, structural, compositional. Laravel felt like the opposite of all of that. Grating in a specific, low-level way that I couldn't route around. And I hadn't coded hard in about two years. The devs on the team were fluent in this stack. Fast, confident, native speakers.

I was starting from zero in a language I actively disliked.

I'd gotten my autism and ADHD diagnosis five months earlier. I was open about it. I was trying to get people to be human about it. I don't think anyone in the company knew what to do with that information. I didn't either, not really — I was still integrating it myself, still reframing thirty years of *what is wrong with me* into something I could work with.

What I needed was simple. Someone to walk me through the first few steps of the new stack. Orient me. Give me a working pattern I could match against. Once I had that, I was fine. I'd always been fine once I had that. It was the only thing I ever needed.

It wasn't that nobody tried. I sat with the Laravel devs on screen share calls a couple of times. But after each call my brain would just... not retain it. File it as incomplete and move on. It took me a long time to understand why.

Every other stack I'd ever absorbed, I'd learned in a room with someone. Physically present. And the mechanism that made it work was tiny — the ability to turn around mid-thought and say *what's that thing again?* Three seconds. No ceremony. The question asked at the exact moment the confusion existed, before the moment passed and the thread dissolved. That micro-loop, repeated enough times, is how my brain closes the absorption circuit.

On a screen share with someone in another state, that loop doesn't exist. Instead there's a whole negotiation running in parallel: am I taking too long, is this person waiting on me, have I asked this already, am I coming across as someone who doesn't know what they're doing. By the time I've worked out whether it's okay to ask, the moment is gone. And then the call ends, and the session gets filed as incomplete, because it *was* incomplete. The circuit never closed.

I didn't have language for this at the time. I just felt like I was failing. Again. The org chart offered no better path — the VP treated knowledge as territory, information moved up the hierarchy and stopped, the director was positioned between us to control flow rather than facilitate it. But even if the structure had been different, the format was wrong. And I didn't know how to say that.

The bridge — the component that would feed the legacy data to Contentful, the major technical integration in the new site — fell to the server dev on the team. We had it modeled out. He was good. He kept saying he had it. *Don't worry about it.* Over ten months, he occupied himself with the surrounding work, the other layers of the build, and the bridge stayed open. That's not entirely on him — mostly it's on me. I was supposed to be managing him. The pattern library for the legacy system lived in my head and routing it through was the job. I should have dug into his anxiety earlier. Asked harder questions. Validated the work as it happened instead of taking the reassurance at face value.

But I speak in code. Always have. My process has always been the same — get a foothold in the stack, build the foundation, establish the optimal patterns, get something working. And then other devs duplicate it. The pattern is legible in the code itself. That's the language.

The Laravel stack crippled me. I couldn't get a foothold. Tried twice. Couldn't get traction. And without the ability to write the foundation, I had no way to communicate the model. I tried — whiteboards, Jira, object model conversations in words — but I couldn't tolerate the tools and the work started to feel like a grind in a way it never had when the code was flowing. The translation layer between my brain and the normal project management apparatus doesn't really exist. I'd never needed it before. I'd always just built the thing.

Then I went to South Africa.

Geordie, a co-founder of a music streaming startup, was someone I knew through my network. I ended up spending two months there — George, then Johannesburg, then Cape Town, then AfrikaBurn. Working remotely, watching their dev team use tools I hadn't touched — Cursor, Warp, the new way of working. I'd given up on certain kinds of development years earlier. Too hard to get oriented without someone to bridge me in. But watching those devs work, something shifted. I was making meaningful contributions to a stack I'd barely looked at. Within days.

I came back to Toronto with something unlocked.

The bridge that had been sitting open for ten months — I didn't touch it the whole time I was away. I came home on a Sunday. By the following Thursday I had it.

Ten days. Command-line driven. AI-assisted. The same recursive loop I'd been running since I was copying programs out of magazines — run the code, read the errors, feed them back, iterate until it clicks. Except now the AI was the person who could walk me through the first steps. The bottleneck that had defined my entire career, quietly, invisibly — just gone.

I spent that weekend refining a fully working tool. They let me go Monday morning. Nobody ever looked at it.

Thirty-seven weeks severance. The VP who signed the paperwork had no real idea what had just happened in the ten days prior. The knowledge that had lived in my head for a decade — the pattern library, the feel for where the system wanted to be — walked out the door with me.

They still haven't shipped the new website.

That's the extraction model at the organizational level. Not a metaphor. A mechanism. Knowledge trapped in hierarchy. Value destroyed by the architecture designed to capture it. The person who holds the thing that matters — underpaid, misunderstood, eventually separated when the extractable value is used up.

I was the product. Monday was the invoice.

---

I got let go in May. By October the freedom had started to have an edge to it — not panic, just gravity. The world houses people who are useful to it. I was going to have to figure out where I fit.

The realization didn't arrive as insight. It arrived as texture. Days with no standup to perform for, no choreography required, no extraction in progress — and gradually, in the space where the performance used to be, something else came into focus.

Nobody is available.

Not in a crisis way. In a structural way. The people I wanted to call were in meetings. The ones I wanted to see were at their desks. The friend who would have been perfect for a Tuesday afternoon walk was in a standup about the walk's equivalent — something that produced the appearance of value rather than the thing itself. I wasn't being ignored. I was watching, from the outside, how completely the machine fills a life when you're inside it. Every hour spoken for. Every impulse toward connection routed through the calendar.

It felt — and I say this without irony — rude. Which I know is the wrong word. But it's the honest one. Not their fault. Just: this is what total capture looks like from the outside.

Think about a new mother at home with an infant right now. The baby doesn't have a calendar. The baby has needs, and meeting them is the whole day, and it's relentless, and the people who would make it bearable are all at their desks because they have no choice or have forgotten they ever had one. And so she opens her phone. Not because the phone is good. Because the phone is the only place anyone is.

That's when I understood what the feed actually is.

It's not a social network. It's where the captured people go when they have thirty seconds. It's the crack in the door. The only available frequency. And it's been engineered — with full knowledge of what it's exploiting — to look like connection while extracting the thing that would have made connection possible.

This is where it gets uncanny. Where the revulsion I'd carried in my body for thirty years in offices finally found its mirror.

The feed has the same face as the office. That's what I couldn't name. That's what my nervous system had been registering without language.

The too-smooth surface. The performance of enthusiasm with no object. The careful calibration of expression to audience. The metrics where connection should be. On the phone it's likes and follower counts. In the office it's performance reviews and org chart position. The currency changes. The choreography doesn't.

Instagram is LinkedIn with better lighting. The personal brand is the mask in higher resolution. The influencer's grid is the all-hands cheer, infinitely scalable, optimized for the same thing the office optimizes for — the appearance of value rather than value itself.

We leave the building but we don't leave the machine. We just switch interfaces.

The office extracts your daylight. The feed extracts your dark. You go to bed empty and wake up to do it again, and somewhere in the loop — between the standup and the scroll, between the performance review and the notification pull — the question of who you actually are stops being urgent. Stops being askable. You're too depleted to ask it.

That's not an accident.

A depleted person doesn't organize. Doesn't build alternatives. Doesn't have the bandwidth to imagine different architecture. The 24-hour extraction pipeline isn't a side effect of two separate systems that happen to be predatory. It's one system with two interfaces, and the most important thing it produces isn't profit.

It's exhaustion.

Exhaustion is the product. Everything else is downstream of that.

And here's the cruelest part: you won't notice it for years. That's in the design too. It happens in increments so small that each one is deniable. One more standup. One more all-hands. One more notification at 11pm that you answer because that's what someone who is serious about their career does. One more performance review where you learn, again, to translate yourself into language the system can process.

By the time you feel it — really feel it, in your body, as weight — you're already years in. You have a mortgage that requires the salary. You have a title that requires the performance. You have an identity built around being someone who can handle it.

This is why they love young people. Fresh charge. Full battery. Not yet aware of what's being drawn down. The new hire at twenty-three has no idea what the standup costs because they haven't paid it ten thousand times yet. They cheer at the all-hands with something that might even be genuine. They post the company values on their personal Instagram. They are, briefly, extractable at scale.

Old people are dead batteries to the extractors. Not hated. Not even resented. Just no longer cost-effective. You can't train a new twenty-three-year-old to do what the fifty-year-old knows, but you can train them to do what the system needs, which is perform and produce and not yet understand what it's costing. And they're getting cheaper every year. There's always another cohort. The machine doesn't care about you specifically. It cares about charge.

This is what I couldn't name in the hallway. This is what my body was registering in every pitch room and open-plan office and product launch party. Not that the people were bad. That the system was feeding. And everyone in the room was either being fed on or learning to feed, and most of us were doing both at once, and none of us had words for it because the words would break the performance and the performance was load-bearing.

---

## The Ghost in the Machine

Not everyone gets captured the same way. This needs to be said honestly, without romance.

Some people move through the system as apparitions. Present, visible, functional — but not fully materially bound by it. The mask sits slightly wrong on their face. They perform but there's a gap between the performance and the self, and they can feel the gap, and that feeling is the thing that lets them see the machinery at all.

You can't see the water when you're drowning in it. The ghost can see it because the ghost isn't quite drowning.

But here's the honest part: being a ghost is a privilege, not a virtue. The capacity to refuse the performance — to be openly weird about money, to break the choreography, to build the alternative — almost always has a floor underneath it. Family money. A partner's income. A skill set rare enough to create options. An intellect that lets you walk alongside the system rather than inside it, that generates enough value that the system tolerates your strangeness rather than ejecting it.

The person with no floor cannot afford to break the performance. The performance is keeping them housed. Their compliance isn't weakness or blindness. It's rational behavior inside a system that has made sure there is nowhere else to stand.

I was in a privileged position at my last job and I knew it. My brain — the same pattern-matching, systems-sensing, neurodivergent wiring that made me bad at org charts and good at feeling where a system was about to fail — generated enough value that I had more latitude than most. I could be strange. I could be direct. I could push back on the VP in ways that would have ended someone else's tenure immediately. The intellect was the floor. It let me be a ghost when I needed to be.

That's not something I earned. It's something I was handed by the particular shape of my brain and the particular moment in history where that shape turned out to be useful.

The activists and organizers and builders I follow online who talk openly about money — who say what they need and why, who refuse the performance of abundance they don't have — they're not more virtuous than everyone else performing on the grid. They have floors too. Different ones. But they found the gap, or were born close enough to it that the gap was findable. And they're using it to tell the truth, which is the most subversive thing you can do inside a system that requires everyone to pretend the mask is a face.

This is not new. Every extractive system in human history has produced its ghosts. The monk who opted out of feudal extraction. The jester who told the king the truth because he was officially not serious. The artist patronized just enough to be free just enough. The philosopher who needed a wealthy friend. The slave who kept a secret interior life the system couldn't reach. The ways people have always found the gap — always, in every system, at every scale — and used it to see clearly and sometimes to build the alternative.

And every extractive system tries to close the gap. Makes the floor harder to reach. Makes the options narrower. Makes the alternative less legible. The arms race underneath the arms race.

We are living through a particularly aggressive round of gap-closing right now. And the people running it don't think of themselves as gap-closers. They think of themselves as innovators.

---

## What COVID Broke Open

For a few months in 2020 something extraordinary happened.

The floor appeared for millions of people simultaneously. Not just for the privileged. For huge swaths of the population, across class lines and job types, the performance became optional in a way it had never been optional before. Not a ten-day holiday where you're technically off but still checking email, still half-present, still — if you're honest — performing relaxation for an audience of one anxious self. Truly off. Truly home. Truly without the choreography.

And people discovered, at scale, that they preferred themselves without it.

Their kids saw them differently. They saw their kids differently. The house became a place again instead of a place you left. Relationships that had been managed at a distance — held together by the busyness that kept the real questions from being asked — became suddenly, uncomfortably, necessarily legible. Some of them didn't survive the legibility. Some of them became real for the first time.

People walked outside and noticed things they'd stopped noticing. Cooked. Made things with their hands. Slept. Felt the weight of their own exhaustion for the first time because there was finally enough stillness to feel it.

The mask came off. Not for everyone. Not cleanly. The frontline workers, the essential workers, the people whose floors were lowest — they were sent straight into the machinery with less protection than ever. The extraction was brutal and targeted and revealed exactly whose labor was truly load-bearing and exactly how little that labor was valued.

But for a significant portion of the professional class — the office people, the Slack people, the all-hands people — there was a window. Long enough to remember what they were underneath the performance. Long enough that their children would remember them this way. Long enough to constitute a before and after.

And then it got clawed back.

Slowly. Carefully. The return to office mandates. The performance reviews that started measuring presence again. The subtle pressure, then the explicit pressure, then the ultimatums. The justifications — collaboration, culture, mentorship — that everyone knew were proxies for the thing that couldn't be said directly: we need you visible so we can extract from you, and we can't extract from you when you're at home being a person.

The system reasserted itself. Most people complied because the floor is temporary and the mortgage is permanent.

But they remembered. That's what the system couldn't undo. The memory of the gap. The knowledge, now embodied, that the performance is optional — that there exists a version of yourself that is realer than the one that shows up on Mondays, and that version is not less productive or less creative or less anything except less available for extraction.

You can't unknow that. The system can make you act as if you don't know it. It cannot make you not know it.

And that unspoken mass knowledge — millions of people who remember what they felt like without the mask, who are currently performing the mask while knowing it's a mask — is the most volatile thing in the current social order. The system knows it too. That's why the clawback was so aggressive. That's why flexibility became a culture war. That's why the office became political.

The ghost is no longer a rare condition. It's a memory. Widely distributed. Quietly held.

---

## A Personal Cartography

I have been in the gap five times in my life before now.

The first was b0bby's World. 1991 to 1994. Three phone lines in my parents' basement. I was a teenager who didn't know he was building anything — I was just making a place for people who loved the same music I loved.

I know where it came from, even if I couldn't have named it then. I was moving constantly when I was young — new schools, new towns, new social ecosystems to decode from scratch. By the time I settled into a cohort it was mid-year grade three, and I spent the rest of my school years in my head trying to figure out something that everyone else seemed to already know: why the cool kids were cool. How you got to be in the in-group. What the actual mechanism was. It was so foreign to me that this was even an organized system — that children had constructed a hierarchy with real rules and real consequences and nobody had written them down anywhere.

I never cracked it. And I never stopped thinking about it.

b0bby's World was, I'm almost certain now, my answer to that question. Not a deliberate one — I couldn't have articulated it at sixteen. But on a BBS, none of that machinery existed. You showed up as words on a screen. You were interesting or you weren't. You contributed or you didn't. The in-group and the out-group dissolved because the visual signals that maintained them — the right clothes, the right friends standing next to you in the right hallway — couldn't travel through a phone line.

And when someone was petty or aggressive or just wrong, the community piled on and explained why. Not viciously. Collectively. There was a kind of natural alignment — people who'd found each other through genuine shared interest had no patience for the performance of dominance. They just said so. And the person usually got it.

I was the sysop. I walked through it awkwardly, made my share of missteps, learned things about people and systems and my own instincts the hard way. But I loved it completely. It was the first place I'd been where the social architecture made sense to me.

And what emerged, without design, was community without extraction. Real people finding each other around genuine shared passion. My sister meeting the man she's still with thirty years later. International friendships that persist. A web of human connection that grew from nothing but care about a thing.

I didn't know what I had until it was gone. The web came and it looked like more — more people, more reach, more everything. And every metric said it was better. And every metric was measuring the wrong thing.

The second time was Organic. 1999 to 2003. Interactive advertising, which in that moment was young enough that nobody had written the rules yet. Chris, the person who hired me, didn't so much give advice as be it. He was just himself — openly, naturally, without performance. When something was weighing on him he'd say so. When he was anxious he'd name it. He wasn't flippant about it. He was just unmasked, in a way that felt so effortless it was almost aspirational. And it made everyone around him feel safe to be normal and weird in equal measure.

I didn't have to wear the mask at Organic. Not because it was utopian or because the work wasn't real — it was — but because the industry was still in the gap between what it had been and what it was about to become. Before the optimization. Before the metrics. Before the choreography got installed. We were figuring it out together and the figuring-out created permission to be actual humans about it.

Twenty-five years later that crew is still in a chat group together. No other job produced that. I've thought about why and I keep coming back to the same answer: we were in the same room without the mask on. That's the whole explanation. That's all it takes.

The third time was 2004. I left right as things at Organic were starting to calcify — I don't think that timing was accidental. I sold my condo and traveled for ten months with my first wife Katherine. Months of being nobody in particular in places where nobody knew me. No title. No org chart. No performance review. No choreography to run. Just: here is a human, moving through the world, noticing things, being changed by them.

I became someone different in that year. Not a better or worse someone. A truer one. The mask I'd been building since I entered the working world — the one that had been growing on me so gradually I'd stopped noticing the weight — I left most of it in whatever airport or hostel or market or mountain I was standing in when it finally fell off.

I came back and the system put it back on me. Of course it did. That's what systems do. But I remembered.

The fourth time was a basement in January 2021. Rich and Julie gave me the space — a real gift, the kind that changes the shape of your days. I decided I was going to give my lights a proper go. Three years of focused attention, whatever spare time I could carve out. I'm still in there now.

I wanted it to be a community space. And it is, in a way — just not the way I imagined. My community is captured. People have genuine warmth and genuine intention, but after the job and the commute and the family and the recovery from all of that, there's a thin margin left. Fleeting energy. Sporadic presence. The ones who show up consistently are the people the system has loosened its grip on — the unemployed, the underemployed, people between things. People with enough slack in the line to actually be somewhere on a Tuesday afternoon.

I'm not bitter about it. It taught me something. The basement was supposed to be the exception. It turned out to be the proof.

The fifth time was South Africa. George, Johannesburg, Cape Town, AfrikaBurn. Two months away. I was watching a dev team work with tools that dissolved the bottleneck I'd been living around my entire career — Cursor, Warp, AI-assisted development as a native mode rather than an afterthought. The particular constraint my brain had always bumped against — the inability to onboard myself to new stacks without someone to bridge me in — I could feel it dissolving as I watched. The AI could walk me through the first steps. And everything else was pattern recognition, which is what I'd been doing since I was copying programs out of Compute! magazine on an Atari in my parents' basement.

I didn't touch the bridge problem the whole time I was away. Came home on a Sunday. Had it cracked by Thursday.

They let me go on the Monday the site launched.

I've been in the gap ever since. This time I'm not coming back.

---

I know what it looks like without the mask. I've seen it.

My sister met her husband on b0bby's World. They were fifteen. They have two adult children now. Still together.

That's what humans do when the machine isn't feeding on them. They find each other. They make things together. They form bonds that last decades. They don't need to be incentivized toward connection — connection is what they do by default when you stop interrupting it.

The mask isn't human nature. The mask is what human nature does when you put money between people and what they need.

Remove the extraction layer — not the exchange of value, but the rent-seeking middleman who inserts himself between every transaction — and something remarkable happens. People become themselves again. Slower. More intentional. More real.

I know this because I lived it. I've spent thirty years watching the industry optimize it away.

---

## The Architecture of After

We're building imajin because the problem was never the people.

The people in the hallway aren't repulsive. They're trapped in architecture that makes authenticity economically irrational. The influencer on the grid isn't shallow — she's responding correctly to a system that rewards performance over presence. The VP hoarding information isn't uniquely territorial — he's protecting the only leverage the org chart gave him.

Change the architecture and you change the behavior. Not by asking people to be better. By building plumbing that makes extraction impossible and makes genuine exchange the path of least resistance.

Sovereign identity. Direct payments. Trust graphs built from real relationships instead of engineered by algorithms. Your presence serving you instead of a shareholder.

The mask becomes unnecessary when the system stops requiring it. When the value you create flows back to you directly. When the person who holds the pattern library owns it. When you don't have to perform enthusiasm for an audience of one VP to keep the salary that keeps the mortgage.

This is what the BBS was, accidentally. What the internet could have been, deliberately. What we're building now, because the tools finally exist and the exhaustion is finally visible and enough people remember — or are beginning to understand — what it felt like before the machine got its hooks in.

The joke they'll make when Jin throws the party on April 1st is the same joke they always make. This is naive. This won't scale. You can't fight the feed with plumbing.

They're right that it won't look like a fight.

The feed won because it was the only architecture available. When there's a different architecture — one that pays you instead of extracting from you, that deepens connection instead of harvesting attention, that makes the mask unnecessary instead of mandatory — the feed loses not because it gets defeated but because it becomes obviously, visibly, undeniably the worse option.

We're not rising up against the machine.

We're building the town square it was always supposed to be.

Come take the mask off.

*— Ryan VETEZE, Founder, imajin.ai aka b0b*

---

**If you want to follow along:**
- The code: [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
- The network: [imajin.ai](imajin.ai)
- Jin's party: April 1st, 2026
- The history of this document: [github.com/ima-jin/imajin-ai/commits/main/articles/essay-03-the-mask-we-all-wear.md](https://github.com/ima-jin/imajin-ai/commits/main/articles/essay-03-the-mask-we-all-wear.md)

This article was originally published on imajin.ai (https://www.imajin.ai/articles/essay-03-the-mask-we-all-wear) on February 21, 2026. Imajin is building sovereign technology infrastructure — identity, payments, and presence without platform lock-in. Learn more → (https://www.imajin.ai/)
