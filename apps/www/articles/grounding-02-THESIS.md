# The Imajin Thesis

*Canonical definitions. When an essay and this document disagree, this document is current.*

*Last updated: March 1, 2026*

---

## Reading Order

The concepts build on each other. Each one requires the ones above it.

1. **The Problem** — What broke and why
2. **Sovereign Identity** — The individual as the atomic unit
3. **The Trust Graph** — How individuals relate to each other
4. **The Node** — Where presence lives
5. **The Operator** — Who runs the infrastructure
6. **.fair** — How attribution works
7. **The Settlement Layer** — How money moves
8. **MJN** — What the token does
9. **The Consumer Model** — But how the fuck are we going to make money?
10. **Redistribution** — Where the money goes after it flows

---

## 1. The Problem

*What broke and why.*

TODO: The extraction model. Platforms captured the relationship between people and monetized the connection itself. Every step since 1994 was intermediation — inserting a rent-seeking layer between humans who were already talking to each other. The computer became invisible, and invisible became unaccountable.

**Canonical rejection:**
- No subscriptions (you own it forever)
- No cloud dependency (self-hosted, privacy-first)
- No vendor lock-in (open firmware)
- No surveillance capitalism (your data stays yours)
- No planned obsolescence (repairable, expandable)

**Key essays:** 1 (The Internet We Lost), 3 (The Mask We All Wear)

---

## 2. Sovereign Identity

*The individual as the atomic unit.*

TODO: Keypair-based identity. A person generates a cryptographic keypair — that's their identity. No email/password. No OAuth. No platform granting you the right to exist. Your identity is a mathematical fact, not a permission.

- **DID (Decentralized Identifier)** — W3C standard. Your public key becomes a globally resolvable identifier that no one can revoke.
- **Signed interactions** — Every action (message, transaction, vouch) is cryptographically signed. You always know who did what. No impersonation.
- **Human/agent typing** — Every identity is typed. You always know whether you're talking to a person or a machine. Same primitives, different label.

**The principle:** You exist because math says so, not because a platform says so.

**Key essays:** 4 (The Internet That Pays You Back), 6 (The Guild)

---

## 3. The Trust Graph

*How individuals relate to each other.*

TODO: Vouching relationships. Trust isn't declared — it's demonstrated. You vouch for someone by directing resources (attention, compute, money) toward them. The graph is the sum of all those directed flows.

- **Not a social graph** — Social graphs are symmetric (we're "friends"). Trust graphs are directed and weighted (I trust you *this much* for *this purpose*).
- **Not reputation** — Reputation is a score assigned by a platform. Trust is a relationship owned by the participants.
- **Emergent leadership** — The most-queried nodes in the graph are the natural leaders. Not elected, not appointed — emerged through actual reliance.
- **Finite by design** — Your trust network is bounded by your actual relationships. This is a feature. Constraint creates intimacy.

**The principle:** Trust is a relationship, not a score. It belongs to the people in it, not the platform observing it.

**Key essays:** 4 (The Internet That Pays You Back), 5 (You Don't Need Ads), 27 (Around, Not Up)

---

## 4. The Node

*Where presence lives.*

TODO: A node is a signed, self-hosted instance of the Imajin stack. It's your piece of the network — a server you own, running software you control, storing data that belongs to you.

- **Physical presence** — A node takes up space. It runs on hardware you can touch. The Unit (8×8×8 LED cube) is the first node — undeniably *there*.
- **Permanent record** — Everything that happens on your node is a signed record that belongs to you and the people who made it. Not the platform. Not the cloud provider. You.
- **Types:** Personal, family, event, community, business — same infrastructure, different scale.
- **Federated discovery** — Nodes register with a registry for discoverability (`{name}.imajin.ai`), but work locally without it. The exit door is always open.

**The principle:** Your presence lives on hardware you own. If the network disappears tomorrow, your node still works.

**Key essays:** 7 (The Utility), 9 (The Practice), 10 (Memory)

---

## 5. The Operator

*Who runs the infrastructure.*

TODO: The sysop reimagined. AI collapsed the technical barrier to running a node — you don't need to be a developer. But intentionality can't be automated. The operator is the human who *chooses* to run infrastructure for their community.

- **Not a credential** — There's no certification. The trust graph is the credential. Your community trusts you or it doesn't.
- **The guild model** — Operators learn through practice (start with a birthday party, scale to a community node). The architecture produces apprenticeship naturally.
- **Accountability** — An operator is a known entity in the trust graph. Not anonymous. Not a platform. A person with skin in the game.

**The principle:** AI made the *how* trivial. The *who* and *why* still matter. That's the operator.

**Key essays:** 6 (The Guild), 9 (The Practice)

---

## 6. .fair

*How attribution works.*

TODO: Attribution infrastructure. A .fair manifest is a cryptographically signed record embedded in the work itself, carrying the complete chain of human creative labor.

- **The problem it solves** — You can't fix distribution without fixing attribution first. Every industry in Part IV has the same disease: the attribution chain collapsed, and the money flows to whoever captured the pipe instead of whoever created the value.
- **Immutable** — Once signed, the chain can't be altered. Every contributor is permanent.
- **Owned by nobody** — The manifest lives in the work, not on a platform. No one controls it. Anyone can verify it.
- **Inspired by WeR1** — A distribution algorithm from Johannesburg that proved money can find the artist directly, in real time, with proportional attribution. .fair completes what WeR1 started.

**The principle:** Every piece of work carries its own provenance. The chain of human labor is the work's birth certificate.

**Key essays:** 14 (Honor the Chain), 18 (How to Save the Music Industry)

---

## 7. The Settlement Layer

*How money moves.*

TODO: Direct settlement between participants. No platform in the middle taking 30%. When you pay for something on the network, the money flows through the .fair chain to every contributor, proportionally, in real time.

- **Revenue from transaction one** — No critical mass required. The first transaction settles correctly. The economics work at any scale.
- **Pluggable** — Stripe today, Solana tomorrow. The settlement layer is an interface, not a vendor.
- **The receipt** — Full transparency on every transaction. You see exactly where your money went and who it reached.

**The principle:** Money follows the attribution chain. If you're in the chain, you get paid. If you're not, you don't.

**Key essays:** 8 (The Ticket Is the Trust), 23 (The Business Case)

---

## 8. MJN

*What the token does.*

TODO: MJN is the rewards substrate for the network. Not a payment token — the settlement layer handles payments in fiat or stablecoin. MJN is what you earn for operating infrastructure, contributing value, and participating in the trust graph.

- **Not speculative** — No ICO. No presale. Hardware first, utility second, token third (Year 3). The token represents actual participation, not theoretical value.
- **Minted, not mined** — Supply is controlled. Mint authority is held by the network, not a VC.
- **The burn** — TODO: tokenomics

**The principle:** The token measures participation, not speculation. You earn it by doing things that matter.

**Key essays:** 23 (The Business Case)

---

## 9. The Consumer Model

*But how the fuck are we going to make money?*

TODO: This is the piece that makes everything above economically real. The consumer isn't a product to be sold — they're a participant whose presence injects currency into the system.

- **The toggle** — Ads on = free access. Ads off = pay direct. Your choice. Both are valid. Both generate revenue.
- **The receipt** — Full transparency. When you participate (either mode), you see exactly what your presence generated, where it went, who it reached.
- **Two streams, one truth** — The ad-supported stream produces behavioral data. The direct-pay stream produces economic data. Each validates the other. Together they're more accurate than surveillance ever was.
- **Verified humans** — You're not an eyeball. You're a verified identity in a trust graph, selling access to yourself on your own terms, at your own price. The advertiser pays *you*, not the platform, for your attention.
- **The platform earns by routing, not capturing** — Platforms become headless services. They make more money because the market for their actual computation is vastly larger than the market for their enclosed platform.
- **Why it works at scale** — Every consumer who turns on their profile creates demand for every layer above: nodes to host them, operators to run them, .fair chains to attribute them, settlement to pay them, MJN to reward them. The consumer is the engine. Everything else is the drivetrain.

**The principle:** The consumer isn't the product. The consumer is the economy. Their participation — on their terms — is what funds the entire network.

**Key essays:** 5 (You Don't Need Ads), 19 (How to Save the Ad Industry), 20 (How to Save the Platforms), 24 (Revenue from Day One)

---

## 10. Redistribution

*Where the money goes after it flows.*

TODO: The knowledge economy will concentrate currency toward the top of the chain. That's not a bug — domain experts *should* earn outsized returns. The question is what happens next.

On the current internet, concentration is invisible. You can't see where a creator's money goes after they earn it. On this network, every participant has a distribution chain — a visible, inspectable record of where their earnings flow. Who they support. What causes they fund. Which businesses they route through.

- **Transparent chains** — When you query a knowledge leader, you're not just paying for their expertise. You're funding their entire distribution chain. If that chain supports environmental causes, local initiatives, and friends — your money compounds those values. If it's full of obfuscated business entities and offshore shells, that's a red flag you can actually *see*.
- **Compounding values** — Consumers don't just choose who to pay. They choose whose *values* to amplify. Every query is a vote for an entire chain of downstream effects. This compounds. A knowledge leader who routes earnings into their community attracts more queries from people who share those values.
- **Natural redistribution** — No taxation. No forced redistribution. Just transparency. When people can see where money flows after it reaches someone, they route toward chains that reflect their values. Redistribution becomes a market signal, not a policy debate.
- **The accountability loop** — Concentration without transparency produces oligarchs. Concentration with transparency produces leaders. The distribution chain is what turns one into the other.

**The principle:** It's not about preventing concentration. It's about making concentration accountable. When every dollar's downstream journey is visible, people vote with their queries. Redistribution stops being politics and starts being architecture.

**Key essays:** 4 (The Internet That Pays You Back), 14 (Honor the Chain), 27 (Around, Not Up)

---

## Concept Dependencies

```
The Problem
    └── Sovereign Identity
            └── The Trust Graph
                    ├── The Node
                    │       └── The Operator
                    └── .fair
                            └── The Settlement Layer
                                    └── MJN
                                            └── The Consumer Model
                                                    └── Redistribution
```

Everything flows down. You can't understand redistribution without the consumer model. You can't understand the consumer model without the settlement layer. You can't understand settlement without .fair. And none of it matters without sovereign identity.

The consumer model answers "how does this make money." Redistribution answers "where does the money go." And the answer is: wherever the chain says, visibly, inspectably, accountably. Concentration isn't the enemy. Opacity is.

---

*This document is the source of truth. When concepts evolve, update here first. Essays reference this; this doesn't reference essays.*
