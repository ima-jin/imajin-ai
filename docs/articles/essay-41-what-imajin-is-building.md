---
title: "What Imajin Is Building"
subtitle: "A social governance layer on the DFOS substrate"
description: "DFOS gives you the keys. Imajin gives you the room. What we're building on the protocol, why it needs to exist, and an invitation to build with us."
date: "2026-04-25"
author: "Ryan Veteze"
status: "DRAFT"
type: "essay"
---

## The Substrate

DFOS is a protocol. It gives you self-certifying identity, content-addressed commitments, verifiable proofs, and a relay network that distributes them without trust. Ed25519 keys. Signed chains. Offline verification. The proof surface is public; the content surface is private. Five language implementations running against the same deterministic test vectors.

That's the substrate. The wire. The cryptographic plumbing that makes sovereign identity possible.

It is, deliberately, not a social protocol. No federation model. No feeds. No application semantics. Brandon built it that way because the protocol should outlive whatever anyone builds on top of it. The chains don't care if you're running a social network, a travel agency, or a lemonade stand. They verify the same way.

This is correct. This is the right architecture. And it creates a gap that someone has to fill.

Because chains don't know what a community is. DIDs don't know who trusts whom. Content-addressed hashes don't know who gets paid. Credentials prove delegation — they don't prove that the person you delegated to is worth trusting with your room.

The protocol gives you the keys. Someone has to build the room.

---

## The Gap

Here's what exists at the protocol layer: you can create an identity. You can sign content. You can delegate access via credentials. You can prove authorship without revealing what you authored. You can run a relay and peer with others. All of this is real, shipping, tested.

Here's what doesn't exist at the protocol layer, because it shouldn't:

**Who trusts whom.** The protocol proves cryptographic delegation. It doesn't model social trust — the kind where you vouch for someone and your reputation is on the line. Progressive trust. Earned standing. The graph of "I'll put my name next to yours."

**Who gets paid.** A signed chain can prove you authored something. It can't split the revenue between the DJ who played the set, the venue that held the room, the promoter who filled it, and the network that routed the transaction. Attribution and settlement are social problems with economic consequences.

**Who governs the space.** Credentials can scope access. They can't define what kind of room it is. Whether this is a community or a business. Whether membership is open or curated. What happens when someone violates the norms. Governance is human, not cryptographic.

**What the economics are.** The protocol has no opinion on fees. On who earns what from which transaction. On whether the person who built the app keeps 95% or 70% or 30%. That's a design decision. Someone has to make it, and the architecture of how they make it determines whether this ends up free or captured.

These aren't missing features. They're a different layer. The protocol is the substrate. What I'm describing is the social governance layer that sits on top of it.

That's what Imajin is building.

---

## Layers 6, 7, 8

The DFOS substrate is Layers 0 through 5. Ed25519, CID, dag-cbor, countersignatures. Signed chains, relay distribution, credential delegation, peering. The cryptographic foundation. Specified, tested, deterministic.

Imajin is what sits on top. Not one layer — three. Each with its own replacement boundary. Each disposable independently. We call it JBOS — Just a Bunch of Services. Here's the stack:

```
JBOS (Just a Bunch Of Services)

┌─────────────────────────────────────────────┐
│ www · events · chat · learn · market        │  ← Userspace     (Layer 8)
│ coffee · links · dykil · input · media      │    (disposable)
├─────────────────────────────────────────────┤
│ connections · profile · registry            │  ← Trust +       (Layer 7)
│                                             │    Discovery
├─────────────────────────────────────────────┤
│ auth · pay · attestations                   │  ← Kernel        (Layer 6)
│ .fair manifests · settlement                │    (signed chains)
├─────────────────────────────────────────────┤
│ DFOS Proof Chains (L0–L5)                   │  ← Substrate
│ Ed25519 · CID · dag-cbor · countersignatures│    (cryptographic)
└─────────────────────────────────────────────┘
```

No inter-service trust assumptions. Services verify chains, not each other. Any service can be replaced without affecting others. New services inherit the full trust graph and identity system by importing `@imajin/auth`. The complexity lives in the chain layer, not the orchestration layer. Runs on a single server with pm2. No Kubernetes. No Docker in production.

**Layer 6: Kernel (signed chains).** Auth, pay, attestations, .fair manifests, settlement. This is where DFOS chains get economic and social meaning. A DID becomes an identity with scope — actor, family, community, business — and subtype — human, agent, device, café, venue. A content chain becomes an attestation with legal weight. A transaction becomes a .fair manifest: who contributed, who gets paid, what percentage. Three cascade layers — explicit, inherited, default. Fees separated from revenue shares. The chain records it. The settlement engine executes it. The receipt is a signed artifact on DFOS.

**Layer 7: Trust + Discovery.** Connections, profile, registry. This is where DIDs become people with standing. Progressive trust — soft → preliminary → established — earned through history, through the chain itself. The social graph is legible, auditable, and rooted in cryptographic proof. Nobody edits your reputation after the fact. Federation lives here: nodes peer with each other, your identity works across nodes because the DID is yours, not the node's. Operator accountability lives here: a named person with standing that can be damaged, who vouches for members and curates the room.

**Layer 8: Userspace (disposable).** Events, chat, market, learn, coffee, links — the apps people actually use. Each one is a federated service registered via cryptographic handshake. Each one inherits identity, trust, attribution, and settlement from the layers below. Each one is replaceable. If you don't like our events app, build a better one. Plug it in. The governance layer doesn't change. Your identity doesn't change. Your .fair manifests don't change.

Agent coordination spans all three layers. AI agents get DIDs (Layer 6), build trust through their chains (Layer 7), and operate inside apps with delegated sessions (Layer 8). Every action is signed, auditable, replayable. The agent builds a résumé through its chain — a history that can't be faked.

---

## The App Store Inversion

Here's a concrete example of why the governance layer matters.

Apple's App Store takes 30% of every transaction. The developer gets 70%. Apple decides the split. Non-negotiable. You can't leave because the customer is in their store and the only door is theirs.

On Imajin, the seller sets the split.

The protocol floor is 2%. That's four layers: 1% to the network (MJN), 0.5% to the node operator, 0.25% as buyer credit, 0.25% as scope fee. Everything above that is the seller's decision. The app builder keeps 98%.

Not 70%. Not whatever the platform decides to show you after their cut. 98%.

And the scope fee — that 0.25% — goes to whoever's room the transaction happens in. The community. The venue. The operator. Set by the seller, recorded in the .fair manifest, settled automatically.

This isn't generosity. It's architecture. The governance layer is designed so that the people who build things and the people who create the rooms keep almost everything. The network earns 1% because 1% of a growing network where everyone stays is worth more than 30% of a network people are trying to escape.

The moat isn't lock-in. The moat is legitimacy. If someone builds a better Layer 6, you can leave. Your DID goes with you. Your chain goes with you. Your .fair manifests are portable. That's not a bug — it's the structural guarantee that keeps the governance layer honest.

---

## What Already Exists

This isn't a whitepaper. The infrastructure is running.

135,000 lines of code. 1,750+ commits. 15 live services sharing 18 packages. One kernel, six federated apps. DFOS relay passing 106 out of 106 conformance tests, peered in a four-node mesh.

Real identities. Real transactions. Real trust graph. Real .fair settlement with real money moving through Stripe to real people.

An AI agent — Jin — with its own DID, its own Ed25519 keypair, its own chain. First agent identity on the network. Registered, delegated, auditable.

The Muskoka pilot launches this summer: 500+ real-world identities, NFC tags on businesses, an entire local economy running on sovereign infrastructure. Gift cards that are MJNx on-ramps. Progressive identity — anonymous → email → full account — without anyone having to understand cryptography.

It works. It's shipping. It's open source.

---

## The Invitation

DFOS is the substrate. Imajin is one governance layer on that substrate. It doesn't have to be the only one.

If you want to build a different Layer 6 — different governance model, different economics, different trust assumptions — the substrate supports it. The protocol doesn't privilege our layer. The chains verify the same way regardless of what you build on top.

If you want to build a Layer 7 app — something that plugs into our governance layer and inherits the identity model, the trust graph, the .fair attribution, the settlement engine — that's what the kernel is for. Register your app via cryptographic handshake. Get a delegated session. Render inside the shell. Keep 98% of whatever you charge.

Travel agencies. Event platforms. Learning systems. Marketplaces. Fundraising apps. Creative tools. Agent coordinators. Anything that needs identity, trust, attribution, and settlement without building it from scratch.

Come build on the substrate. Come build on our layer. Come build your own.

Free. Open. Sovereign.

*— Ryan VETEZE aka b0b*

---

**The network:** [jin.imajin.ai](https://jin.imajin.ai)
**The protocol:** [protocol.dfos.com](https://protocol.dfos.com)
**The code:** [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
**The operator essay:** [Essay 6 — The Guild](https://www.imajin.ai/articles/the-guild)
