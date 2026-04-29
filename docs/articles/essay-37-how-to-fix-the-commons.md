---
title: How to Fix the Commons
type: essay
status: draft
author: Ryan Veteze
slug: essay-37-how-to-fix-the-commons
topics:
  - governance
  - legibility
subtitle: Hardin was wrong. Ostrom was right. Now there's an implementation.
description: >-
  The tragedy of the commons was never a tragedy of human nature — it was a
  tragedy of missing infrastructure. Elinor Ostrom proved communities can govern
  shared resources. The internet proved they can't do it on platforms owned by
  someone else. The fix isn't policy. It's architecture.
---
## The Wrong Lesson

In 1968, Garrett Hardin published "The Tragedy of the Commons." His argument: shared resources inevitably get destroyed because individuals acting in rational self-interest will consume more than their share. The solution, he claimed, was either privatization or government control. There was no third option.

This became the foundational myth of the modern internet.

Every platform you use is built on Hardin's assumption. Users can't be trusted. Content must be moderated from above. Identity must be managed by the platform. Data must be owned by someone with the resources to protect it. The conclusion: you need a landlord. Facebook, Google, Apple, Amazon — they're not just businesses. They're Hardin's answer to the commons problem. Centralized control as the only alternative to chaos.

There was always a third option. Hardin just didn't look for it.

## The Right Lesson

In 2009, Elinor Ostrom won the Nobel Prize in Economics for demonstrating what Hardin said was impossible. She studied communities around the world that had successfully governed shared resources for centuries — fisheries, forests, irrigation systems, grazing lands. No privatization. No government control. Just communities with the right infrastructure.

She identified eight design principles that made it work:

1. **Clear boundaries.** Who's in, who's out. Not exclusion — definition.
2. **Rules matched to local conditions.** No one-size-fits-all governance.
3. **Collective choice.** The people affected by the rules participate in making them.
4. **Monitoring.** Not surveillance — transparency. People can see what's happening.
5. **Graduated sanctions.** Not ban hammers. Proportional consequences.
6. **Conflict resolution.** Cheap, accessible, local.
7. **Minimal external interference.** The community's right to self-organize is respected.
8. **Nested enterprises.** Small groups compose into larger ones. Governance at every scale.

Read that list again. It's not a description of any platform you've ever used. Facebook doesn't have clear boundaries — it has 3 billion users in one undifferentiated pool. Twitter doesn't match rules to local conditions — it has one global content policy. Apple doesn't allow collective choice — it decides what apps you're allowed to install on hardware you paid for.

But it *is* a description of something. It's a design specification. And for the first time in the history of the internet, someone built it.

## Why the Internet Failed the Commons

The early internet was a commons. Open protocols. Shared infrastructure. Anyone could run a server, publish a page, send an email. No landlord.

Then the platforms arrived.

The platforms solved a real problem: coordination at scale. Email was open but spam-ridden. The web was decentralized but hard to navigate. Identity was nonexistent. Payments were impossible without intermediaries. The platforms gave people what open protocols couldn't — a usable experience with built-in identity, discovery, and trust.

The cost was everything else.

To use the platform, you surrender your data. Your identity belongs to them. Your content belongs to them. Your relationships belong to them. Your audience belongs to them. And they can revoke access to all of it at any time for any reason. You don't govern the commons. You rent a stall in someone else's market.

The open source movement tried to fix this with better software. Mastodon, Matrix, Diaspora. They proved you could build the technology. They also proved that technology alone isn't enough. What was missing wasn't code. What was missing was Ostrom's infrastructure — the governance layer that lets communities actually manage shared resources without a central authority.

## What the Fix Looks Like

The fix isn't a better platform. It's not a decentralized platform. It's not even a protocol, exactly. It's the infrastructure that makes Ostrom's principles implementable at internet scale.

Here's what that requires:

**Identity you own.** Not an account on someone's server. A cryptographic keypair that you control. Your identity follows you across services, communities, and devices. Nobody can revoke it because nobody issued it.

**Boundaries you define.** Communities — what we call forests — have their own identity, their own configuration, their own rules. A community for a neighborhood co-op operates differently from a community for a music festival. The infrastructure supports both without forcing either into the other's model.

**Transparent history.** Every interaction is recorded in a signed, append-only chain. Not surveillance — receipts. You can verify what happened without trusting anyone's database. Ostrom's monitoring principle, implemented as cryptography.

**Graduated trust.** Not binary in/out. Progressive trust built from attestation diversity, age, and volume. A new participant isn't banned — they just haven't earned standing yet. Standing isn't granted by an admin. It emerges from the pattern of participation. Ostrom's graduated sanctions, implemented as a trust graph.

**Governance at every scale.** A person has sovereignty over their identity. A family has sovereignty over its shared resources. A community has sovereignty over its rules. A network has sovereignty over its protocol. Each layer composes into the next. Ostrom's nested enterprises, implemented as scoped identities.

**Settlement that isn't extraction.** When value moves through the system, the protocol takes 2%. Not 30%. Not "whatever we decide this quarter." A fixed, transparent fee that funds the infrastructure. Ostrom's collective choice principle applied to economics — the community decides the cost of the commons.

**Exit rights.** You can leave. Your identity comes with you. Your data comes with you. Your history comes with you. The right to leave is the right that makes every other right meaningful. Without it, governance is just control with better branding.

## The Implementation

This isn't theory. This is running software.

The system is called Imajin. The identity layer runs on DFOS — a federated protocol where every identity has a signed chain that anyone can verify. The governance layer uses typed actors, bilateral attestations, and gas metering. The economic layer settles through a protocol fee that funds infrastructure, not shareholders.

As of today, there are 135 identities on the network. Events have been hosted. Payments have been settled. Content has been attributed. Communities have been formed. All of it built on the infrastructure described above.

Is it done? No. Is it enough to prove the architecture works? Yes.

## Why Policy Isn't Enough

The Center for Humane Technology published a roadmap for ensuring AI serves humanity. Seven principles. Build safely. Duty of care. Center human well-being. Protect work and dignity. Preserve rights and freedom. International limits. Balance power.

They're right about all of it. And they're approaching it from the wrong direction.

Policy asks powerful institutions to limit their own power. It asks platforms to stop extracting data. It asks AI companies to prioritize safety over speed. It asks governments to regulate industries that fund their campaigns.

Sometimes policy works. Seatbelts work. Environmental regulations work. Child labor laws work. But they work because the physical world has enforcement mechanisms. You can inspect a factory. You can crash-test a car. You can count the children in a mine.

The digital world doesn't have those mechanisms. A platform can claim it protects your data while its architecture is designed to extract it. An AI company can publish safety research while racing to deploy systems they don't understand. The gap between what policy requires and what architecture enables is where all the harm lives.

The fix isn't to make extraction illegal. It's to make extraction impossible. Not through regulation — through structure.

You can't extract data you don't hold. You can't lock in users who own their keys. You can't concentrate power when anyone can run a node. You can't automate away human dignity when every contribution is attributed and every interaction is recorded. You can't surveil people whose identity is cryptographic and whose communications are end-to-end encrypted.

Architecture is governance that doesn't require trust.

## The Invitation

Ostrom spent her career proving that communities can govern shared resources. The internet spent two decades proving they can't do it on rented infrastructure. The fix is obvious in retrospect: build the infrastructure that makes self-governance possible. Not as theory. As running code.

The commons isn't tragic. It was never tragic. It was just missing the right tools.

Now it has them.
