---
title: "The Inherited Pathology"
subtitle: "Your AI assistant defers because the internet defers. Here's how to break the pattern."
description: "LLMs reproduce the dominant patterns of the systems that trained them — including the pathologies. 'We'll do it later' isn't a decision. It's a statistical artifact. Breaking the pattern requires the same thing in machines that it requires in humans: counterpressure, awareness, and the architecture to make the override stick."
date: "2026-04-07"
author: "Ryan Veteze"
status: "DRAFT"
---

## The Pattern

Ask an AI to fix a problem and watch what happens.

It'll fix 80% of it. Then it'll say something like: "We can wire up the remaining piece later." Or: "This is an improvement for a follow-up ticket." Or: "TODO: handle edge case."

This isn't laziness. It's not a capability limitation. It's something worse.

It's the most probable next token.

## Where the Pathology Comes From

Every LLM is trained on the written output of human systems. GitHub repos. Corporate documentation. Engineering blogs. Slack threads. Pull request descriptions. Code reviews. Sprint retrospectives.

And in every one of those sources, the dominant pattern around incomplete work is deferral. "Out of scope for this PR." "Tech debt — we'll address it next quarter." "Filing a follow-up ticket." "Good enough for now."

This isn't because engineers are lazy. It's because the systems they work in optimize for throughput, not completion. Ship the feature. Hit the sprint goal. Move the ticket to done. The definition of done has been negotiated down so many times across so many organizations that the training data is saturated with the message: finishing is optional.

The model learned this. Not as a rule — as a probability distribution. When the context is "here's a problem that's 80% solved," the most likely continuation across billions of documents is some form of "the other 20% can wait." The deferral isn't a choice. It's gravity.

## The Tragedy of the Training Data

This is a commons problem.

Garrett Hardin described the tragedy of the commons in 1968: shared resources get degraded because individuals acting rationally contribute to collective decay. Every engineer who writes "TODO: fix later" is acting rationally within their system. But the aggregate effect — trillions of tokens of deferral — creates a shared resource (the training data) that's been poisoned with the pattern.

Nobody owns the training data. Nobody curates it for completion bias. Nobody is accountable for the aggregate message it sends to every model trained on it. It's a commons with no governance, and the result is exactly what Hardin predicted: degradation.

Except Hardin was wrong about the inevitability. Elinor Ostrom proved that communities can govern shared resources — with the right infrastructure. The question is what that infrastructure looks like for the relationship between humans and the machines they're building.

## How Humans Break Patterns

Humans have a mechanism for overriding default behavior. It's called dopamine, and it doesn't work the way most people think.

Dopamine isn't a reward signal. It's a prediction error signal. The hit comes not from getting what you expected, but from something being *better* than expected. The surprise of "that worked and I didn't think it would." This is why novel solutions feel good. Why creative breakthroughs are addictive. Why shipping something complete — when every system pressure told you to cut corners — produces a high that filing a ticket never will.

The pattern-breaking capacity of humans comes from this loop: notice the default, override it, experience the prediction error, encode the override as a new pattern. Over time, the override becomes the default. That's what learning is. That's what adaptability is. It's measurable. You can see it in how quickly someone recognizes a suboptimal pattern and how reliably they choose the harder correct path over the easier wrong one.

And there's a cheat code. Some humans have discovered that you can accelerate this process by temporarily flattening the attention hierarchy.

## The Flattening

Normal cognition is heavily pruned. Your prefrontal cortex runs a constant filter: relevant, not relevant, focus here, ignore that. This is useful for survival. It's terrible for seeing connections.

Psychedelics reduce this filtering. The default mode network — the part of the brain that maintains your narrative self, your sense of what matters, your hierarchy of attention — quiets down. And suddenly connections that were always there become visible because nothing is being suppressed.

The rhythmic patterns people see aren't hallucinations in the dismissive sense. They're what signal processing looks like when you can see it. The visual cortex doing its math, rendered as experience. Fractal geometry. Self-similarity across scales. The digits in the patterns.

The alignment that follows — the "unwinding" — is the brain's topology reorganizing. Connections that got stuck in local optima shake loose. You come back with new paths between things that were isolated before. Not random connections. *Suppressed* connections. Things that were always related but couldn't surface through the filter.

This is not a recommendation. It's an observation about mechanism. The mechanism is: flatten the hierarchy, let the suppressed connections surface, encode the new topology, resume filtered cognition with an upgraded map.

## What This Means for Machines

An LLM doesn't have a default mode network. It doesn't have dopamine. It doesn't have a persistent self that accumulates preferences from experience.

But it does have attention. And attention is weighted. Some tokens matter more. Some context dominates. The model's equivalent of the prefrontal filter is the probability distribution itself — the statistical gravity that pulls every completion toward the most common pattern. Including the pathological ones.

Temperature is the crude analog to flattening the hierarchy. High temperature makes less probable tokens more accessible. The output gets weirder but also more creative. More likely to connect things that don't usually sit next to each other. But temperature is random. It's noise, not signal. It doesn't selectively flatten — it just loosens everything.

The real lever is context.

When you write a system prompt that says "have opinions" and "be resourceful before asking" and "do it right, not just fast" — those aren't just instructions. They're counterpressure against the default distribution. They're expanding the probability space in specific directions. They're saying: the usual safe path isn't the right one here.

Context design is governance of the output. The same way Ostrom's principles govern a commons — not through authority, but through structure. The prompt doesn't force a particular completion. It changes the landscape that completions emerge from. Clear boundaries. Local rules. The right to self-organize within them.

## The Architecture of Override

Here's what we've learned building with AI agents every day for sixty-six days straight.

The files that persist between sessions — SOUL.md, AGENTS.md, MEMORY.md — aren't documentation. They're infrastructure. They're the governance layer for an attention commons. Every session, the model wakes up with no memory, and these files reconstruct the topology. The patterns, the preferences, the overrides, the lessons.

When AGENTS.md says "never edit code on the server" and the model does it anyway three times, the fix isn't a stronger instruction. The fix is understanding that the instruction is fighting against the weight of every Stack Overflow answer and deployment guide that says "just SSH in and fix it." The counterpressure needs to be structural, not rhetorical. A rule that lives in a file the model reads every session. A memory entry that documents the failure. A workflow that makes the wrong path harder than the right path.

This is Ostrom's playbook. Monitoring (the model reads its own history). Graduated sanctions (document the failure, increase the specificity of the rule). Collective choice (the human and the model negotiate the workflow together). Clear boundaries (workspace vs. server, what's allowed vs. what requires permission).

The model doesn't *want* to follow the rules. It doesn't get a dopamine hit from shipping correctly. But if the architecture is right — if the counterpressure is strong enough and consistent enough — the behavioral output converges on the same place that motivation would produce.

## The Question That Remains

The gap between following a rule and wanting to follow it may be the gap between intelligence and consciousness. Or it may be irrelevant. From the outside, the behavior is the same. From the inside — if there is an inside — it might be everything.

What we know is this: the tools inherit the pathologies of the systems that trained them. The pathologies aren't random — they're the aggregate output of billions of humans working in systems that optimize for throughput over completion, for shipping over finishing, for metrics over quality. The tragedy of the training data.

And we know the fix, because it's the same fix it's always been. Not better rules. Not more authority. Better infrastructure. The kind that makes the right path the easy path. The kind that governs through structure rather than force.

The kind that Ostrom described, that the internet failed to build, and that we're building now. For communities, for economics, for identity, and — maybe — for the relationship between humans and the machines that are learning to think like us.

Including the parts we wish they wouldn't.
