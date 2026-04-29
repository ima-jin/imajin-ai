---
title: What Imajin Is Building
type: essay
status: draft
author: Ryan Veteze
slug: essay-41-what-imajin-is-building
topics:
  - dfos
  - sovereignty
refs:
  essays:
    - the-guild
subtitle: A social governance layer on the DFOS substrate
description: >-
  DFOS gives you the keys. Imajin gives you the room. What we're building on the
  protocol, why it needs to exist, and an invitation to build with us.
---
## The Substrate

DFOS is a protocol. It gives you self-certifying identity, content-addressed commitments, verifiable proofs, and a relay network that distributes them without trust. Ed25519 keys. Signed chains. Offline verification. The proof surface is public; the content surface is private. Five language implementations running against the same deterministic test vectors.

That's the substrate. Deliberately not a social protocol. No federation model. No feeds. No application semantics. The chains don't care if you're running a social network, a travel agency, or a lemonade stand. They verify the same way.

But chains don't know what a community is. DIDs don't know who trusts whom. Content-addressed hashes don't know who gets paid.

The protocol gives you the keys. Someone has to build the room.

---

## The Gap

**Social trust.** The protocol proves cryptographic delegation. It doesn't model the kind of trust where you vouch for someone and your reputation is on the line. Progressive trust. Earned standing. That's a human problem.

**Economics.** A signed chain can prove you authored something. It can't split the revenue between the DJ, the venue, the promoter, and the network. It has no opinion on whether the app builder keeps 95% or 30%. Someone has to make that decision, and the architecture of how they make it determines whether this ends up free or captured.

These aren't missing features. They're a different layer.

That's what Imajin is building.

---

## Layers 6, 7, 8

DFOS is Layers 0 through 5. Imajin is what sits on top. Not one layer — three. Each disposable independently:

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

Services verify chains, not each other. Any service can be replaced without affecting others. Runs on a single server. No Kubernetes. No Docker in production.

**Layer 6: Kernel.** Auth, pay, attestations, .fair manifests, settlement. Where DFOS chains get economic and social meaning. A DID becomes an identity with scope and subtype. A transaction becomes a .fair manifest — who contributed, who gets paid, what percentage — settled automatically, receipted on-chain.

**Layer 7: Trust + Discovery.** Connections, profile, registry. Where DIDs become people with standing. Progressive trust — soft → preliminary → established — earned through history. Federation lives here. Operator accountability lives here.

**Layer 8: Userspace.** Events, chat, market, learn — the apps people use. Each registered via cryptographic handshake. Each replaceable. Don't like our events app? Build a better one. The governance layer doesn't change.

Agents span all three. DIDs at Layer 6, trust at Layer 7, delegated sessions at Layer 8. Every action signed. The chain is the résumé.

---

## The App Store Inversion

Apple takes 30%. Non-negotiable. You can't leave because the customer is in their store.

On Imajin, the seller sets the split. The protocol floor is 2% — 1% network, 0.5% node, 0.25% buyer credit, 0.25% scope fee. The app builder keeps 98%.

This isn't generosity. It's architecture. 1% of a growing network where everyone stays is worth more than 30% of a network people are trying to escape.

If someone builds a better governance layer, you can leave. Your DID, your chain, your .fair manifests — portable. That's what keeps it honest.

---

## What Already Exists

135,000 lines of code. 1,750+ commits. DFOS relay passing 106/106 conformance tests, four-node mesh across three continents. Real identities. Real transactions. Real .fair settlement with real money moving to real people.

An AI agent — Jin — with its own DID, its own keypair, its own chain. First agent on the network.

Muskoka launches this summer: 500+ real-world identities, NFC tags on businesses, an entire local economy on sovereign infrastructure. Progressive identity — anonymous → email → full account — without anyone having to understand cryptography.

Not a whitepaper. Open source. Shipping.

---

## The Invitation

Imajin is one governance layer on the DFOS substrate. It doesn't have to be the only one.

Build a different Layer 6 — the substrate supports it. Build an app on ours — register via cryptographic handshake, keep 98%. Build your own.

Anything that needs identity, trust, attribution, and settlement without building it from scratch.

Free. Open. Sovereign.

*— Ryan VETEZE aka b0b*

---

**The network:** [jin.imajin.ai](https://jin.imajin.ai)
**The protocol:** [protocol.dfos.com](https://protocol.dfos.com)
**The code:** [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
**The operator essay:** [Essay 6 — The Guild](https://www.imajin.ai/articles/the-guild)
