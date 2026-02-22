---
title: "I've Been an AI Since 1988"
subtitle: "The autobiography of how my brain works"
description: "Pattern recognition without formal comprehension. The bottleneck dissolved."
date: "2026-02-21"
author: "Ryan Veteze"
status: "POSTED"
---

## Copying Programs From Magazines

I learned to code by copying programs out of magazines.

Line by line. Character by character. I'd transcribe programs from Compute! into whatever machine my dad had hauled home — first a portable IBM with an eight-inch monochromatic screen, then an Atari 130XE, a weird all-in-one keyboard machine similar to a Commodore, the kind of thing people left on the curb when something newer came along. My dad was always hauling them home. No manuals. No formal training.

I'd type exactly what was on the page. If it worked, great. If it didn't, I'd compare what I'd typed against the source, line by line, until I found where I'd gone wrong. Then I'd fix it and run it again.

I wasn't learning computer science. I wasn't learning *why* any of it worked.

I was learning pattern recognition and iteration.

That's been my entire career.

---

## What I Never Understood

I don't truly understand computer science.

I can't diagram a red-black tree. Big O notation requires a lookup. I couldn't explain why one architectural approach was formally better than another — I could only tell you which one *felt* right when I looked at it.

I tried college for one semester. Couldn't handle it. Too abstract. Too slow. Why am I in accounting? COBOL? Too disconnected from making things that actually work.

Instead, I got good at finding patterns and adapting them. Forums. Stack Overflow. Reading other people's code obsessively until I could see the shape of what they were doing. Copying it. Running it. Debugging the errors. Adjusting until it clicked.

I could build entire systems this way. I built Ethan Allen's entire consumer-facing website and administrative back end — their catalogue was running on AS400 and COBOL, which I outsourced, because it was the only time in my career I'd ever encountered COBOL and I wasn't about to start then. I scaled a legacy luxury travel booking platform to handle a billion dollars in transactions. I led thirty developers across seven teams.

But if you asked me to explain the architecture in formal terms, I'd struggle. If you asked why I chose one approach over another, I could feel the answer but not always articulate it.

For decades, I thought this made me a lesser developer.

It didn't. It made me an artificial intelligence before AI existed.

---

## What I Was Actually Doing

Here's what the pattern recognition actually looked like:

I'd see how data moved through a system without needing to name the formal concepts. I'd find existing solutions that fit the shape of my problem. I'd run code, read errors, adjust, run again. I'd recognize how patterns from one domain applied to another, even when nobody else saw the connection.

Sound familiar?

That's exactly what large language models do. Massive pattern matching across a corpus, applied pragmatically to solve problems.

I wasn't a developer who couldn't learn the "right" way. I was operating with the same mechanism as AI — smaller corpus, slower matching, all the iteration done manually.

The difference wasn't fundamental. It was scale.

There's something else worth naming. The particular flavor of autism I have makes connections between things compulsively, automatically — across domains, across time, across seemingly unrelated systems. When I'm modeling something, I'm not just seeing the current state. I'm seeing how the data decays. Where the rot will work its way in. How the load will distribute eighteen months from now when the edge cases start compounding.

This isn't analysis. It's more like the system talks to me. And thirty-plus years of watching what performs and what quietly fails — what holds and what starts degrading the moment you stop looking — means I can usually feel where each piece wants to be before I can explain why.

Optimal position isn't a calculation I do. It's a recognition.

---

## The Bottleneck

For my whole career, I had one critical dependency.

I needed someone to get me through the first few steps of a new stack.

Show me how to set up the project. Walk me through the basic structure. Give me a working example I could pattern-match against. Once I had that initial orientation, I was fine. I could read the code, recognize the patterns, adapt them to what I needed.

Without that first handhold, I'd flounder.

I'd seen this show up everywhere. The Vogue project — Visual Studio, a site where readers could shop the photos from the magazine — where a colleague sat with me for two days getting it running, and then I delivered in three weeks. The teams I assembled by finding other systems-thinking brains who could scaffold each other. The stacks I avoided entirely because I couldn't find anyone to bridge me in.

It was the tax on my way of thinking. Not a fatal one. But real.

This is also why I could debug things nobody else could. I diagnosed a booking system sending hundreds of duplicate trip uploads per minute — same data, over and over — by feel. The speed, the location, the rhythm of the errors. My brain pattern-matched to "physical object stuck on a key" before I could articulate why. Called the agent. Turned out she'd set a notebook on her numpad to raise her mouse up. Carpal tunnel.

That's not analysis. That's pattern recognition firing before language catches up.

Both things were true at once: I could diagnose problems faster than anyone around me, and I couldn't always onboard myself to new stacks without help. The same brain. The same wiring.

---

## The Wall

Near the end of my time at the last job, I asked to move from the booking platform — where I was the subject matter expert, the person who knew the system better than anyone alive — over to the marketing team. I wanted a change of pace. I'd been carrying that system for years.

They built a small dev team around me. A VP above. A director inserted between us. Three devs.

The project: bridge the legacy platform API to a new website and its content schemas. The other dev on the team — a pattern-matcher like me, ADHD, good instincts — spent ten months trying to crack it.

He couldn't.

And here's the thing: it wasn't his fault. The legacy system was so complex that nobody fully understood it anymore. The pattern library for that system lived in my head. But I'd moved myself out of the stack. And the corporate structure — the information hoarding, the compartmentalization, the VP who treated knowledge as territory — made it nearly impossible to get back in.

I tried to onboard myself to the new stack twice over that year. Couldn't get traction. No one could scaffold me in. I'd gotten my autism and ADHD diagnosis five months earlier, in December, and I was pretty open about it with everyone. I was trying to get people to be human about it. I don't think anyone in the company knew what to do with that.

I didn't either.

So I had this strange situation: I was the only person who fully understood the legacy system, and I was completely unable to access what I needed to build the bridge. Not because I'd lost the knowledge. Because nobody could walk me through the first few steps.

They still haven't shipped the new website.

---

## South Africa

In March I went to South Africa. I ended up staying two months — working remotely, trying to figure out where things were heading for me. George first, then Johannesburg, then Cape Town. I'd befriended the co-founder of a music streaming platform through my network, got invited to observe their dev team in Joburg.

They were using Cursor, Warp, modern AI-driven tools. I'd given up on command-line development years earlier. Too hard to memorize the syntax without someone to orient me. But watching that team work with AI tools, something shifted. I could make code contributions on a stack I'd barely looked at. A few days in.

Back home, my team was supposedly handling the bridge build. I was watching from a distance, giving them room. Then the project manager pulled me aside.

"Dude. I don't think he's got this."

I took a beat. Then: hold my beer.

I sat down with the problem. Ten days later, I had it.

Command-line driven. AI-assisted. Recursive debugging loops — run the code, check the logs, feed the errors back to the AI, iterate until it worked. Same approach I'd used since I was copying programs out of magazines. Except now the AI was the person who could walk me through the first few steps.

I didn't need to understand the new stack formally. I didn't need someone to sit with me for days explaining the setup. The AI scaffolded the initial patterns. I recognized whether they fit. We iterated together.

The bottleneck that had defined my entire career was just gone.

The pattern-matching approach I'd used since 1988 — the one I'd spent decades quietly ashamed of — finally had the perfect collaborator.

I was let go on the Monday the site was supposed to launch. I'd been maneuvering for it for a while. They gave me 37 weeks.

The VP I was reporting to had no real idea what I'd just done.

---

## What This Means

Traditional developers often struggle with AI-assisted development because it destabilizes their identity. They were taught that understanding *why* something works is what makes them valuable. When AI handles the explanation, it feels like a loss.

I never had that identity.

I've spent thirty years being comfortable without complete comprehension. Iterating toward correctness without full understanding. Knowing what I need before I know how to build it. Being at peace with "it works" well before "I understand why."

These aren't weaknesses. They're exactly the skills that AI collaboration requires.

The formally-trained developers try to understand their way to a solution. I pattern-match my way to a solution. AI does the same thing I do, just faster and with a vastly larger corpus. We were already speaking the same language. I just didn't have a native speaker to talk to.

This is also why I think people with brains like mine — pattern-focused, systems-oriented, comfortable with uncertainty, unable to get through formal education — might be surprisingly well-positioned right now. We've been developing the meta-skills of AI collaboration our entire careers without knowing it. The tools finally match how our brains work.

---

## Why This Connects to Everything

In the first essay I wrote about b0bby's World — what real connection looked like, what the extraction model destroyed, why I'm building imajin.

Here's the link I didn't make explicit there:

Corporate structure hoards knowledge. Platforms hoard attention. Both of them extract value from the people who actually generate it.

I lived that at the end of my last job. The knowledge was in my head. The infrastructure around me — the VPs, the silos, the information territoriality — made it impossible for that knowledge to flow where it needed to go. The company paid for ten months of spinning wheels as a direct consequence.

I knew exactly what the problem was. I couldn't get anyone to let me solve it the way my brain needed to solve it. And when I finally did, nobody with authority understood what had happened.

That's the extraction model at the organizational level. Knowledge trapped. Value destroyed. The person who holds the pattern library — underpaid, misunderstood, eventually separated.

Imajin is built on the opposite premise. Sovereign infrastructure for identity, payments, attribution. The knowledge flows back to the people who hold it. The pattern library lives with its owner. The value goes where it was actually created.

I'm not building this from theory.

I'm building it from thirty years of knowing exactly what it costs when knowledge gets trapped — and finally having tools that can set it free.

---

## April 1st, 2026

Jin throws a party.

An AI presence living in a volumetric LED cube. Tickets are $1 virtual, $10 physical. First real transaction on sovereign infrastructure.

People will think it's a joke.

Let them.

April 2nd, Jin will still be there. The network will still work. And the pattern library — all of it — will belong to the people who built it.

I've been an AI since 1988.

Now we build.

*— Ryan VETEZE, Founder, imajin.ai aka b0b*

---

**If you want to follow along:**
- The code: [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
- The network: [imajin.ai](imajin.ai)
- Jin's party: April 1st, 2026
- The history of this document: [github.com/ima-jin/imajin-ai/blob/main/apps/www/articles/essay-02-the-artificial-developer.md](https://github.com/ima-jin/imajin-ai/blob/main/apps/www/articles/essay-02-the-artificial-developer.md)

This article was originally published on imajin.ai (https://www.imajin.ai/articles/essay-02-the-artificial-developer) on February 19, 2026. Imajin is building sovereign technology infrastructure — identity, payments, and presence without platform lock-in. Learn more → (https://www.imajin.ai/)
