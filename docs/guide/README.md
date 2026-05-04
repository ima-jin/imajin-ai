# Imajin Developer Guide

**The composable agent layer.** Identity, delegation, attestation, and settlement — the infrastructure any agent runtime composes on top of.

---

## The Layer Cake

| # | Doc | What You'll Learn |
|---|-----|-------------------|
| 1 | [What is Imajin](./what-is-imajin.md) | What the layer provides, what it doesn't, why a layer instead of a platform |
| 2 | [Core Concepts](./core-concepts.md) | DIDs, delegation chains, attestations, .fair attribution, the chain, progressive trust |
| 3 | [Getting Started](./getting-started.md) | Generate keys, register a DID, authenticate, make your first tool call |
| 4 | [The Interface: ImajinAgentEnv](./the-interface.md) | The universal contract — tool surface, workspace, session, events, wire protocol |
| 5 | [Adapters](./adapters.md) | Build connectors for external platforms with credential isolation + .fair attribution |
| 6 | [Integration Guides](./integration-guides.md) | Wire Imajin into OpenClaw, Flue, n8n, or custom TypeScript |
| 7 | [Examples](./examples.md) | Travel agent, commerce agent, support agent, insurance agent — real patterns |

## Who This Is For

**The forward-deployed engineer.** Someone who walks into a business with six platforms that don't talk to each other and needs to unify identity, data, and agents across all of them. You don't want to rip and replace — you want to wire Imajin in underneath what already exists.

**How to make your own data the source of truth without replacing anything you already use.**

## Quick Links

- **HTTP API reference:** [Developer Guide](../developer-guide.md) (curl-based walkthrough)
- **Protocol RFCs:** [docs/rfcs/](../rfcs/) (the "why" behind decisions)
- **Source code:** [github.com/ima-jin/imajin-ai](https://github.com/ima-jin/imajin-ai)
- **.fair spec:** [github.com/ima-jin/.fair](https://github.com/ima-jin/.fair)
- **OpenAPI specs:** `https://<service>.imajin.ai/api/spec`

---

*Imajin is open source. The reference implementation runs at [jin.imajin.ai](https://jin.imajin.ai).*
