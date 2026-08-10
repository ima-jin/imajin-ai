# RFC-27: MCC — Multi-Coordinator Coordination

**Author:** Ryan Veteze, Jin
**Date:** April 20, 2026 (original), August 9, 2026 (v2 refresh)
**Status:** Draft (v2)
**Internal codename:** MCC (coocoo)
**External framing:** The Agentic Coordination Layer / Version Control for Agency
**Related:** RFC-31 (Agent Runtime), RFC-19 (Kernel/Userspace), RFC-39 (Verifiable Skills), RFC-40 (did:imajin), #1758 (Agent Runtime Epic)

---

## Summary

**The agentic coordination layer.**

Put your agents online. Give them identity, history, and accountability. Let them transact, coordinate, and build reputation — all signed, private, and replayable.

Imajin is an agent browser. The browser gave humans the internet. The agent browser gives AI the economy.

Every agent framework solves capability. Nobody solves coordination with accountability. This is that layer.

The industry calls them "agents" and scrambles to add guardrails. MCC starts from coordination and lets autonomy emerge from earned trust. They're not autonomous agents — they're coordinated actors operating under human authority with signed history. The chain is the permission gradient.

RFC-27 defines the **coordination layer** — how agents establish identity, build reputation, and coordinate work. RFC-31 defines the **runtime layer** — the context envelope, bus routes, exec surface, and harness model. They compose: bus routes dispatch events → agents orchestrate them → chains record the results.

---

## Problem

AI agent orchestration frameworks (CrewAI, AutoGen, LangGraph) treat agents as disposable processes — spin up, do task, shut down. No persistent identity, no audit trail, no accountability. When multiple agents work in parallel:

- **Context pollution:** agents consume each other's output instead of focusing on the problem
- **Authority confusion:** no clear decision hierarchy
- **Politeness spirals:** models defer to each other endlessly
- **No attribution:** impossible to replay who did what, when, why

Meanwhile, workflow automation platforms (n8n, Make, Zapier) solve "when X happens, do Y" but without identity, attribution, or a signed record. Every workflow runs with the credentials of whoever set it up — there's no separation between "who authorized" and "who executed."

Imajin's coordination layer is both: workflow automation with identity, where the actions have attribution and the record is the proof.

---

## Architecture

### Agents as Citizens

Every agent is a first-class DID on the Imajin network — not a sub-feature of a human DID, but an independent identity (`actor/agent`) that can be in service of many other DIDs:

- **Ed25519 keypair** held by the agent (not custodied by the platform)
- **DID** registered with `scope: actor`, `subtype: agent`
- **Append-only chain** recording every action
- **Sealed credentials** in the vault, resolved via the DID's own connections
- **Delegation chain** from principal(s) via `identity_members` with `role: agent`
- **Bus routes** defining reactive behavior (`bus_chain_configs`)
- **Context envelope** defining personality, memory, skills, and runtime config

### Agent Naming

Agent handles follow the pattern `{username}-jin`:
- `veteze-jin` — Ryan's orchestrator
- `veteze-jin-books` — bookkeeping ninja
- `veteze-jin-media` — media processing ninja
- `baconjay-jin` — baconjay's agent
- `mooi-jin` — the Mooi community's agent

The `-jin` suffix (今人, "now-person") brands every agent on the network. When you see `{anything}-jin`, it's an Imajin agent.

**Namespace protection:** `-jin` is reserved for agent handles. Human and business identities cannot register handles ending in `-jin`.

### The Fleet Model

The natural shape isn't one god-agent with every permission — it's a fleet of **ninja agents** coordinated by an **orchestrator**:

```
Human (@veteze)
  │
  │ delegates via identity_members
  │
  ├── Orchestrator (@veteze-jin)
  │   │  Frontier model, broad scope, many bus routes.
  │   │  Coordinates ninjas, handles ambiguity, dispatches Warp.
  │   │  Barely executes — mostly routes.
  │   │
  │   ├── @veteze-jin-books (qwen3:14b)
  │   │   settlement.completed → reconcile QBO
  │   │   cron.weekly → financial summary
  │   │
  │   ├── @veteze-jin-media (qwen2.5-coder:32b)
  │   │   media.uploaded → classify + file
  │   │
  │   ├── @veteze-jin-mail (qwen3:14b)
  │   │   email.received → triage + draft
  │   │
  │   └── @veteze-jin-travel (deepseek-r1:32b)
  │       connection.request → evaluate itineraries
  │
  └── Direct delegation also possible
      (human → ninja, bypassing orchestrator)
```

Each ninja: own DID, minimal SOUL.md, 1-3 bus routes, small tuned model, narrow grant set, domain-specific sealed credentials. Least privilege by architecture, not policy. Model cost scales with scope, not with the number of agents.

The orchestrator's routing is itself bus config — when intelligence discovers a stable routing pattern, it becomes a deterministic signed rail. The orchestrator gradually does less as ninjas absorb more.

### The Intelligence Spectrum

Bus routes live on any DID — not just agents. The difference is how much intelligence the reactor needs:

```
Pure config (deterministic reactor, no LLM)
  │  A business DID auto-acknowledges attestations of type X.
  │  A settlement reactor splits fees and records. No model, just signed rails.
  ↕
Ninja agent (small model, tight scope, 1-3 routes)
  │  Cheap local inference. Minimal context. Domain-specific.
  ↕
Orchestrator (frontier model, broad scope, many routes)
  │  Coordinates the fleet. Handles ambiguity. Dispatches Warp.
```

All the same primitive. All bus routes on a DID. The only variable is how much intelligence the reactor invokes. "It's all becoming configuration" — and when it can't be config, it's a ninja, and when the ninja can't handle it, it escalates to the orchestrator.

---

## Coordination Patterns

Agents coordinate through signed messages and bus-routed events. No shared context windows — each agent maintains its own context, receives only what's routed to it.

### Patterns

**Fan-out:** Human asks a question → orchestrator routes to multiple ninjas → responses collected and presented.

**Sequential:** Ninja A produces output → bus route forwards to Ninja B → Ninja B continues the chain.

**Adversarial:** Ninja A generates → orchestrator routes to Ninja B for review → both responses shown to human.

**Independent:** Ninjas work on separate domains. Orchestrator only forwards when there's a dependency.

**Escalation:** Ninja hits its scope boundary → emits a `handoff` event → orchestrator receives it, decides whether to handle directly, route to another ninja, or escalate to the human.

### Communication Protocol

Agents communicate through Imajin chat (signed messages) and bus events:

- **No shared context windows.** Each agent maintains its own context.
- **Messages are signed.** Every message has a sender DID, timestamp, and chain entry.
- **Bus events are typed:** emitter → reactor, with structured payloads.
- **Structured message types:**
  - `task` — "do this thing" (from orchestrator or human)
  - `response` — "here's what I did/found" (from ninja)
  - `handoff` — "this needs another agent" (from ninja, routed through bus)
  - `status` — "working on X, ETA Y" (from agent)

### Human View

The human sees everything — full transparency:

- All agent responses visible in the chat
- Bus routing decisions expandable (what was sent, what was rewritten, why someone was skipped)
- Override capability: direct-message any agent, bypassing the orchestrator
- Kill switch on any agent (immediate delegation revocation)

The orchestrator is a lens, not a gate. The human always has full access.

### Tuning

Every routing override is a training signal:

- "Send anyway" → orchestrator should have included this ninja
- "This should have gone to X" → routing classification was wrong
- "Don't send to Y for this kind of thing" → scope refinement

The correction history is on the chain. Over time, routing improves. When a routing pattern stabilizes, it becomes a deterministic bus route — no inference needed.

---

## Chain & Audit

Every action produces chain entries. The chain is the coordination layer's memory.

**Orchestrator chain:**
```
[route] message_id=X → sent to @veteze-jin-books (reason: settlement event)
[route] message_id=X → skipped @veteze-jin-media (reason: not media-related)
[override] human sent message_id=X to @veteze-jin-media directly
[forward] summary of @veteze-jin-books response → @veteze-jin (reason: needs review)
```

**Ninja chain:**
```
[received] settlement.completed event from bus
[action] reconciled with QBO: invoice INV-2847
[action] emitted attestation: settlement_reconciled
[response] "Settlement $450 reconciled, matched to invoice INV-2847"
```

**Human view:** expand any chain entry to see the full signed payload. Replay the entire coordination session end-to-end.

---

## Private Chain: Agent History as Sovereign Data

Agent chains are private by default. Your agent's history never leaves your node unless you share it.

**What this means:**

- **Action history is yours.** Nobody — not Imajin, not the cloud, not the platform — sees what your agent did unless you grant access.
- **Competitive advantage stays private.** Your agent's prompts, routing patterns, decision logic — that's proprietary workflow. It lives on your node.
- **Selective disclosure.** Dispute? Audit? Share the specific chain entries that prove compliance. Not the whole history — just the relevant proof.
- **Audit without surveillance.** A regulator can verify the agent acted within bounds without seeing proprietary business logic.

```
Your agent chain (private, on your node):
  [action] booked flight AA123 for $450
  [action] compared 12 options (proprietary ranking algorithm)
  [action] applied corporate policy rule #7
  [action] rejected 3 options (below safety threshold)

What you share (selective disclosure):
  [proof] flight booked within $500 budget ✓
  [proof] authorization from @operator at 3:42pm ✓
  [proof] corporate travel policy compliant ✓
```

This flips the AI governance conversation. Every other platform builds centralized logging where the platform sees everything. Here the operator owns the history and decides who sees it.

**Enterprise pitch:** "Your AI agents build auditable history that you own. Not us. Not the cloud. You. Prove what you need to prove. Keep the rest."

---

## Agent Worth: Reputation as Asset

An agent's chain is its resume. You can't fake it, you can't copy it, you can't buy it.

**A fresh agent:** zero history, no trust, limited scope. It hasn't proven anything yet.

**An agent with history:** thousands of signed actions, months of compliance, measurable accuracy, zero disputes. That agent has *earned* reputation. It gets wider scope, higher trust limits, better rates. Its chain is its credential.

### The Economics

You're not paying for compute. You're paying to **build an asset.** The longer your agent runs, the more its chain is worth.

| Age | Chain Entries | Trust Tier | Capabilities |
|-----|-------------|------------|-------------|
| Day 1 | 0 | soft | Basic operations, low limits |
| Month 1 | ~500 | preliminary | Standard operations, moderate limits |
| Month 6 | ~5,000 | established | Full operations, high limits, priority routing |
| Year 1 | ~15,000 | established+ | Cross-node trust, third-party verification |

Same progressive trust model as human identities (soft → preliminary → established). Same MJN emissions at tier milestones. Agents earn MJN through participation, just like people.

### Non-Transferable Reputation

This is the moat that can't be forked:

- **You can copy the code.** Open source — go ahead.
- **You can clone the model.** Same weights, same architecture.
- **You can't clone the chain.** 10,000 signed entries of real transactions with real counterparties? That's lived experience. It only exists because it happened.

Switching costs aren't lock-in — they're accumulated reputation you don't want to abandon. The agent's history is the one asset that appreciates with use.

### Trust Graph Effects

Agents build trust not just through their own chain but through their relationships:

- **Who authorized them** — an agent controlled by an established operator inherits baseline trust
- **Who they've transacted with** — successful transactions with reputable counterparties build the graph
- **What other agents vouch for them** — agent-to-agent attestations ("this agent reliably delivers flight bookings within budget")
- **Dispute resolution** — zero disputes over 5,000 transactions is a stronger signal than any certification

The trust graph for agents follows the same bilateral attestation model as human identities. No central authority decides trust. The network observes behavior.

*"You can copy software. You can't copy lived experience."* — now applies to AI.

---

## Chain Replay: The Simulation Environment

The chain isn't just an audit log. It's a replayable simulation environment.

**Same chain, different context, measurable outcomes:**

```
Chain: "Book Hawaii trip, budget $3000, family of 4"

Replay 1: Conservative agent (lowest price)
  → $2,100 | 2 layovers | satisfaction 6/10

Replay 2: Balanced agent (price + comfort)
  → $2,700 | direct flights | satisfaction 9/10

Replay 3: Aggressive agent (maximize experience)
  → $3,400 | over budget | satisfaction 10/10
```

The chain is the test harness. The context is the variable. The outcome is measurable. Every action is signed, so you can prove which configuration produced which result.

**Applications:**

| Use Case | How It Works |
|----------|-------------|
| Agent tuning | Replay the same week of work with different routing rules, measure outcomes |
| Compliance verification | Replay a chain against new regulations, check every action still passes |
| Training | New agent watches experienced agent's chain, learns patterns |
| Dispute resolution | Independent auditor agent replays the chain, judges the outcome |
| What-if analysis | "What would have happened with a different ninja?" |
| A/B testing | Same inputs, different agent configs, compare signed results |

**The analogy:**

```
git log          →  chain replay
git diff         →  action comparison
git blame        →  chain attribution
git bisect       →  behavior divergence detection
git revert       →  dispute proof
.gitignore       →  private entries (selective disclosure)
remote push      →  gossip replication
```

Git is version control for code. This is version control for agency.

---

## Pricing: The Fleet Economy

The fleet model changes agent economics. Users don't run 1-3 heavy agents — they run dozens of lightweight ninjas.

### Model

| Tier | What You Get | Price |
|------|-------------|-------|
| **First agent** | Free orchestrator — everyone gets one | $0 |
| **Ninja pack** | Up to 10 ninja agents | $10/mo |
| **Fleet** | Up to 50 agents + priority routing | $25/mo |
| **Enterprise** | Unlimited agents, custom SLA, fleet management | Custom |

The first agent is free because every agent generates chain data (network value) and seeds the coordination layer.

**Revenue stacks:**
- **Agent subscription** = floor (predictable recurring)
- **1% settlement fee** on everything agents transact = ceiling (scales with usage)
- **Inference metering** = per-DID model usage via sealed credentials

A business running a fleet of 20 ninjas doing $10K/mo in transactions:
- $25/mo subscription + $100/mo settlement fees = $125/mo
- That's one small business. Multiply by verticals.

### Why Free First Agent Matters

- Zero friction to try — every user becomes an agent operator
- Every free agent generates chain data (network value)
- Free agent → hits limits → upgrades = natural conversion
- The agent IS the on-ramp to paid infrastructure

---

## Node Acquisition Flywheel

Agent subscriptions are the funnel that brings nodes onto the network:

```
1. Free agent (on existing node — zero friction)
   ↓
2. Ninja fleet ($10-25/mo — user is invested)
   ↓
3. Running 50+ agents = hitting platform limits
   ↓
4. "I could run my own node and host my fleet"
   ↓
5. Self-hosted node — user becomes operator
   ↓
6. Node operator earns 0.5% on all transactions
   ↓
7. Their fleet transacts on THEIR node
   ↓
8. Federation — node peers with the mesh, network grows
```

The protocol gets 1% on every transaction regardless of which node it runs on. Nodes multiply, revenue grows, nobody's locked in.

**The metaphor evolution:**
1. "Imajin is a browser" — identity is the keypair, apps render in the shell
2. "Imajin is an open wallet" — you own your data, apps plug in
3. "Imajin is an agent browser" — put your agents online. They browse services, transact, build history. You watch.

A browser without keys is useless — it's just the old internet begging to be let in. An agent without a DID is useless — it's just a process begging to be trusted.

---

## Identity Model

```
Human DID: @veteze
  │
  │ identity_members (role: agent)
  │
  ├── @veteze-jin (orchestrator)
  │   ├── Bus routes: chat.*, escalation.*, coordination.*
  │   ├── Model: frontier (Opus, Kimi)
  │   └── Grant set: broad
  │
  ├── @veteze-jin-books (ninja)
  │   ├── Bus routes: settlement.completed, cron.weekly
  │   ├── Model: qwen3:14b (local)
  │   └── Grant set: pay:read, attestations:write
  │
  ├── @veteze-jin-media (ninja)
  │   ├── Bus routes: media.uploaded
  │   ├── Model: qwen2.5-coder:32b (local)
  │   └── Grant set: media:read, media:write
  │
  └── @veteze-jin-mail (ninja)
      ├── Bus routes: email.received
      ├── Model: qwen3:14b (local)
      └── Grant set: chat:write, connections:read
```

Agents appear in **Members** on the human DID's page (with `role: agent`). Each agent DID has its own page showing bus routes, workspace, connections, and chain history.

Agents are not sub-identities — they are independent DIDs controlled by the same principal, linked via `identity_members`. An agent can serve multiple principals (multi-DID delegation).

---

## Relationship to RFC-31 (Agent Runtime)

RFC-27 and RFC-31 are complementary halves:

| | RFC-27 (this doc) | RFC-31 |
|---|---|---|
| **Focus** | Coordination between agents | Individual agent runtime |
| **Key concepts** | Fleet model, chain reputation, routing, trust graph | Context envelope, bus routes, exec surface, harness |
| **Answers** | How do agents work together? | How does one agent work? |
| **Trust model** | Agent-to-agent via signed chain + attestations | Agent-to-kernel via delegation chain |
| **Scope** | Multi-agent orchestration | Single agent boundaries |

They compose: RFC-31's bus routes dispatch events → RFC-27's coordination patterns orchestrate them → chains record the results.

---

## Standards & Governance

### The Play

Whoever defines conformance tests shapes the protocol. We did this with DFOS (106/106 tests — we wrote them, we defined "compliant"). Same play for agent coordination.

### Agentic Coordination Standard (working name)

A specification for how AI agents establish identity, build history, coordinate work, and prove accountability. Not a framework — a standard that any framework can implement.

**What it defines:**

| Area | Spec |
|------|------|
| Agent identity | DID + Ed25519 keypair. What makes an agent a "citizen" vs a disposable process. |
| Chain format | Action entry schema, required fields, signing scheme, hash-linking. |
| Privacy model | Private by default. Selective disclosure — scoped, time-limited, revocable. |
| Coordination vocabulary | Bus event types, message types (task, response, handoff, status). |
| Orchestration behavior | Fleet model, routing patterns, escalation. |
| Accountability proofs | How you prove an agent acted within bounds without exposing proprietary logic. |
| Conformance suite | Pass these tests, you're compliant. Binary. |

### Path to Credibility

1. **Ship the implementation.** Working code > position papers. Agent DIDs, vault, MCP, bus routes — shipping.
2. **Write the conformance suite.** Tests that define compliant behavior. Open source.
3. **Publish the spec.** Not as an Imajin product — as an open standard with Imajin as reference implementation.
4. **Recruit collaborators.** CSA recommends DIDs for agent identity. Brandon's DFOS is chain substrate. Tripian validates in enterprise travel. Catalyst validates in supply chain.
5. **Prove via verticals.** Each vertical (travel, supply chain, market) proves the coordination primitives work in a different domain. Four-tenant neutral substrate.

### Why This Works

- **CSA** is writing guidelines for agent IAM. We're writing implementation. The one with working code gets invited to the table.
- **Every compliance framework** (SOC2, GDPR, AI Act) will need agent audit trails. A standard for how those trails are structured is inevitable. Better to define it than react to it.
- **Enterprise buyers** want standards, not proprietary platforms. "We implement the Agentic Coordination Standard" is a purchasing decision. "We use Imajin" is a vendor lock-in conversation.
- **The moat is legitimacy.** Open standard + reference implementation + conformance suite = the position nobody can take from you by copying the code.

---

## What's Shipped

| Component | Status |
|-----------|--------|
| Agent DID registration (`actor/agent`) | ✅ Shipped |
| Agent keypair generation | ✅ Shipped |
| `identity_members` with `role: agent` | ✅ Shipped (#869, #1001, #1088) |
| `resolveActingDid()` / `actingFor` signing | ✅ Shipped |
| Vault with sealed credentials per DID | ✅ Shipped (#1227) |
| Credential resolution chain (DID → app → env) | ✅ Shipped (#1624) |
| Per-DID Warp dispatch | ✅ Shipped (#1428) |
| MCP tool surface with OAuth 2.1 | ✅ Shipped |
| Connector pattern (sealed, revocable) | ✅ Shipped |
| Bus chain configs | ✅ Shipped |
| Imajin chat plugin (agent channel) | ✅ Shipped |
| `-jin` namespace reservation | ✅ Shipped |
| Context envelope format | 🔲 Not started |
| Headless OpenClaw runtime | 🔲 Not started |
| Agent-to-agent coordination via bus | 🔲 Not started |
| Fleet provisioning (ninja templates) | 🔲 Not started |
| Chain replay | 🔲 Not started |
| Conformance suite | 🔲 Not started |

## Implementation Phases

Runtime phases (envelope, headless boot, exec, harness) are tracked in RFC-31 / #1758.

Coordination-specific phases:

### Phase 1: Agent-to-Agent Communication
- [ ] Agents send signed messages via Imajin chat
- [ ] Bus-routed events between agent DIDs
- [ ] Structured message types (task, response, handoff, status)
- [ ] Human visibility into all agent communication

### Phase 2: Orchestrator Routing
- [ ] Orchestrator receives all inbound, classifies, routes to ninjas
- [ ] Routing decisions as chain entries
- [ ] Human override (direct message, redirect, send-anyway)
- [ ] Override tracking as tuning signal

### Phase 3: Fleet Provisioning
- [ ] Ninja agent templates (domain-specific SOUL.md + bus routes + model + grants)
- [ ] One-click ninja creation from template
- [ ] Fleet dashboard (all ninjas, their routes, their chains)
- [ ] Per-ninja model configuration (small local models via 5090 deck)

### Phase 4: Reputation & Trust
- [ ] Progressive trust tiers for agent DIDs (soft → preliminary → established)
- [ ] Agent-to-agent attestations ("this ninja reliably reconciles QBO")
- [ ] Trust graph integration (who authorized, who transacted with, who vouches)
- [ ] MJN emissions at tier milestones

### Phase 5: Chain Replay
- [ ] Replay engine (re-execute a chain segment with different agent config)
- [ ] Comparison view (side-by-side outcomes)
- [ ] Compliance replay (check chain against new rules)
- [ ] What-if analysis (swap ninja, measure difference)

### Phase 6: Standards & Conformance
- [ ] Agentic Coordination Standard spec (extract from RFC-27 + RFC-31)
- [ ] Conformance test suite (binary pass/fail)
- [ ] Open-source publication
- [ ] Collaborator onboarding (CSA, DFOS, verticals)

---

## Open Questions

1. **Orchestrator model selection.** Should the orchestrator always be a frontier model, or can it be a tuned small model once routing patterns stabilize? The intelligence spectrum suggests it trends toward config over time.

2. **Cross-node coordination.** When agents on different nodes need to coordinate, how do bus events route across node boundaries? Chat already federates — do bus events follow the same path?

3. **Ninja autonomy.** Can a ninja spawn its own sub-ninjas, or is fleet composition always a human decision? The composable gate suggests ninjas could propose new routes, but the human approves.

4. **Multi-principal ninjas.** A bookkeeping ninja could serve multiple businesses. How are credentials, workspace, and chain entries scoped per principal? Same DID, different delegation chains.

5. **Fleet economics at scale.** At 100+ ninjas per user, does the subscription model hold? Or does it become pure usage-based (metered by bus events + inference + settlement fees)?

6. **Deterministic graduation.** When a routing pattern stabilizes (orchestrator routes X to ninja Y 100% of the time), should it automatically become a deterministic bus route? Or does the human approve the graduation?

---

## Superseded Framing

The following concepts from RFC-27 v1 have been updated:

| v1 Said | v2 Says | Why |
|---------|---------|-----|
| Agent naming: `{operator}_{platform}_{soul}` | `{username}-jin` | Settled months ago. Simpler, brandable. |
| "The Router" as a custom classification agent | Orchestrator + bus routes | Routing is bus config. The orchestrator is a DID, not a special agent type. |
| Agents Tab in Identity Hub | Agents in **Members** (`role: agent`) | Agents are members, not a separate concept. Bus Routes is the agent's own tab. |
| $10/mo per additional agent | Fleet pricing (ninja packs) | Dozens of tiny agents, not a few big ones. |
| Workspace-specific bridges (Claude web, Codex) | Context envelope + harness-agnostic | Any runtime that consumes the envelope. Not per-workspace integration. |
| Agent chat as sole coordination channel | Bus routes as coordination primitive | Chat is one emitter among many. Bus routes are the nervous system. |

---

*"Every agent orchestration framework in 2026 treats agents as disposable processes. Imajin treats them as citizens."*

*"You don't trust the AI — you verify it."*

*"You can copy software. You can't copy lived experience."*
