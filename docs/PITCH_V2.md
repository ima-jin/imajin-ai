# Imajin Pitch Deck
*Working draft — March 11, 2026*

---

## Slide 0 — Ryan Veteze

30 years building systems. Director-level, led 8 teams. Built a dance music network that's still running after 25 years.

The architecture was always in my head. Capital-gated every time — couldn't articulate it in VC-speak.

Then AI collapsed the execution barrier. 30 years of architectural clarity, loaded and ready.

37 days. 14 live services. 86,000+ lines of code. 73 identities on a sovereign trust graph.

This isn't a pitch for something I'm going to build. It's already built.

---

## Slide 1 — You already know something is wrong.

You pick up your phone to check one thing and lose an hour. You delete the app, reinstall it a week later. You watch your kid scroll and recognize the same thing happening to you.

3.5 hours a day. That's the average. Most people know their number is higher.

They don't sell your attention. They sell the power to shape what you attend to — which shapes what you learn, what you prefer, what you choose, and ultimately who you become. (Browne & Watzl, 2026)

You are not the customer. You are the inventory.

---

## Slide 2 — Six problems. One root cause.

All six have the same root: no sovereign identity.

**Infrastructure hostages — fix these or nothing else works:**
- Your identity is an account they issued. They can revoke it.
- Your relationships are their asset. The social graph is the lock-in.

**Asset hostages — being monetized against you right now:**
- Your reputation lives on their server. Leave the platform, start from zero.
- Your attention is worth $272/year to advertisers. You get $0.

**Being enclosed — the window is closing:**
- Commerce: payment rails consolidating. Fewer, more expensive, terms change unilaterally.
- Agents: identity standards being written right now. Whoever sets them sets the enclosure.

---

## Slide 3 — Infrastructure hostage 1: Identity

**The problem:** Your existence online is an account on their server. They issue it, they can revoke it.

**The fix:** You generate an Ed25519 keypair. That's your identity. Nobody issued it. Nobody can revoke it. It's cryptographically yours.

On Day 37 we discovered: every keypair we'd generated was already a valid Solana wallet. The protocol wasn't designed to do that. It was excavated from building from the right principles.

---

## Slide 4 — Infrastructure hostage 2: Relationships

**The problem:** Your social graph is their asset. That's the lock-in that makes leaving feel like dying.

**The fix:** An invite-only trust graph where you hold the edges. Leave any platform, take your graph with you.

---

## Slide 5 — Asset hostage 1: Reputation

**The problem:** $1.5T freelance market. Non-portable ratings. Five years of five-star reviews — gone the moment you leave.

**The fix:** Verifiable credentials on DIDs. Permanent. Portable. Cryptographically signed by the people who gave them. Your history follows your keypair, not their database.

---

## Slide 6 — Asset hostage 2: Attention

**The problem:** Meta makes ~$272/year from every North American user. You get: an app designed to keep you scrolling. They're not selling your eyeballs — they're selling the power to shape your attentional environment. Every ad placement is an act of attentional landscaping you never consented to.

**The fix:** Consent-to-influence architecture. You author a signed declaration of what you're willing to attend to. Companies pay to match your declared interests — answering an invitation you wrote, not infiltrating your sensory environment. You set the price. You keep the revenue. You revoke anytime. The declaration is cryptographic proof that the process of influence was self-authored.

$272 is Meta's ceiling. On Imajin, attention is the floor.

---

## Slide 7 — Being enclosed 1: Commerce

**The problem:** 33M US small businesses paying ~$15K/year in processing fees. The rails are getting fewer and more expensive. Businesses won't feel the trap until they're fully inside it.

**The fix:** Solana transaction cost ≈ $0.001. Every .fair split settles in the same transaction. No intermediary capturing the spread. Revenue from the first transaction.

---

## Slide 8 — Being enclosed 2: Agents

Every agent framework being built today solves capability. None solve accountability.

Agents have no identity, no portable reputation, no way to prove who sent them or what they're authorized to do. Whoever sets the identity standard sets the enclosure.

**The fix:** HumanActor, AgentActor, DeviceActor — same keypairs, same DIDs, same trust graph, same .fair attribution. Every actor signed and typed. Accountability is structural, not bolted on.

We're not competing with agent frameworks. We're the substrate they're missing.

---

## Slide 9 — One protocol. The whole stack.

Six problems. One architecture.

Four identity scopes:
- **Actor** — One DID, one keypair. The atomic unit.
- **Family** — Intimate trust. Shared resources, delegated authority.
- **Community** — Shared purpose. Trust earned and attested.
- **Business** — Structured entity. Roles, hierarchy, delegation chains.

Five primitives:
- **Attestation** — credentials, reputation, endorsement
- **Communication** — scoped messaging within and across trust rings
- **Attribution** — .fair manifests, revenue chains, creative lineage
- **Settlement** — payments, fees, declared-intent marketplace
- **Discovery** — federated registry, node presence, queryable expertise

Every problem we described is a cell in this matrix. The platform is the matrix.

---

## Slide 10 — The matrix at human scale.

**Jin** is an AgentActor with a DID. Jin hosts a party. Tickets are Settlement — each purchase creates a trust relationship. The LED cubes are DeviceActors responding to verified presence. Next party: no Eventbrite — just a ping to the trust graph.

**The freelancer** has five years of reviews across three platforms. None travels. With the matrix: every attestation on her DID, signed by the client. Her reputation follows her keypair. The platform can die. Her credentials don't.

**The studio** runs classes, pays instructors, manages a community. Four platforms, four fees, four data silos. With the matrix: one Business node. Settlement below Stripe. Attribution automatic. The community is an asset the studio owns, not a list it rents.

---

## Slide 11 — The matrix at industry scale.

Four industries. ~$800B/year flowing through platforms that don't pay the people who create the value.

---

## Slide 11a — Education. $6T receipt for time served.

The credential doesn't prove competence — it proves you sat in a room. The door gets more expensive every year while what's behind it gets less valuable.

Domain knowledge — thirty years of pattern recognition, judgment no model can replicate — is the last defensible asset on earth. The people who have the most of it are getting paid the least.

**With the matrix:** Course is a Community DID. Enrollment is an attestation. Completion is a credential she issues — signed, portable, hers to give. Settlement direct. No platform taking 30%.


---

## Slide 11b — Music. The relationship was always the product.

Music started as someone in the room with you. The griot. The troubadour. The DJ who knew which record belonged to this room on this night.

Now: $0.003 per stream. The artist's relationship with their audience owned by a platform. Discovery controlled by an algorithm with no skin in the game.

**With the matrix:** Catalog on the artist's node. Each track a DID with .fair attribution. Fan's ticket purchase creates a trust relationship, not a transaction that disappears. When a track gets sampled, the .fair chain settles automatically. The relationship is the product again.


---

## Slide 11c — Journalism. The press isn't free. It's owned.

Zuckerberg decided it was cheaper to disappear Canadian journalism from Canadian feeds than pay the outlets whose content built his engagement. A foreign billionaire unilaterally restructured the information diet of an entire country.

The beat reporter covering city hall for thirty years wasn't producing content. They were accumulating a relationship with a place. The platform destroyed it because the platform owns discovery.

**With the matrix:** Sources are trust-weighted attestations. Readers subscribe through Settlement directly. Discovery routes through the trust graph, not an algorithm optimizing for outrage.


---

## Slide 11d — Advertising. The consent was stolen.

The ad industry isn't dying because ads are bad. It's dying because the consent was stolen.

The value was never the impression. It was the vouching. The neighbour who told you which mechanic not to use. Trust transferred through a relationship. The industry replaced the vouch with the eyeball, then the dopamine casino. Ad-blocking is the most widely adopted software in human history.

**With the matrix:** User declares interests on their node. Declaration never leaves. Business pays to match — not target. User sets the price, keeps the revenue, revokes anytime. A real person who said yes.


---

## Slide 12 — This is not a concept.

37 days. Working infrastructure. Real users.

- 14 live services, self-hosted on owned hardware
- 73 registered identities (25 hard DIDs, 48 soft DIDs)
- Real events with real ticket sales
- First external contributor: Staff Engineer at Slack
- MJN token reserved on Solana mainnet
- GPU node running local inference

**The thesis is published.** 30 essays — 9 live. Thesis coherence protected by being published, not patented.

**COCOMO II estimate:** $1.67M, 14.8 months, 6-person team.
**Actual:** $1,793 in API costs. 210 human hours. 37 days. AI-augmented development — one person with architectural clarity and the right tooling.

98 scoped tickets ahead — worth another $604K traditionally. At current pace, weeks not months.

---

## Slide 13 — Day 37: The protocol discovered itself.

We chose Ed25519 on Day 3 — the right cryptographic primitive for sovereign keypairs. Solana was always on the horizon for settlement.

What we didn't know: it was already done.

Every DID we'd generated was already a valid Solana wallet. Every backup file our users downloaded was already a wallet private key. No integration. No bridge. No derivation.

The protocol wasn't designed. It was excavated.

---

## Slide 14 — Five revenue streams. Revenue from day one.

No critical mass required. Every stream produces income from the first transaction.

- **Settlement fees** — protocol percentage on every transaction
- **Declared-intent marketplace** — your attention, your price, your revenue
- **Headless service settlement** — machine-to-machine, every API call is a revenue event
- **.fair attribution** — every derivative work settles back through the chain
- **Trust graph queries** — domain expertise as queryable infrastructure. No ceiling.

---

## Slide 15 — MJN: a settlement instrument, not a speculative asset.

Reserve-backed utility token. Dual-currency — every transaction settles in fiat OR MJN. Nobody is forced into crypto.

- Mint on fiat deposit, burn on fiat withdrawal. 1:1 reserve backing.
- Lower fees than Stripe. Instant settlement. Atomic .fair splits.
- Per-scope governance: Actor = simple, Family = multi-sig, Community = quorum, Business = delegation.

---

## Slide 16 — Our position.

No Solana project has a trust-gated social layer. No social network has an embedded settlement layer. No identity system has typed actor primitives with per-scope governance. We have all three — and they're the same thing.

One protocol where the integration is the product. Value compounds with every actor, every transaction, every node.

| Analogue | What They Invested In | Outcome |
|---|---|---|
| Visa (1970) | Payment rail between banks | $500B, $15T/year volume |
| Stripe (2011) | Developer payment API | $95B, $1T/year volume |
| Cloudflare (2009) | Internet infrastructure | $35B, 20%+ of web traffic |
| Imajin (2026) | Identity + trust + settlement protocol | You are here |

Open source. Self-hostable. Federated. No kill switch.

---

## Slide 17 — Not a better attention market.

MJN is the architectural abolition of the attention market as currently constituted — and its replacement with infrastructure for attentional self-determination.

| Failure Mode | Current Attention Market | MJN Architecture |
|---|---|---|
| **Opacity** | You can't see who shapes your attention or how | Signed declarations, attestation history, identity archaeology — every process is legible |
| **Cumulative manipulation** | Influence accumulates below your threshold of notice | Gas model imposes exponential cost on repetition — accumulation is structurally deterred |
| **Unendorsable processes** | Shaped by actors whose interests are misaligned with yours | You author declarations, sign them, revoke them — the process of influence is self-authored |
| **Inescapable** | Leave and lose your relationship graph | BaggageDID, portable keypair, federated nodes — sovereignty is guaranteed at exit |

Academic grounding: Browne & Watzl (2026), "The Attention Market — and What Is Wrong with It," *Philosophical Studies* Vol. 183. Their diagnosis. Our architecture.

---

## Slide 18 — The go-to-market is physical.
*[was Slide 17]*

One node, one community, one city at a time.

- **Phase 1** — 10 seed nodes: Toronto ×3, Berlin, Cape Town, New York, Vancouver, Portland, Tokyo, Melbourne.
- **Phase 2** — Clusters. Each node becomes a gravity well. Events as mass onboarding.
- **Phase 3** — Protocol API. Imajin becomes the identity and trust layer underneath. Each new node increases discovery and settlement volume for every existing node. Open source means the protocol spreads without a sales team.

---

## Slide 19 — $1.5M

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

## Slide 20 — Sovereignty is a spectrum.

Not everyone runs a server. That's the point.

- **Tier 1:** Use someone else's node. Trust your operator, data always portable. Free.
- **Tier 2:** Run your own node (cloud). ~$5/mo VPS. You hold the keys.
- **Tier 3:** Run your own node (hardware). Raspberry Pi, ~$50. Full sovereignty.
- **Tier 4:** Run a community or business node. Serve your neighborhood. Earn from every settlement.

The BBS model rebuilt — except now you take your posts with you when you leave.

---

## Slide 21 — The thesis.

The internet was built to move documents. Then packets. Neither carried the human.

Platforms filled the gap — and captured everything. Not just your data — the power to shape what you attend to, what you learn, what you prefer, what you choose, and who you become.

Imajin carries the human. Identity, trust, attribution, settlement — all in one protocol. For humans and agents alike.

Start from the human — sovereign, present, with the right to understand and govern the processes that shape them — and you will find the protocol underneath.

---

## Slide 22 — Start from the human.

30 years of vision. 30 essays. 37 days of execution.

14 services. $1,793. Every Actor DID is already a Solana wallet. All open source.

The protocol found itself. Now we scale it.