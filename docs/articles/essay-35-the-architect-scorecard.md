---
title: The Architect Scorecard
type: essay
status: draft
author: Ryan Veteze
slug: essay-35-the-architect-scorecard
topics:
  - governance
subtitle: Measuring what matters when humans stop writing code
description: >-
  COCOMO measured person-months per thousand lines. That metric is dead. The new
  question: how good are you at directing machines? The answer is measurable,
  and almost nobody is measuring it.
---
## The Old Metric Is Dead

COCOMO — Constructive Cost Model — was published in 1981. It estimates how many person-months a software project will take based on lines of code. Forty-five years of the industry running on one basic question: how many humans, for how many months, to produce how much code?

We shipped 8 pull requests today. 3,000+ lines across 15 services. New subsystem. Schema, API, UI, middleware, onboarding flow. One person. One afternoon. Seven agent runs, average four minutes each.

COCOMO says that's six person-weeks of work.

The model isn't wrong. It was never wrong. The thing it measures just doesn't exist anymore.

---

## What Changed

The bottleneck moved.

It used to be: how fast can your developers type? How many bugs do they introduce per thousand lines? How much rework happens in code review? The craft was writing code. The skill was writing it well. The metric was output per developer per month.

Now the craft is direction. The skill is knowing what to build, what to skip, and how to describe the difference to a machine that builds at 100x your typing speed but has zero judgment about what matters.

The code writes itself. The architecture doesn't.

---

## The Eight PRs

Here's what actually happened on April 5th, 2026.

Started the day fixing a Sonar gate failure on a landing page PR. Merge conflict, dead conditional, array index keys. Twenty minutes.

Then: someone's getting a server error in production. Found it — a variable referenced before declaration, only triggers for authenticated users. The minified bundle turns it into a temporal dead zone error. Anonymous users never hit the code path. My test was anonymous. Missed it.

Root cause identified, fixed, deployed, confirmed in twelve minutes.

Then the real work started.

We needed group identities — multi-controller DIDs for communities, organizations, families. The issue existed. The spec existed. What didn't exist: a judgment call about what goes in auth versus profile. What the agent should build versus what it should skip. How the controller hierarchy works. Whether handles share a namespace.

Each of those decisions took me thirty seconds. Each one would have sent the agent in the wrong direction for an hour if I'd gotten it wrong.

I made the decisions. The agent wrote the code. Seven times. Schema, API, UI, middleware, configuration, settings page, onboarding flow. Each time: one prompt, one correct output, one review, one merge.

The agent's error rate: one wrong import path. Caught by CI. Fixed in forty-five seconds.

My error rate: one schema placed in the wrong service. Caught by my own question. Moved before merge.

---

## What the Scorecard Measures

Five dimensions. All observable. All retroactive.

**Alignment precision.** How often does the agent produce what you actually needed on the first pass? Not what the ticket said — what the system needed. This is the core skill. It's the distance between your prompt and the correct output. Ours was 7/7 today with one import fix. Most people I've talked to are at 2/7 with full rewrites.

**Scope accuracy.** Did you build the right thing? We had a 200-line issue for contextual onboarding that specified NFC card flows, federated chain presentation, a new identity package, and four new API endpoints. The user needed a link. One question — "what does Borzoo actually need?" — eliminated 80% of the spec. Scope accuracy isn't about building more. It's about building less.

**Architectural interventions per hour.** The decisions only a human makes. Today: forest_config belongs in profile not auth. Handles share one namespace. The onboard verify flow should add forest members directly instead of calling another service. Each of these is a two-second decision that the agent has no framework to make alone.

**Velocity multiplier.** Output relative to a solo developer writing by hand. Today was roughly 30x. Six weeks of work in an afternoon. This number varies wildly between people. Some architects are 50x. Some are 0.5x because they fight the tool and rewrite every output.

**Drag coefficient.** What's slowing you down that you're not fixing? We have 1,400 Sonar issues. 38 empty catch blocks. Missing test coverage. Every one of these is friction on the 30x multiplier. Clean it up and the multiplier goes higher. Ignore it and it compounds.

---

## What It Doesn't Measure

Lines of code. Nobody cares. A hundred-line architectural insight is worth more than a ten-thousand-line feature if it prevents six months of rework.

Hours worked. Nobody cares. The afternoon that produced eight PRs was more valuable than the weeks I've spent debugging CI configurations.

Commits per day. Nobody cares. One good commit that reshapes the data model beats fifty that add boilerplate.

The old metrics measured hands. The new ones measure eyes. How clearly do you see the system? How precisely can you describe what it needs? How fast do you know when something is wrong?

---

## The Curve

Here's what you'd see if you scored me retroactively from day one.

Day one: learning the tools. Prompt too vague. Agent builds the wrong thing. Rewrite everything. Score: maybe 3.

Day thirty: getting faster. Prompts are tighter. Still over-specifying sometimes — giving the agent too much context when it needs less. Still under-specifying the architectural constraints. Score: maybe 15.

Day sixty-four: one prompt, one output, one merge. Decisions in seconds. Scope kills in real-time. The agent is an extension of the architecture in my head. Score: 30+.

That curve is a skill. It's learnable. It's measurable. And almost nobody is measuring it.

---

## Why This Matters

Every company is about to go through this transition. Some already are. The developers who survive aren't the ones who code fastest. They're the ones who see clearest.

A team of forty developers writing code by hand will be outshipped by a team of three architects directing agents. Not because the agents are magic. Because the architects don't waste motion. Every prompt is a decision. Every decision is informed by decades of pattern recognition. The agents do the typing. The humans do the seeing.

The companies that figure this out first will have a structural advantage that compounds. Their architects get better at directing. Their agents get better at executing. The feedback loop accelerates. The ones who don't figure it out will be writing code by hand in 2028 and wondering why they can't keep up.

---

## Measuring It

The data already exists. Git logs. PR timelines. CI results. Sonar snapshots. Agent token usage. Context window efficiency.

You could build a dashboard today that scores architect efficiency across every dimension. Issues closed per session weighted by complexity. Rework rate. First-pass success. Scope reduction. Debt trajectory.

Normalize by team size. A solo architect at 30x is a different thing than a forty-person team at 30x. The per-capita output is what matters.

Run it retroactively. Watch the curve. See who's getting better and who's plateauing. Route the right problems to the right architects based on demonstrated strengths. Some people are great at decomposition. Some are great at debugging. Some are great at greenfield architecture. Score them all differently. Play to strengths.

Eventually: train a model on the data. "Given this architect's profile and this issue description, predict time to completion, rework likelihood, quality score." That's not a dashboard anymore. That's an allocation engine. The right problems finding the right minds automatically.

---

## The Superpower

People ask what the skill is. They think it's prompting. It's not.

The skill is looking at a system — the whole system, all fifteen services, the data model, the identity layer, the federation protocol, the economic model, the user sitting in a venue in Toronto who just wants to sell tickets — and knowing what to cut.

Not what to build. What to cut.

The 200-line contextual onboarding spec became a link. The forest config debate became one question. The Sonar duplication gate became a merge.

Thirty years of building systems teaches you one thing: most of the work people do is unnecessary. The architecture is the art of knowing which 20% matters.

The agents build the 20%. The architect finds it.

---

*The COCOMO model assumed humans write code. The new model assumes humans see systems. The metric changes, but the principle doesn't: measure what matters, ignore what doesn't.*

*The agents type. The architects see. The scorecard measures the seeing.*

🟠

*— Ryan VETEZE, Founder, imajin.ai aka b0b*

---

**If you want to follow along:**
- The code: [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
- The network: [imajin.ai](https://imajin.ai)
- The support page: [coffee.imajin.ai/veteze](https://coffee.imajin.ai/veteze)
