# The Developers Who Couldn't Explain

I've shipped systems that handled a billion dollars in transactions. I couldn't pass a whiteboard interview to save my life.

For 30 years I thought this made me a fraud. Turns out it might make me exactly what the AI era needs.

---

## The Confession

I never truly understood computer science.

I couldn't diagram a red-black tree. I couldn't explain Big O notation without looking it up. I couldn't tell you why one design pattern was formally better than another — I could only tell you which one *felt* right when I looked at it.

We were poor. My dad was always finding old computers that people couldn't get working anymore — hauling them home, passing them to me. I would boot them up, fiddle around, get them going. No manuals. No formal training. Just pattern recognition: try something, see what happens, adjust.

Sometimes I'd copy programs out of Compute! magazine into an Atari XT. Line by line. Not understanding what any of it did, just following the pattern on the page. When it didn't work, I'd compare my version to the source until I found where I'd gone wrong.

The neighbor kids had a Commodore 64. We'd write choose-your-own-adventure games together — not copying anything, just making it up as we went.

I wasn't learning theory. I was learning to make things work by feel.

That's been my entire career.

---

## What I Actually Do

I tried college for six months. Couldn't handle it. Too abstract. Why am I in accounting?! Too slow. COBOL fr?! Too disconnected from making things work.

Instead I got good at finding patterns and adapting them. Forums. Stack Overflow. Reading other people's code obsessively until I could see the shape of what they were doing. Copying it. Running it. Debugging the errors. Adjusting until it clicked.

I could build entire systems this way. I scaled a legacy booking platform to handle a billion dollars in travel. Led 30 developers across 7 teams. Delivered projects that digital agencies with million-dollar budgets couldn't.

But if you asked me to explain the architecture in formal terms? I'd struggle. If you asked why I chose one approach over another? I could feel the answer but not articulate it.

I needed visual metaphors. I needed to see working examples before my brain could orient. I needed someone to walk me through the first few steps of a new stack before I could take over.

For decades I thought this made me a lesser developer.

---

## The Reframe

Here's what I was actually doing:

**Pattern recognition** — seeing relationships between how data moves through systems without needing to name the formal concepts.

**Pattern matching** — finding existing solutions that fit the shape of my problem.

**Iteration** — running code, reading errors, adjusting, running again.

**Context bridging** — understanding how patterns from one domain apply to another.

Sound familiar?

That's exactly what large language models do.

I wasn't a developer who couldn't learn the "right" way. I was operating with the same mechanism that AI uses: pattern matching across a corpus, applied pragmatically to solve problems.

The difference was my corpus was smaller, my matching was slower, and I had to do all the iteration manually.

---

## The Two Axes

There are two different skills here, and most people conflate them:

**Pattern matching** — recognizing what works by feel, adapting existing solutions, iterating toward correctness without requiring full comprehension.

**Formal explanation** — understanding why something works in theoretical terms, being able to articulate and defend architectural decisions.

Traditional CS education optimizes hard for formal explanation. That's what's testable. That's what's teachable. That's what impresses in interviews.

But pattern matching is a different skill entirely. Some people have both. Most people have one or the other.

Here's the uncomfortable truth: a lot of the developers who can explain everything struggle to ship. And a lot of the developers who ship constantly can't explain half of what they built.

---

## The Shift

For decades, formal explanation was the premium skill. If you could articulate why your code worked, you could lead teams, pass interviews, write documentation, mentor juniors. The pattern-matchers who couldn't explain were perpetually undervalued — useful for getting things done, but not respected the way the explainers were.

AI inverts this.

AI handles explanation now. Ask it why a pattern works. Ask it to document the code. Ask it to articulate the tradeoffs. It's better at formal explanation than most humans.

What AI can't do — yet — is the systems thinking. The intuition for when a pattern fits a context. The ability to recognize that this problem is shaped like that other problem you solved five years ago in a completely different domain.

Pattern recognition is what's left for humans.

---

## 10 Months vs 10 Days

Here's the proof.

At my last job, we needed a bridge between a legacy API and a new content system. A developer on the team — smart, capable, also a pattern-matcher — spent 10 months trying to build it. Couldn't crack it.

The problem: the legacy system was so complex that nobody fully understood it anymore. I was the closest thing to a subject matter expert, but I'd been moved to a different team. Corporate silos. Information hoarding. The usual.

After I left, I built the same bridge in 10 days.

Command-line driven. AI-assisted. Recursive debugging loops — run the code, read the errors, feed them back to the AI, iterate until it worked.

What changed?

The AI became the person who could walk me through the first few steps. I didn't need to understand the new stack formally. The AI could scaffold the initial patterns. I could recognize whether they fit. We'd iterate together.

The pattern-matching approach I'd used since 1985 — copying magazine programs, adapting forum code, recognizing structures without understanding theory — suddenly had the perfect collaborator.

---

## The Potato on the Keyboard

One of my strongest pattern-matching skills: knowing where errors came from faster than anyone else.

Not by tracing logs methodically. By feeling the shape of the problem — the speed, the location, the rhythm of the errors, data points I couldn't even consciously name.

Here's an example. The booking platform started getting repeated trip uploads one night. Hundreds every minute. Same data, over and over. Nobody could figure out what was happening.

I said: "I think someone left a potato on their numberpad."

We traced the uploads to a single agent. Called her. Turned out she'd put a notebook on top of her numpad to raise her mouse up a little — she was developing carpal tunnel symptoms. The notebook was holding down a key.

I didn't diagnose that through formal analysis. I felt the shape of it: one source, consistent pattern, mechanical repetition. My brain pattern-matched to "physical object stuck on key" before I could explain why.

That's what pattern recognition looks like in practice. It's not magic. It's just a different way of processing information.

---

## Where Formal Training Still Wins

I'm not saying formally-trained developers are obsolete. They're not.

The scholastic devs are still essential for seeing when conventions are being broken. When a pattern-matcher is about to do something architecturally wrong, the person who understands *why* the conventions exist is the one who catches it.

They're guardrails. They guide architecture decisions. They maintain coherence across systems that pattern-matchers might fragment through local optimization.

The shift isn't that explanation becomes worthless. It's that explanation alone — without the ability to feel patterns and ship — is no longer enough. The hierarchy inverted, but both skills still matter.

The question is which one is your primary mode, and whether you can develop the other.

---

## The Unicorn

The ultimate developer can do both: pattern-match by feel AND explain formally. Recognize what works AND articulate why. Ship fast AND maintain architectural coherence.

I'd argue those people are exceptionally rare.

Most of us are stronger on one axis than the other. The formally-trained developers who can explain everything but struggle to ship without complete comprehension. The pattern-matchers who ship constantly but can't pass a whiteboard interview.

For decades, the system rewarded explanation over execution.

AI changes the equation. If you can pattern-match, AI can help you explain. If you can only explain, AI might actually make you less differentiated — because explaining is exactly what it's good at. But if you can catch architectural drift and maintain conventions? That's still valuable. AI doesn't have taste yet.

---

## The Invitation

If you're a pattern-matching developer — if you've always felt like you were doing it the "wrong" way, if you can build things but can't always explain why they work, if you need that initial scaffold before your brain kicks in — you might be perfectly positioned for this moment.

The tools finally match how your brain works.

And if you're a formally-trained developer who's feeling threatened by AI? The path forward might be developing the pattern intuition you never needed before. Let AI handle the explanation. Learn to feel when something fits.

Maybe AI is the bridge for both camps. Helps the pattern-matchers learn to explain. Helps the explainers learn to feel.

Either way, the hierarchy is shifting. The developers who couldn't explain themselves aren't lesser anymore.

We might be exactly what's needed.

---

*If you want to follow along:*
- *The code: [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)*
- *The network: [imajin.ai](https://imajin.ai)*

*— Ryan VETEZE*
