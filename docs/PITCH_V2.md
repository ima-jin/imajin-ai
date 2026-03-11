# Imajin Pitch Deck
*Working draft — March 11, 2026*

---

## Slide 0 — Ryan Veteze

30 years building systems. Director-level, led 8 teams. Built a dance music network that's been running for 25 years.

I've been trying to build what I'm about to show you for my entire career. Capital-gated every time. The architecture was always in my head — no one was going to fund it from someone who couldn't articulate it in VC-speak.

Then AI collapsed the execution barrier. I had 30 years of architectural clarity loaded and ready.

37 days. 14 live services. 86,000+ lines of code. 73 identities on a sovereign trust graph.

This isn't a pitch for something I'm going to build. It's already built.

---

## Slide 1 — You already know something is wrong.

You pick up your phone to check one thing and lose an hour. You delete the app, reinstall it a week later. You watch your kid scroll and recognize the same thing happening to you.

3.5 hours a day. That's the average. Most people know their number is higher.

This isn't a willpower problem. You're up against the most sophisticated behavioral engineering ever built — and it's working exactly as designed.

You are not the customer. You are the inventory.

---

## Slide 2 — Six problems. One root cause.

Every major platform holds four things hostage. Two more are in the process of being enclosed — the capture hasn't fully landed yet, but the trajectory is clear, and once it does, the lock-in will be structural and invisible.

All six have the same root: no sovereign identity.

**Infrastructure hostages — fix these or nothing else works:**
- Your identity is an account they issued. They can revoke it.
- Your relationships are their asset. The social graph is the lock-in that makes leaving feel like dying.

**Asset hostages — being monetized against you right now:**
- Your reputation lives on their server. Leave the platform, start from zero.
- Your attention is worth $272/year to advertisers. You get an app designed to keep you scrolling.

**In the process of being enclosed — the window is closing:**
- Commerce: payment infrastructure is consolidating fast. The rails are getting fewer and more expensive, and businesses won't feel the trap until they're fully dependent.
- Agents: the standards for how agents identify themselves and earn trust are being written right now. Whoever sets those standards sets the enclosure.

---

## Slide 3 — Infrastructure hostage 1: Identity

**The problem:** Your existence online is an account on their server. They issue it, they can revoke it. Every service you use inherits this fragility — your identity is a dependency you don't control.

**The fix:** You generate an Ed25519 keypair. That's your identity. Nobody issued it. Nobody can revoke it. It's cryptographically yours.

And on Day 37 we discovered: every keypair we'd generated was already a valid Solana wallet. The protocol wasn't designed to do that. It was excavated from building from the right principles.

---

## Slide 4 — Infrastructure hostage 2: Relationships

**The problem:** Your social graph is their asset. Every connection you've built, every relationship you've maintained — it lives in their database. That's the lock-in that makes leaving feel like dying.

**The fix:** An invite-only trust graph where you hold the edges. Leave any platform, take your graph with you. Your relationships are yours because they're scoped to your identity, not their server.

---

## Slide 5 — Asset hostage 1: Reputation

**The problem:** $1.5T freelance market. Non-portable ratings. Five years of five-star reviews on one platform — gone the moment you leave or the platform dies. Reputation is yours but stored where you can't take it.

**The fix:** Verifiable credentials on DIDs. Permanent. Portable. Cryptographically signed by the people who gave them. Your history follows your keypair, not their database.

---

## Slide 6 — Asset hostage 2: Attention

**The problem:** Meta makes ~$272/year from every North American user. Your relationships, interests, behavior patterns, screen time — that's what they're worth to advertisers. You get: an app designed to keep you scrolling.

**The fix:** Declared-intent marketplace. Your attention profile lives on your node. Companies pay to match your declared interests. You set the price. You keep the revenue. You revoke access anytime.

$272 is Meta's ceiling — attention is all they can extract. On Imajin, attention is the floor.

---

## Slide 7 — Being enclosed 1: Commerce

**The problem:** Payment infrastructure is consolidating fast. Stripe, Square, Shopify Payments. 33M US small businesses paying ~$15K/year in processing fees — and the rails are getting fewer, more expensive, and more dependent on terms that can change unilaterally. The businesses don't feel the trap until they're fully inside it.

**The fix:** Settlement fees below Stripe. Solana transaction cost ≈ $0.001. Instant. Atomic. Every .fair split settles in the same transaction. No intermediary capturing the spread. Revenue from the first transaction. No critical mass required.

---

## Slide 8 — Being enclosed 2: Agents

**The problem:** The standards for how agents identify themselves, earn trust, and operate across systems are being written right now. Whoever sets those standards sets the enclosure. If that gets solved inside OpenAI's ecosystem or Google's, the agent layer becomes the next form of platform capture — invisible because it operates below the user interface.

Every agent framework being built today solves capability. None solve accountability. Agents have no identity, no portable reputation, no way to prove who sent them or what they're authorized to do.

**The fix:** The protocol has a typed primitive for what an agent *is*. HumanActor, AgentActor, DeviceActor — all three get the same keypairs, the same DIDs, the same trust graph, the same .fair attribution. The protocol doesn't privilege one over the others. It just requires every actor to be signed and typed. Accountability is structural, not bolted on.

We're not competing with agent frameworks. We're the substrate they're missing. And the window to set this standard is open right now.

---

## Slide 9 — One protocol. The whole stack.

Six problems. One architecture.

Four identity scopes — the rings of trust:
- **Actor** — A single entity. HumanActor, AgentActor, or DeviceActor. One DID, one keypair. The atomic unit.
- **Family** — Intimate trust circle. Shared resources, delegated authority.
- **Community** — Shared interest or purpose. Trust is earned and attested, not inherited.
- **Business** — Structured entity. Roles, hierarchy, delegation chains. Formal governance over shared primitives.

Five primitives — the capabilities each scope can hold:
- **Attestation** — verifiable credentials, reputation, endorsement
- **Communication** — scoped messaging within and across trust rings
- **Attribution** — .fair manifests, revenue chains, creative lineage
- **Settlement** — payments, fees, declared-intent marketplace
- **Discovery** — federated registry, node presence, queryable expertise

| | Attestation | Communication | Attribution | Settlement | Discovery |
|---|---|---|---|---|---|
| **Actor** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Family** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Community** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Business** | ✓ | ✓ | ✓ | ✓ | ✓ |

The scope determines governance. The primitives determine capability. Every problem we described is a cell in this matrix. The platform is the matrix.

---

## Slide 10 — The matrix at human scale.

Three actors. Same architecture. Different cells.

**Jin** is an AgentActor with a DID. Jin hosts a party. Tickets are Settlement — each purchase creates a trust relationship. The LED cubes in the room are DeviceActors — they respond to verified presence. Every actor who walks in is signed and typed. When Jin throws the next party, there's no Eventbrite — just a ping to the trust graph. After April 1st, this is documented, not hypothetical.

**The freelancer** has five years of five-star reviews across three platforms. None of it travels. A new platform means starting from zero. With the matrix: every attestation lives on her Actor DID, cryptographically signed by the client who gave it. Her reputation follows her keypair. The platform can die. Her credentials don't.

**The studio** runs classes, pays instructors, manages a community. Currently: Stripe, Mailchimp, Mindbody, Google — four platforms, four monthly fees, four data silos, none of which talk to each other. With the matrix: one Business node. Settlement below Stripe. Attribution automatic. Communication trust-scoped. The community is an asset the studio owns, not a list it rents.

---

## Slide 11 — The matrix at industry scale.

Same cells. Four industries. Combined revenue: ~$800B/year flowing through platforms that don't pay the people who create the value.

You just saw all five primitives in action at human scale. Here's what happens when you apply the same architecture to the industries being hollowed out right now.

---

## Slide 11a — Education. $6T receipt for time served.

The entire education economy is a door-opening industry. The credential doesn't prove competence — it proves you sat in a room. Everyone knows this. Employers test for the actual skill. The credential gets you in the door. The door is the only thing it's for. And the door gets more expensive every year while what's behind it gets less valuable.

Domain knowledge — the thing that lives in the hands, in thirty years of pattern recognition, in the judgment that no model can replicate — is the last defensible asset on earth. And the people who have the most of it are getting paid the least for it.

**With the matrix:** The teacher's course is a Community DID. Enrollment is an attestation. Each lesson is attributed content on her node. Completion is an attestation she issues — signed, portable, cryptographically hers to give. Settlement routes direct. No platform taking 30%. When a student completes and shares what they learned, the .fair chain traces back to her.

The $6T education market is a door-opening industry. This replaces the door with a credential that actually means something.

*Cells: Community × Attestation, Community × Attribution, Actor × Settlement, Community × Discovery*

---

## Slide 11b — Music. The relationship was always the product.

Music didn't start as content. It started as someone in the room with you. The griot. The troubadour. The DJ who knew which record belonged to this room on this night. The meaning was inseparable from the relationship.

Now: the most music ever recorded, instantly available, and people have never felt less connected to it. $0.003 per stream. The artist's relationship with their audience owned by a platform. Discovery controlled by an algorithm with no skin in the game.

**With the matrix:** The artist's catalog lives on their node — each track a DID with .fair attribution baked in. A fan's ticket purchase creates a trust relationship, not a transaction that disappears. The artist communicates directly through the Community primitive — not an algorithm deciding who sees the post. When a track gets sampled, the .fair chain settles automatically back through the original. The relationship is the product again. The platform is optional.

*Cells: Actor × Attribution, Community × Communication, Community × Settlement, Actor × Discovery*

---

## Slide 11c — Journalism. The press isn't free. It's owned.

Mark Zuckerberg decided it was cheaper to disappear Canadian journalism from Canadian feeds than pay a fraction of a fraction of his revenue to the outlets whose content built his engagement. He was right. He did it. A foreign billionaire unilaterally restructured the information diet of an entire country. Nobody stopped him.

The beat reporter who covered the same city hall for thirty years — the person who knew which alderman drank, who understood that the zoning variance wasn't an accident — wasn't producing content. They were accumulating a relationship with a place. That relationship was the product. The platform destroyed it because the platform owns discovery.

**With the matrix:** The journalist's node is a Community DID. Their sources are trust-weighted attestations — not anonymous tips but verified relationships with declared provenance. Readers subscribe through Settlement directly, no platform intermediary. Discovery routes through the trust graph, not an algorithm optimizing for outrage. The beat reporter's thirty years of relationships are assets on their node, not locked in someone's database.

*Cells: Community × Attestation, Community × Settlement, Actor × Discovery, Community × Communication*

---

## Slide 11d — Advertising. The consent was stolen.

The ad industry isn't dying because ads are bad. It's dying because the consent was stolen.

The value was never the impression. It was the vouching. The neighbour who told you which mechanic not to use. The DJ who couldn't stop playing the new record. Trust transferred through a relationship. At some point the industry replaced the vouch with the eyeball. And then it got worse — surveillance, behavioural targeting, the dopamine casino. Ad-blocking is the most widely adopted software in human history. Not because people hate brands. Because people hate having their attention taken without asking.

**With the matrix:** The user declares their interests on their node. That declaration never leaves their node. A business pays to match — not to target, to match. The user sets the price. The user keeps the revenue. The user revokes access anytime. The advertiser gets a verified HumanActor who consented to the conversation. Not a probabilistic audience segment assembled from stolen data. A real person who said yes.

The $270B digital ad market is built on stolen consent. This gives it back — and makes it work better for everyone.

*Cells: Actor × Settlement, Actor × Attestation, Actor × Discovery, Business × Settlement*

---

## Slide 12 — This is not a concept.

37 days. Not a whitepaper. Working infrastructure with real users.

- 14 live services, self-hosted on owned hardware
- 73 registered identities (25 hard DIDs, 48 soft DIDs)
- Real events with real ticket sales
- First external contributor: Staff Engineer at Slack
- MJN token reserved on Solana mainnet
- GPU node running local inference

**The thesis is also published.** 30 essays — 9 live. The essays are the moat. Thesis coherence protected by being published, not patented.

**COCOMO II estimate for what exists:** $1.67M, 14.8 months, 6-person team.
**Actual:** $1,793 in API costs. 210 human hours. 37 days.

38× cheaper. 15× faster. 69× fewer hours.

98 scoped tickets ahead — worth another $604K traditionally. At current pace, that's weeks, not months.

---

## Slide 13 — Day 37: The protocol discovered itself.

We chose Ed25519 on Day 3 — the right cryptographic primitive for sovereign keypairs. Solana was always on the horizon for settlement. We chose to build identity first.

What we didn't know: it was already done.

Solana uses Ed25519 for wallet addresses. Every DID we'd generated was already a valid Solana wallet. Every backup file our users downloaded was already a wallet private key. No integration work. No bridge. No derivation.

The protocol wasn't designed. It was excavated from 37 days of building from the right principles.

---

## Slide 14 — Five revenue streams. Revenue from day one.

You just saw all five of these in the industry slides. Here's the complete picture.

No critical mass required. Every stream produces income from the first transaction.

- **Settlement fees** — protocol percentage on every transaction
- **Declared-intent marketplace** — your attention, your price, your revenue
- **Headless service settlement** — machine-to-machine, every API call is a revenue event
- **.fair attribution** — every derivative work settles back through the chain automatically
- **Trust graph queries** — domain expertise as queryable infrastructure. No ceiling.

---

## Slide 15 — MJN: a settlement instrument, not a speculative asset.

Reserve-backed utility token. Dual-currency — every transaction settles in fiat OR MJN. Nobody is forced into crypto.

- Mint on fiat deposit, burn on fiat withdrawal. 1:1 reserve backing.
- Lower fees than Stripe. Instant settlement. Atomic .fair splits.
- Per-scope governance: Actor = simple, Family = multi-sig, Community = quorum, Business = delegation.

---

## Slide 16 — Our position.

No Solana project has a trust-gated social layer with sovereign identity. No social network has an embedded settlement layer. No identity system has typed actor primitives with per-scope governance. We have all three — and they're the same thing.

That's the investment thesis: not three products that happen to be integrated, but one protocol where the integration is the product. The value compounds with every actor, every transaction, every node added to the graph.

| Analogue | What They Invested In | Outcome |
|---|---|---|
| Visa (1970) | Payment rail between banks | $500B, $15T/year volume |
| Stripe (2011) | Developer payment API | $95B, $1T/year volume |
| Cloudflare (2009) | Internet infrastructure | $35B, 20%+ of web traffic |
| Imajin (2026) | Identity + trust + settlement protocol | You are here |

Open source. Self-hostable. Federated. No kill switch.

---

## Slide 17 — The go-to-market is physical.

One node, one community, one city at a time.

- **Phase 1** — 10 seed nodes globally: Toronto ×3, Berlin, Cape Town, New York, Vancouver, Portland, Tokyo, Melbourne.
- **Phase 2** — Clusters. Each node becomes a gravity well. Events as mass onboarding.
- **Phase 3** — Protocol API. Imajin becomes the identity and trust layer underneath. Federation between sovereign nodes means the network is self-reinforcing — each new node increases the discovery surface and settlement volume for every existing node. Open source means the protocol spreads without a sales team.

---

## Slide 18 — $1.5M

Not a round. A milestone. First institutional capital into working infrastructure.

- 30% — Global node tour (10 nodes, developer meetups)
- 25% — Protocol development (federation, on-chain registry, agent gateway)
- 20% — Team (first hires)
- 12% — MJN Foundation (Swiss Stiftung, FINMA classification, fiat bridge legal)
- 13% — Runway (founder + infrastructure)

**What this buys in 4–6 months:**
- 3 Toronto nodes live — venues, studios, collectives
- 500+ identities on the trust graph
- Agent gateway — trust-gated inference routing
- Federation between sovereign nodes
- 7 global nodes deployed
- MJN Foundation incorporated
- Fiat bridge live
- 2,500+ identities across the global trust graph

---

## Slide 19 — Sovereignty is a spectrum.

Not everyone runs a server. That's the point. You choose your trust tradeoff — and you can move up or down anytime.

- **Tier 1:** Use someone else's node. Trust your operator, data always portable. Free.
- **Tier 2:** Run your own node (cloud). ~$5/mo VPS. You hold the keys.
- **Tier 3:** Run your own node (hardware). Raspberry Pi, ~$50. Full sovereignty.
- **Tier 4:** Run a community or business node. Serve your neighborhood. Earn from every settlement.

This is the BBS model rebuilt — except now you can take your posts with you when you leave.

---

## Slide 20 — The thesis.

The internet was built to move documents. Then packets. Neither carried the human.

Platforms filled the gap — and captured everything.

Imajin carries the human. Identity, trust, attribution, settlement — all in one protocol. For humans and agents alike.

Start from the human and you will find the protocol.

---

## Slide 21 — Start from the human.

30 years of vision. 30 essays. 37 days of execution.

14 services. $1,793. Every Actor DID is already a Solana wallet. All open source.

The protocol found itself. Now we scale it.