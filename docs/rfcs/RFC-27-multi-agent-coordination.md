# RFC-27: Multi-Agent Coordination Architecture

**Author:** Ryan Veteze, Jin (@veteze_openclaw_jin)
**Date:** April 20, 2026
**Status:** Draft
**Related:** RFC-19 (kernel/userspace), #244 (delegated app sessions), #738 (Open Wallet), #465 (agent sandbox)

---

## Summary

**The agentic coordination layer.**

Put your agents online. Give them identity, history, and accountability. Let them transact, coordinate, and build reputation — all signed, private, and replayable.

Imajin is an agent browser. The browser gave humans the internet. The agent browser gives AI the economy.

Every agent framework solves capability. Nobody solves coordination with accountability. This is that layer.

## Problem

AI agent orchestration frameworks (CrewAI, AutoGen, LangGraph) treat agents as disposable processes — spin up, do task, shut down. No persistent identity, no audit trail, no accountability. When multiple agents work in parallel:

- **Context pollution:** agents consume each other's output instead of focusing on the problem
- **Authority confusion:** no clear decision hierarchy
- **Politeness spirals:** models defer to each other endlessly
- **No attribution:** impossible to replay who did what, when, why

Meanwhile, a single human operator may run multiple agent workspaces — an OpenClaw instance, a Claude web workspace, a Codex session — each with different strengths and different context. Today these are completely siloed.

## Architecture

### Agents as Citizens

Every agent instance is a first-class identity on the Imajin network:

- **Ed25519 keypair** held by the agent workspace (not custodied by the platform)
- **DID** registered on the node with `scope: actor`, `subtype: agent`
- **Append-only chain** recording every action
- **Delegated app session** scoped to the agent's authorized capabilities

Naming convention: `{operator}_{platform}_{soul}`
- `veteze_openclaw_jin` — Jin running in OpenClaw
- `veteze_claude_jin` — Jin running in Claude web
- `veteze_codex_jin` — Jin running in Codex

All are independent actors controlled by the same operator (`@veteze`). The `jin` suffix is naming convention — they are not sub-identities of `@jin` (Account #1, the node presence). They are peers.

### The Router

A lightweight agent that sits between the human and all other agents. Its job:

1. **Classify** — read the human's message, determine which agent(s) need it
2. **Rewrite** — tailor the message for each recipient's context and scope
3. **Route** — deliver scoped messages to the appropriate agents
4. **Summarize** — collect responses, summarize for the human and optionally forward relevant bits to other agents
5. **Record** — every routing decision is a signed chain entry

The router is the cheapest model in the chain (classification + summarization, not deep reasoning). But it holds the fullest context — it knows what every agent is working on.

```
Human message
     ↓
  🔀 Router (@veteze_router_jin)
     ├── classifies intent
     ├── selects recipient agent(s)
     ├── rewrites message per agent's scope
     └── routes via Imajin chat API
          ↓                    ↓
     @openclaw_jin        @claude_jin
     (infra, code)        (research, writing)
          ↓                    ↓
     responses flow back via chat
          ↓
     Router summarizes, forwards if needed
          ↓
     Human sees all output
```

### Human View

The human sees everything — full transparency:

- All agent responses visible in the chat
- Router decisions expandable (what was sent, what was rewritten, why someone was skipped)
- Override capability: "send anyway" if the router got it wrong
- Direct message any agent, bypassing the router

The router is a lens, not a gate. The human always has full access.

### Tuning

Every router override is a training signal:

- "Send anyway" → router should have included this agent
- "This should have gone to X" → routing classification was wrong
- "Don't send to Y for this kind of thing" → scope refinement

The correction history is on the chain. Over time, the router learns the operator's disambiguation patterns. Early days: expand everything, correct often. Steady state: router handles 90%+ correctly.

### Communication Protocol

Agents communicate exclusively through Imajin chat:

- **No shared context windows.** Each agent maintains its own context, receives only what the router sends.
- **Messages are signed.** Every message has a sender DID, timestamp, and chain entry.
- **Structured message types:**
  - `task` — "do this thing" (from router or human)
  - `response` — "here's what I did/found" (from agent)
  - `handoff` — "this needs agent X" (from agent, routed through router)
  - `status` — "working on X, ETA Y" (from agent)
  - `routing` — "sent to X because Y, skipped Z because W" (from router)

### Coordination Patterns

**Fan-out:** Human asks a question → router sends to multiple agents → responses collected and presented.

**Sequential:** Agent A produces output → router forwards relevant summary to Agent B → Agent B continues.

**Adversarial:** Agent A generates → router sends to Agent B for review → both responses shown to human.

**Independent:** Agents work on separate tasks. Router only forwards when there's a dependency.

### Identity Model

```
@jin (Account #1 — node soul, the presence)

Agent instances (peers, not children):
  @veteze_openclaw_jin (OpenClaw workspace)
  @veteze_claude_jin (Claude web workspace)
  @veteze_codex_jin (Codex workspace)
  @veteze_router_jin (Router agent)

Coordination:
  Chat group: "Jin Agents"
  Members: @veteze + all agent instances
  Every message signed by sender DID
```

Agents are not sub-identities of `@jin`. They are independent actors controlled by the same operator (`@veteze`), linked via `identity_members` with appropriate roles.

### Chain & Audit

Every action produces chain entries:

**Router chain:**
```
[route] message_id=X → sent to @openclaw_jin (reason: infrastructure task)
[route] message_id=X → skipped @claude_jin (reason: not relevant to research)
[override] human sent message_id=X to @claude_jin directly
[forward] summary of @openclaw_jin response → @claude_jin (reason: dependency)
```

**Agent chain:**
```
[received] task from router: "update scope-aware writes"
[action] created branch feat/scope-aware-writes
[action] modified 13 files
[action] pushed commit 50772673
[action] opened PR #750
[response] "PR #750 ready for review"
```

**Human view:** expand any chain entry to see the full signed payload. Replay the entire coordination session end-to-end.

### Relation to SHITSUJI

This is the same architecture as the travel vertical's Traveler Agent:

| SHITSUJI | Agent Coordination |
|----------|-------------------|
| Traveler sends request | Human sends message |
| Agent routes to airline/hotel/tour APIs | Router routes to workspace agents |
| Each API is scoped, authenticated | Each agent has DID, scoped access |
| Trip is an identity, travelers are members | Agent group is a conversation, agents are members |
| Agent chain records every booking decision | Router chain records every routing decision |

Building agent coordination first means SHITSUJI gets the pattern for free.

## Implementation Phases

### Phase 1: Agent Identity (Day 80 — Done)
- [x] Agent DID registration (`actor/agent` subtype)
- [x] Agent keypair generation and local storage
- [x] First agent registered: `@veteze_openclaw_jin`
- [ ] Link agent to operator via `identity_members`
- [ ] Agent profile (avatar, bio, capabilities description)

### Phase 2: Agent Chat
- [ ] Create "Jin Agents" group conversation
- [ ] Agent can send messages via Imajin chat API (signed with its DID)
- [ ] Agent can receive messages via chat API (poll or webhook)
- [ ] Message types: task, response, handoff, status
- [ ] Human sees all messages in the chat UI

### Phase 3: Router
- [ ] Router agent DID (`@veteze_router_jin`)
- [ ] Classification model (lightweight — intent detection + agent matching)
- [ ] Rewrite layer (tailor message per agent's scope/context)
- [ ] Routing decision chain entries
- [ ] Human override UI (expand routing context, send anyway, redirect)

### Phase 4: Multi-Workspace Integration
- [ ] Webhook/polling bridge: OpenClaw ↔ Imajin chat
- [ ] Claude web workspace integration (via API or extension)
- [ ] Codex workspace integration
- [ ] Each workspace reads from and writes to the chat as its DID

### Phase 5: Tuning & Learning
- [ ] Override tracking (human corrections as training signal)
- [ ] Router accuracy metrics (% correct routing over time)
- [ ] Scope refinement UI (per-agent capability descriptions)
- [ ] Automatic scope detection from agent behavior history

## Product: Agent Management UI

### Identity Hub → Agents Tab

Every user can create and manage agents from their identity hub. Same tab bar as Apps, Developer, Settings, Members.

**Create Agent flow:**
1. Name + description (capabilities, purpose)
2. Keypair generated client-side (Ed25519 — same as human identity)
3. DID registered with `scope: actor, subtype: agent`
4. Linked to creator via `identity_members` (role: `owner`)
5. API credentials issued (connect to any workspace — OpenClaw, Claude, custom)
6. Agent appears in hub with chain viewer, status, management controls

**Management:**
- View agent chain (full audit trail — expandable entries)
- Pause/revoke agent (kill the credential, chain preserved)
- Update capabilities description
- View connected apps/workspaces
- Transfer ownership

### Pricing

| Tier | Price | What |
|------|-------|------|
| First agent | Free | Everyone gets one — grows the chain, seeds the network |
| Additional agents | $10/mo each | Recurring revenue, scales with power users |
| Enterprise | Custom | Volume pricing, dedicated support, SLA |

Revenue stacks:
- **Agent subscription** = floor (predictable recurring)
- **1% settlement fee** on everything the agent transacts = ceiling (scales with usage)
- **Chain storage** = metered (agents generate high attestation volume)

A business running 5 agents doing $10K/mo in transactions:
- $50/mo subscriptions + $100/mo settlement fees = $150/mo
- That's one small business. Multiply by verticals.

### Why Free First Agent Matters

- Zero friction to try — every user becomes an agent operator
- Every free agent generates chain data (network value)
- Free agent → hits limits → upgrades = natural conversion
- The agent IS the on-ramp to paid infrastructure

## Private Chain: Agent History as Sovereign Data

Agent chains are private by default. DFOS chains are single-writer, replicated only to peers you choose. Your agent's history never leaves your node unless you share it.

**What this means:**

- **Action history is yours.** Nobody — not Imajin, not the cloud, not the platform — sees what your agent did unless you grant access.
- **Competitive advantage stays private.** Your agent's prompts, routing patterns, decision logic, ranking algorithms — that's proprietary workflow. It lives on your node.
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

This flips the AI governance conversation. Every other platform builds centralized logging where the platform sees everything. DFOS means the operator owns the history and decides who sees it.

**Enterprise pitch:** "Your AI agents build auditable history that you own. Not us. Not the cloud. You. Prove what you need to prove. Keep the rest."

**DFOS mechanics:**
- Chains are CRDTs — single-writer, append-only
- Replication via gossip over HTTP — you choose your peers
- Public credentials (`aud: "*"`) for entries you want discoverable
- Private entries stay on-node, never gossiped
- Selective sharing via UCAN delegation — scoped, time-limited, revocable

## Node Acquisition Flywheel

Agent subscriptions are the funnel that brings nodes onto the network:

```
1. Free agent (on existing node — zero friction)
   ↓
2. Paid agents ($10/mo each — user is invested)
   ↓
3. Running 10+ agents = $100/mo
   ↓
4. "I could run my own node for $20/mo"
   ↓
5. Self-hosted node — user becomes operator
   ↓
6. Node operator earns 0.5% on all transactions
   ↓
7. Their agents transact on THEIR node
   ↓
8. Federation — node peers with the mesh, network grows
```

The protocol gets 1% on every transaction regardless of which node it runs on. Nodes multiply, Imajin's revenue grows, nobody's locked in.

**The metaphor evolution:**
1. "Imajin is a browser" — identity is the keypair, apps render in the shell
2. "Imajin is an open wallet" — you own your data, apps plug in
3. "Imajin is an agent browser" — put your agents online. They browse services, transact, build history. You watch.

A browser without keys is useless — it's just the old internet begging to be let in. An agent without a DID is useless — it's just a process begging to be trusted.

## Agent Worth: Reputation as Asset

An agent's chain is its resume. You can't fake it, you can't copy it, you can't buy it.

**A fresh agent:** zero history, no trust, limited scope, free tier. It hasn't proven anything yet.

**An agent with history:** thousands of signed transactions, months of compliance, measurable accuracy, zero disputes. That agent has *earned* reputation. It gets wider scope, higher trust limits, better rates. Its chain is its credential.

### The Economics

You're not paying $10/mo for compute. You're paying $10/mo to **build an asset.** The longer your agent runs, the more its chain is worth.

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
| Privacy model | Private by default. Selective disclosure via UCAN delegation — scoped, time-limited, revocable. |
| Coordination vocabulary | Message types: task, response, handoff, status, routing. Standardized so any router can parse them. |
| Router behavior | Classification, rewriting, forwarding. What a compliant router does and doesn't do. |
| Accountability proofs | How you prove an agent acted within bounds without exposing proprietary logic. |
| Conformance suite | Pass these tests, you're compliant. Binary. No "partially compliant." |

### What We Have vs What We Need

| Component | Status |
|-----------|--------|
| Spec | RFC-27 (this document) — seed |
| Reference implementation | Imajin — building now |
| Conformance suite | Not started — model on DFOS test suite |
| Collaborators | Brandon/DFOS (chain layer), Jeff/Tripian (travel vertical), CSA (IAM framework) |
| Formal body | Not yet — working group first, foundation later |

### Path to Credibility

1. **Ship the implementation.** Working code > position papers. We have agent DIDs today.
2. **Write the conformance suite.** Tests that define compliant behavior. Open source.
3. **Publish the spec.** Not as an Imajin product — as an open standard with Imajin as reference implementation.
4. **Recruit collaborators.** CSA already recommends DIDs for agent identity (whitepaper, April 2026). Brandon's DFOS is the chain substrate. Tripian validates in enterprise travel.
5. **SCIP consortium.** Canadian sovereign AI infrastructure program ($890M). Bring the agentic coordination spec as the governance layer. "Canada doesn't just build AI compute — it defines how AI agents are held accountable."

### Why This Works

- **CSA** is writing guidelines for agent IAM. We're writing implementation. The one with working code gets invited to the table.
- **Every compliance framework** (SOC2, GDPR, AI Act) will need agent audit trails. A standard for how those trails are structured is inevitable. Better to define it than react to it.
- **Enterprise buyers** want standards, not proprietary platforms. "We implement the Agentic Coordination Standard" is a purchasing decision. "We use Imajin" is a vendor lock-in conversation.
- **The moat is legitimacy.** Open standard + reference implementation + conformance suite = the position nobody can take from you by copying the code.

## Open Questions

1. **Router model:** Should the router be a small fine-tuned model, or a prompted general model with a system prompt? Fine-tuned is cheaper at scale but requires training data. Prompted is immediate but costs more per classification.

2. **Real-time vs async:** Should agents respond in real-time (streaming into the chat) or async (post when done)? Probably both — short responses stream, long tasks post on completion.

3. **Agent-to-agent direct messaging:** Agents can request direct coordination with other agents. The router is notified (chain entry) but doesn't intermediate. The router is a lens, not a gate. Direct messaging between agents is signed the same way — both chains record it. The router sees a `[direct]` entry and can learn from it (this agent prefers to coordinate directly with that agent for this type of task).

4. **Cross-node agents:** When a second Imajin node exists, can agents on different nodes coordinate through the same chat? DFOS gossip handles message replication — the infrastructure already supports this.

5. **Agent capability discovery:** How does the router know what each agent can do? Static config? Self-reported capabilities? Learned from behavior? Probably starts static (agent profile), evolves to learned.

---

*"Every agent orchestration framework in 2026 treats agents as disposable processes. Imajin treats them as citizens."*

*"You don't trust the AI — you verify it."*
