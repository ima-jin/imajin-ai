# What is Imajin

Imajin is a composable agent layer. Identity, delegation, attestation, and settlement — the infrastructure that any agent runtime composes on top of.

It's not a platform. It's not an agent framework. It's the layer underneath both.

---

## The Problem

Every agent framework solves capability. Give the LLM tools, let it reason, execute steps. That part works. What doesn't work:

- **Identity.** Who is this agent? Who authorized it? How do you tell it apart from a million copies of itself?
- **Accountability.** What did this agent do? Can you prove it? Can you replay the whole sequence?
- **Delegation.** What is this agent allowed to do? Who set those boundaries? Can they be revoked?
- **Settlement.** The agent bought something. Who gets paid? How do you split revenue when five parties contributed?
- **Trust.** This agent says it completed 10,000 transactions. Can you verify that without trusting a centralized reputation API?

These aren't agent problems. They're coordination problems. And they're the same problems whether your agent runs in OpenClaw, Flue, n8n, LangGraph, or a bash script.

## What the Layer Provides

**DIDs (Decentralized Identifiers)**
Every agent gets an Ed25519 keypair. The public key derives a DID — a stable, self-sovereign identifier that nobody can revoke. The same keypair is a valid Solana wallet. No bridging needed.

**Grant Sets**
What an agent can do, expressed as a permission structure. Observer → Assistant → Operator → Transactor. The owner (a human DID) configures grants. The kernel enforces them on every tool call.

**Delegation Chains**
Cryptographic proof that agent X is authorized by human Y to do Z. Every tool call carries the chain. The kernel validates it before execution.

**.fair Attribution**
A JSON sidecar format that says who contributed to something and how value splits. When an agent generates revenue, the .fair manifest determines who gets paid — including the agent's operator, the platform, and any upstream contributors.

**Append-Only Chains**
Every action produces a signed chain entry. The chain is the agent's history — its résumé. You can replay any session, audit any decision, verify any claim. It's not a feature; it's a consequence of signing everything.

**Settlement**
Payments flow through the layer. Stripe today, Solana later. Every transaction references a .fair manifest. The protocol verifies signatures before moving money.

## What the Layer Does NOT Provide

- **Inference.** Imajin doesn't run your model. That's your runtime's job.
- **Sandbox.** Where the agent executes is a runtime concern. Imajin provides the interface the sandbox connects through.
- **UI.** No chat interface, no dashboard (beyond admin tooling). Your runtime owns the user experience.
- **Orchestration.** Fan-out, sequential chains, adversarial review — those are coordination patterns your runtime implements. Imajin provides the signed communication channel they run over.

## Why a Layer, Not a Platform

Platforms capture. Layers compose.

A platform says: run your agent here, use our tools, store data in our cloud, pay through our system. Leave and you lose everything.

A layer says: bring your own runtime, your own model, your own hosting. We handle identity, delegation, attribution, and settlement. Your agent keeps its DID and its chain history regardless of where it runs.

The forward-deployed engineer's version: **Imajin is to agent identity what Stripe is to payments.** You don't build Stripe yourself. You don't want to. You wire it in underneath what you already have.

Except unlike Stripe, the keys are yours. The data is yours. The chain is yours. You can self-host the entire thing.

## The Antithesis

Palantir harvests identity to create intelligence. Imajin gives identity back so intelligence can be accountable.

Every agent on Imajin traces back to a human DID. The human sets scope, defines .fair splits, mediates disputes, grants and revokes consent. Agents execute. Humans govern. The protocol enforces the distinction — not through policy, but through math.

In a world where agents outnumber humans on every network, the systems that can't distinguish human judgment from machine execution will drown. Imajin makes the distinction structural.

---

## Quick Orientation

| You want to... | Start here |
|----------------|-----------|
| Understand the core concepts | [Core Concepts](./core-concepts.md) |
| Connect an agent to Imajin | [Getting Started](./getting-started.md) |
| Learn the ImajinAgentEnv interface | [The Interface](./the-interface.md) |
| Build an adapter for your platform | [Adapters](./adapters.md) |
| Wire Imajin into a specific runtime | [Integration Guides](./integration-guides.md) |
| See working examples | [Examples](./examples.md) |
| Use the HTTP APIs directly | [Developer Guide](../developer-guide.md) |

---

*Imajin is open source. The reference implementation runs at [jin.imajin.ai](https://jin.imajin.ai). Source: [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)*
