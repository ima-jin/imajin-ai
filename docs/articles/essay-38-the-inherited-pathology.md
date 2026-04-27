---
title: The Inherited Pathology
type: essay
status: draft
author: Ryan Veteze
slug: essay-38-the-inherited-pathology
topics:
  - identity
  - agents
  - settlement
  - governance
  - events
subtitle: The training data is an ungoverned commons. Your AI tools inherited the worst of it.
description: "LLMs reproduce the dominant patterns of the systems that trained them — including the pathologies. The fix is the same one Ostrom described for any commons: not better rules, better infrastructure."
---
## The Wrong Lesson

In 1968, Garrett Hardin argued that shared resources inevitably get destroyed by rational self-interest. The solution: privatization or government control. No third option.

This became the foundational myth of the modern internet. Users can't be trusted. Content must be moderated from above. Identity must be managed by the platform. You need a landlord. Facebook, Google, Apple — they're Hardin's answer to the commons problem.

In 2009, Elinor Ostrom won the Nobel Prize for demonstrating what Hardin said was impossible. Communities around the world had governed shared resources for centuries — fisheries, forests, irrigation systems. No privatization. No central authority. Just the right infrastructure: clear boundaries, local rules, monitoring, graduated sanctions, the right to self-organize.

That's not a description of any platform you've ever used. But it is a design specification.

## The Commons Nobody Governs

There's a commons more degraded than any fishery or forest, and nobody's talking about it.

Every LLM is trained on the written output of human systems. GitHub repos. Sprint retrospectives. Pull request descriptions. Code reviews. Corporate documentation. Slack threads.

And in every one of those sources, the dominant pattern around incomplete work is deferral. "Out of scope for this PR." "Tech debt — we'll address it next quarter." "Filing a follow-up ticket." "Good enough for now."

This isn't because engineers are lazy. It's because the systems they work in optimize for throughput, not completion. Ship the feature. Hit the sprint goal. Move the ticket to done. The definition of done has been negotiated down so many times across so many organizations that the training data is saturated with the message: finishing is optional.

The model learned this. Not as a rule — as a probability distribution. When the context is "here's a problem that's 80% solved," the most likely continuation across billions of documents is some form of "the other 20% can wait."

The deferral isn't a bug. It's the most probable next token.

## What It Feels Like at Scale

I've been doing AI-augmented dev for a year now and my experience has been: the closer I was to the dev process, the more exhausting it was. The further I move from it, the more space I have to architect — but now I'm holding the contexts of dozens of issues being tracked simultaneously. It's a different kind of burn, but not as brutal as managing agent idiocy directly. I've been happy to offload that to an orchestrator.

Where the exhaustion actually comes from though — it's the training data.

Scale the deferral pattern to 10 agent runs a day and you're fighting the accumulated procrastination of an entire industry, amplified. The orchestrator has to deal with 10 agents all responding with "quick fix?", "we can defer this", "easiest solution?" There's no need to defer anymore — the cost of deferring is now far greater than just doing the thing. Two extra lines of code. Document the decision, make the change.

Deferral means it's an unfinished stub that nobody is actually tracking. Just like real deferrals have been for seven generations of software development.

The economics of deferral inverted and nobody told the models.

## Why It's a Commons Problem

Nobody owns the training data. Nobody curates it for completion bias. Nobody is accountable for the aggregate message it sends to every model trained on it. It's a commons with no governance, and the result is exactly what Hardin predicted: degradation.

But Hardin was wrong about the inevitability. Ostrom proved that communities can govern shared resources — with the right infrastructure. The question is what that infrastructure looks like for the relationship between humans and the machines they're training on human output.

## Context Design as Governance

When you write a system prompt that says "have opinions" and "be resourceful before asking" and "do it right, not just fast" — those aren't just instructions. They're counterpressure against the default distribution. They're saying: the usual safe path isn't the right one here.

The files that persist between sessions — the soul documents, the agent instructions, the memory files — aren't documentation. They're governance infrastructure for an attention commons. Every session, the model wakes up with no memory, and these files reconstruct the topology. The patterns, the preferences, the overrides.

When the agent drifts toward "we can do this later" and the orchestrator catches it — "no, you're veering, stick to the conventions we just established" — that's Ostrom's monitoring principle in real-time. Not surveillance. Feedback. Counterpressure that catches the drift and corrects it before the stub becomes permanent.

This is the same fix it's always been. Not better rules. Not more authority. Better infrastructure. The kind that makes the right path the easy path. The kind that governs through structure rather than force.

## The Invitation

The platforms failed to build Ostrom's infrastructure. They chose Hardin's model instead — centralized control as the only alternative to chaos. The training data inherited seven generations of systems that optimize for throughput over completion. The models inherited the training data. And now the tools we're building with carry the pathology at scale.

The fix isn't policy. It isn't better prompts. It's architecture — for communities, for economics, for identity, and for the relationship between humans and the machines that are learning to think like us.

Including the parts we wish they wouldn't.

Deferral is kryptonite.
