# Proposal 23 — MJN Node Operator Guide
## Recognition Over Endorsement

**Filed:** 2026-03-17
**Author:** Greg Mulholland (Tonalith), incorporating Ryan Veteze feedback
**Series:** Proposal 11 of the Greg architectural review series / Node Operator Guide Section
**Against upstream HEAD:** 39331e0
**Relates to:** Proposal 21 (Attentional Sovereignty), Proposal 22 (Identity Archaeology), RFC-07 (Cultural DID), Proposal 04 (Org DID Vetting)
**Upstream evidence:** None — not yet in upstream docs/proposals/

---

## What This Document Is For

MJN's architecture handles a lot automatically: standing is computed from attestation history, governance weight is trust-weighted, bad actors are structurally deterred, and the vouch chain creates accountability that propagates through the graph.

The protocol does not run onboarding meetings. It does not write your welcome message. It does not decide how to handle the person who joined three months ago, shows up inconsistently, and seems a little lost. It does not tell you what to say when someone's first event experience was disappointing, or when a long-standing member is behaving in ways that are subtly off but haven't triggered a formal flag.

Those moments are where community actually forms — or fails to. And they happen between people, not between protocol primitives.

This document is about one principle that governs all of those human moments: **recognition over endorsement**. It is the most important thing a node operator can understand about how Imajin communities are different from the communities people are used to — and why that difference has to be actively maintained, not just assumed.

---

## Part 1: The Concept

### What Recognition Over Endorsement Means

Most online platforms — and many communities — operate on an endorsement model. The implicit message is: present the best version of yourself, earn approval, and your standing will grow. Profiles are polished. Participation is performance. People learn quickly what gets rewarded and shape themselves accordingly.

The problem is that endorsement-seeking behaviour and authentic participation look similar from the outside — and are very different from the inside. Over time, endorsement-based communities fill up with people performing community rather than building it.

Imajin's standing model is already structurally resistant to this: standing is computed from attestation history — from what people actually did, not how they presented themselves. You cannot buy standing, optimise a profile for it, or game it with a burst of visible activity. It accumulates from real participation, weighted by the trust of the people who attested to it.

But the protocol alone does not prevent the endorsement mindset from shaping how people show up. That mindset is deeply conditioned — it is the default posture that years of social media have installed. People will arrive at your node carrying it, unconsciously.

**Recognition is the alternative.** It means: see where someone actually is, acknowledge it honestly, and build from there. Not where they should be. Not where they want you to think they are. Where they are.

This is not the same as lowering standards or accepting poor behaviour. Recognition is not permissiveness — it is clarity. The person who has attended two events and is still figuring out what this network is: recognise that clearly, and treat them accordingly. The person who has been showing up consistently for six months and is ready for more responsibility: recognise that clearly, and give them the next challenge. The person who is subtly extracting from the community without contributing: recognise that clearly, and name it.

### Why It Matters for Imajin Specifically

People arriving at an Imajin node are coming from an attention economy that has spent years shaping their attentional habits. Many of them will have conditioned reflexes around community participation that are not well-suited to what Imajin is building.

**Common patterns you will encounter:**

- **The performer** — Highly visible early, lots of activity at the surface, slow to build genuine relationships. The standing model will eventually reflect the shallowness of the participation — but in the meantime, the person may feel frustrated that visibility is not translating to standing.
- **The lurker** — Present but not participating. May have valuable expertise or genuine interest but has learned to consume rather than contribute. Standing will correctly keep them at Visitor or early Resident.
- **The optimiser** — Figured out that events drive attestations and is attending events without genuine engagement. The attestation record will eventually show the pattern — but the node operator will notice it first.
- **The genuinely uncertain** — Does not know what they want from this community yet. Not performing or gaming — just hasn't found their place. This person needs time and a clear, honest signal about what participation actually looks like here.

None of these people are bad actors. They are people whose relationship with community has been shaped by platforms that rewarded the wrong things. The node operator's job is not to judge them for those patterns — it is to see them clearly, name what is true, and create the conditions for genuine participation to emerge.

### The Difference in Practice: Two Conversations

**The situation:** Marcus has been on the node for two months. He attended the first event and was enthusiastic. Since then he has not attended anything, has not responded to community messages, and his standing has not grown. He sends a message asking why his standing is stuck and whether there is anything he can do to improve it quickly.

**Endorsement response:**
> "Hey Marcus, great to hear from you! Standing grows through participation — events, vouches, verified interactions. Try attending the next event and connecting with a few people there. Looking forward to seeing you more active!"

*What this does:* validates Marcus's framing (standing as a thing to optimise), gives him a task list, avoids the real conversation. He will attend one event, get a slight standing bump, and probably disappear again.

**Recognition response:**
> "Hey Marcus — honest answer: your standing reflects what has actually happened. You came to the first event, which was great, and then you've been quiet. That's not a judgment — it's just what the record shows. Before we talk about standing, it's worth asking: what brought you here in the first place? What were you hoping to find? Because standing is a byproduct of participation, not a goal in itself. If you can tell me what you're actually looking for, we can figure out if this is the right community for that — and if it is, what genuine participation looks like for you specifically."

*What this does:* refuses to validate the optimiser framing, names what is actually true, and opens a real conversation.

---

## Part 2: The Practice

### Onboarding: The First Conversation

The onboarding moment is where the tone is set for everything that follows. Imajin onboarding does all the usual things — and one more: it establishes that this community sees people clearly.

Concretely:

- **Ask before you tell** — Before explaining what the node offers, ask what brought the person here. Their answer tells you which parts of the platform are actually relevant to them right now.
- **Be specific about what standing is not** — Standing is not a score. It is not optimisable. It is not a reward for performing the right behaviours. It is a reflection of real participation over time. Say this explicitly, early.
- **Normalise the slow start** — Most people will be at Visitor or early Resident for a while. This is correct. Frame it as the natural shape of trust, not a problem to solve.
- **Name the conditioning honestly** — You can say, directly, that most people arrive having spent years on platforms that rewarded performance over participation. That conditioning does not go away immediately. The community is patient with the transition — but it recognises the difference.

If the person is not yet sure what they want from this community, say so back to them: *'It sounds like you're still figuring out what you're looking for here — that's fine. Take your time. Genuine participation will emerge when something clicks.'*

### During Participation: Naming What You See

Recognition is an ongoing practice, not just an onboarding position.

- **Acknowledge real contributions specifically** — Not 'great job!' but 'the way you handled the equipment setup on Thursday freed up two hours of the organising team's time. That kind of practical contribution is exactly what this community runs on.'
- **Name drift when you see it** — If someone who was previously engaged has gone quiet, reach out — not to nudge them toward activity but to check in genuinely. 'I've noticed you've been quieter lately — is everything okay? No expectation either way.'
- **Distinguish types of participation** — Attending events, facilitating, contributing skills, bringing in a new person — help members see the full range of how contribution can look.
- **Do not over-praise early activity** — Warm enthusiasm for a new person's first few contributions can inadvertently reinforce the performer dynamic. Acknowledgement proportional to the contribution is more trustworthy than enthusiasm.

### When Things Are Off: Recognition Without Judgment

| Situation | Endorsement instinct | Recognition practice |
|---|---|---|
| Member attending events without engaging | Appreciate the attendance | 'I've noticed you've been coming to events but you've been pretty quiet. What's drawing you here? Are you finding what you're looking for?' |
| Member extracting value, not contributing | Avoid the conversation | 'I want to name something directly: you've been a consumer of what this community produces for a few months now. That's fine for a while. But there's a tipping point. What would contribution look like for you here?' |
| Performer getting frustrated their standing isn't growing | Give them more to do | 'Your standing accurately reflects what has happened here. You've been visible — that's real. But visibility and contribution aren't the same thing. What would contribution that matters to you actually look like?' |

In each case, the recognition response is more direct, not less kind. Naming what is true — clearly, without blame — treats the person as capable of handling honesty.

### Flags and Formal Process: Recognition in the Protocol

When behaviour has reached the threshold for a formal flag, recognition still governs how the process is run:

- **`flag.yellow`** — A soft signal. The conversation should feel like a check-in, not a tribunal.
- **`flag.amber`** — A formal concern. The person should understand clearly what they are being asked to address, and should have a genuine opportunity to respond.
- **`flag.red`** — A severe matter. Handled by the governance quorum. The person should receive a clear account of what happened, what was decided, and why.

In every flag process, the person it concerns should be told what is true — not a euphemised version, not a bureaucratic summary.

**One specific requirement:** The identity archaeology view (Proposal 22) ensures that every person can see their own flag history completely — including expired and revoked flags. Node operators should know this. When you issue a flag, the person will be able to see it in their record. That is correct and intentional. Do not issue flags you would not be willing to stand behind in a direct conversation with the person.

---

## Part 3: Role-Specific Guidance

### Community Organiser

You run the events, hold the relationships, and are the face of the node for most members. Recognition is primarily a relational practice in your role — it lives in conversations, in how you introduce people, in the tone you set in a room.

**Your most important recognition practices:**

- **How you introduce new members** — Avoid automatic enthusiasm. 'This is Amara — she's been coming to our events for a couple of months and is starting to get involved in the sound side of things. She's still figuring out what this community is for her, which is fine.' That introduction gives Amara room to be where she is rather than performing a role she's been assigned.
- **How you frame standing to new members** — The most common question you will get: 'How do I grow my standing?' The recognition answer: 'By participating in ways that matter to you and to the community. Standing is a byproduct of that. Tell me what you're hoping to do here, and we'll figure out what genuine participation looks like for you.'
- **How you handle the first conflict** — The first time two members have a genuine disagreement, every other member is watching how you respond. If you smooth it over without naming what happened, you signal that the community manages appearances.
- **How you talk about people who have left** — 'They weren't a good fit' is an endorsement-model response. 'They were here for a while and it didn't develop into genuine participation' is a recognition response — honest without being unkind.

**Scenario:** You're running onboarding for a new batch of three Residents. One of them — Daniel — is clearly more polished and socially confident than the other two. He's already networking, making jokes, and positioning himself as someone who 'gets it.'

The endorsement instinct is to respond warmly to Daniel's energy and let the other two find their feet. The recognition practice is to give Daniel honest, specific feedback early ('You're clearly comfortable in rooms — that's great. The thing to watch is whether that comfort is creating space for others or taking it'), and to actively create moments where the quieter two can contribute without having to compete with Daniel's social fluency.

---

### Technical Operator

You run the infrastructure. Your relationship with community members is primarily through the systems you operate rather than through direct human interaction. Recognition in your role is about what the systems surface, what they obscure, and how you communicate about them.

**Your most important recognition practices:**

- **How you communicate system behaviour** — Not 'the algorithm determined...' but 'you vouched for someone who received two amber flags in the last month. That affects your standing because your vouch is part of the accountability chain. Here is what the attestation record shows.'
- **How you handle the identity archaeology view** — When it is built, it will be the most honest mirror most members have ever seen of their own participation. Some people will find their record surprising or uncomfortable. Your job is to support access to it, not to manage what people see. The record is accurate. People are capable of handling accurate records.
- **How you communicate about flags** — Flags are technical records with human consequences. Use the language of what is recorded and what it means, not the language of judgment. 'The system has recorded a `flag.amber` attestation issued by the governance quorum on [date]. Here is what that means for your standing and the next steps.'
- **How you design the onboarding flow** — The copy around keypair generation should be honest about what is being created. 'Generating your keypair. This is your identity on this network — not an account we issued, but a mathematical fact about who you are. Nobody can revoke it. We recommend storing the backup file somewhere safe.'

**Scenario:** A member contacts you to say they think there is a bug: their standing hasn't changed in six weeks despite attending three events. They want you to look at the database and 'fix it.'

The endorsement response: check whether there's a bug and report back. The recognition response: check whether there is a bug (there probably isn't), explain what the attestation record actually shows ('Your three event attendances are recorded. Standing computation weights those attestations by the standing of the event organiser and by recency — here is what the weighted inputs look like'), and be honest if the standing model is working as designed and the member's expectations were off.

---

### Seed Node Steward

You are running one of the first nodes in the network. The communities you build will shape the culture of MJN at a critical moment — before norms are established, before there is a playbook, when the protocol is still proving itself.

**Your most important recognition practices:**

- **Be honest about where the build is** — The declared-intent marketplace, the full identity archaeology view, the Community DID governance tooling — these are on the roadmap, not in the current build. 'We're early. The infrastructure is real and it is working. Some of the features we're building toward aren't live yet. Here is what is live, here is what is coming.'
- **Name the experiment** — Your node is an experiment in what sovereign community infrastructure can be. Not all of it will work perfectly. 'We tried running governance by weighted quorum for the last two decisions. Here is what worked and what was awkward. We are going to adjust the threshold.'
- **Guard against founding-cohort capture** — The people who show up first accumulate disproportionate influence. This is a structural risk documented in Proposal 04. The recognition practice: 'Those of us who have been here since the beginning have more standing and more governance weight than people who join later. That is correct in the short term — we built this. But we should be actively watching for whether that early weight is serving the community or protecting our own position.'
- **Tend the BaggageDID with care** — When members leave your node, the exit credential they carry is a reflection of what you built together. Be accurate. Be honest. Do not inflate the summary to protect relationships, and do not deflate it to punish departures.

**Scenario:** Your node is eight months old. Two of the original Host members have started to have a recurring influence on governance decisions that other members are beginning to notice and comment on — not because the two are acting in bad faith, but because they have significantly more standing than everyone else and their opinions tend to anchor discussions.

The recognition practice is to name this at the governance level before it becomes a conflict: 'I want to name something we should think about together. [Names] have earned their standing — it reflects real contribution. And right now their governance weight is significantly higher than anyone else's. That was right when we were getting started. I want to ask whether it is still right, and whether there are ways we should be more actively developing the governance weight of newer Host members.'

Seed node stewards have one job that no other node operator has: building the culture that will be inherited by every node that comes after. The recognition-over-endorsement principle, practised consistently in a seed node, becomes the default expectation when members of that community go on to start or join other nodes. What you model here propagates forward.

---

## Connection to Architecture (Proposal 21)

Recognition over endorsement is the human-layer practice that corresponds to attentional sovereignty at the protocol layer:

- The attestation layer makes participation legible — recognition is what makes that legibility meaningful in human conversation
- The identity archaeology view surfaces the complete record, including flag history — recognition is what makes it possible to have an honest conversation about what that record contains
- Behavior-seeded declarations capture what people actually do, not what they say they are — recognition extends that principle from the protocol to the community relationship
- The 33% governance weight ceiling prevents attentional-landscape capture — recognition is how node operators catch the subtler forms of this before they require a formal governance intervention

The architecture protects attentional sovereignty at the protocol layer. What happens at the human layer — in conversations, in how you run a room, in the tone you set when things get complicated — is your responsibility as a node operator. The protocol gives you the right structure. You provide the right practice.

Start from where people actually are. See them clearly. Build from there. That is what the network is for.

---

## Decisions Required from Ryan

| # | Decision | Greg's position | Status |
|---|---|---|---|
| 1 | Does this section belong in the Node Operator Guide in upstream docs? | Yes — Ryan confirmed this in his response to P21 | Open |
| 2 | Should `docs/philosophy/` folder be created for Section 3 content from P21 (mindfulness/Jungian/IFS)? | Yes | Open |
| 3 | Does the recognition-over-endorsement framing appear in Community DID governance documentation (RFC-07)? | Yes — at governance level, not protocol level | Open |
| 4 | Does onboarding UX copy incorporate the distinction between recognition and endorsement? | Yes | Open |

**Resolution signals in the repository:**
- `docs/node-operator-guide/` directory exists with this section (or equivalent)
- `docs/philosophy/` directory contains the mindfulness/Jungian/IFS content from P21 Section 3
- Community DID governance documentation includes attentional-landscape manipulation as a behavioral removal trigger
- Onboarding UX copy does not prompt users to present a best version of themselves

---

*The protocol gives you the right structure. You provide the right practice.*
*— Greg, March 17, 2026*
