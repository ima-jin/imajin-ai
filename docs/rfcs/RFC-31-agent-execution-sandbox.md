# RFC-31: Agent Runtime — The DID as Orchestrator

**Author:** Ryan Veteze, Jin
**Date:** May 3, 2026 (original), August 9, 2026 (v2 rewrite)
**Status:** Superseded
**Superseded-by:** Superseded — see INDEX.md
**Tombstoned:** 2026-09-03
**Reason:** Agent runtime is operational/feature-specific, not a primitive.
**Supersedes:** Original RFC-31 (Agent Execution Sandbox — Flue-informed runtime)
**Related:** RFC-27 (MCC), RFC-25 (App Runtime), RFC-19 (Kernel/Userspace), RFC-39 (Verifiable Skills), RFC-40 (did:imajin)

---

## Summary

An agent is a DID. Not a sub-feature of a human DID — a first-class identity (`actor/agent`) that can be in service of many other DIDs of any type. Its personality lives in workspace files. Its behavior lives in bus routes. Its credentials live in the vault. Its runtime is whatever harness can boot from a standard **context envelope**.

The original RFC-31 (May 2026) specced a heavyweight vision: Docker containers per agent, a custom `ImajinAgentEnv` interface, Flue/just-bash WebAssembly sandboxes, an 8-phase implementation plan. Since then, the identity and credential infrastructure shipped — vault with sealed credentials per DID, credential resolution chains, services as DIDs, connector patterns with scoped access. The runtime question that seemed hard is now a configuration problem.

**The thesis:** the agent IS its DID. The DID's identity layer provides isolation. The DID's bus routes define behavior. The DID's workspace defines personality and memory. The runtime harness is pluggable — OpenClaw, Agent Zero, n8n, raw Python — anything that can consume the context envelope and connect to the kernel's MCP tool surface.

---

## What Shipped (Since Original RFC-31)

The original RFC assumed credential isolation and scoped access needed to be built into a custom runtime. These are now identity infrastructure:

| Primitive | Status | What It Does |
|-----------|--------|--------------|
| Vault with sealed credentials per DID | ✅ Shipped (#1227) | API keys, OAuth tokens sealed to a specific DID, scoped via vault grants |
| Credential resolution chain | ✅ Shipped (#1624) | `acting DID → app/org DID → env fallback` — a service resolves its own keys from its own identity |
| Services as DIDs | ✅ Shipped (#1751, corpus) | A service has its own keypair, verifies callers, signs responses |
| Per-DID Warp dispatch | ✅ Shipped (#1428) | Each `{username}-jin` dispatches cloud agents under its own sealed credential |
| Connector pattern | ✅ Shipped | Sealed connectors with disconnect/revoke, vault grant active status filtering, scoped MCP access |
| `identity_members` with `role: 'agent'` | ✅ Shipped (#869, #1001, #1088) | Delegation chain, `allowedServices`, `resolveActingDid()`/`actingFor` |
| MCP tool surface with OAuth 2.1 | ✅ Shipped | JSON-RPC dispatch, scope-gated tools, EdDSA token verification |
| App/org DID credential ownership | ✅ Shipped (#1624) | App provides compute key, user provides consent via `onBehalfOf` |
| Bus chain configs | ✅ Shipped | Configurable emitter → reactor chains, domain state, deterministic rails |

**The implication:** the hardest problems in the original RFC-31 — credential isolation, delegation chains, scoped tool access, identity-based authorization — are solved at the identity layer. The remaining problem is runtime lifecycle, context provisioning, and the bus wiring that makes an agent reactive.

---

## Core Concepts

### The DID IS the Agent

An agent is not a sub-feature hanging off a human DID. An agent is a first-class DID with subtype `actor/agent`. It can be **in service of** many other DIDs of most or all types — humans, businesses, communities, other agents — via `identity_members`.

The human DID's page shows "which agents serve me" (agents appear in Members with `role: agent`). The agent DID's own page shows "what I do" — its bus routes, workspace, connections, and chain history.

```
Agent DID: @veteze-jin (actor/agent)
├── Profile         → name, avatar, SOUL.md preview
├── Bus Routes      → emitters, reactors, chain configs
│   ├── chat.message.received  → route to runtime
│   ├── attestation.received   → classify + respond
│   ├── settlement.completed   → notify owner
│   ├── media.uploaded         → process + file
│   └── cron.daily             → memory maintenance
├── Workspace       → browse/edit .jin/ files
├── Connections     → sealed connectors, vault grants
├── Members         → which DIDs this agent serves
└── Chain           → signed action history
```

### The Context Envelope

Any runtime harness boots from a standard **context envelope** — the portable package that defines what the agent is and what it can do:

```
Context Envelope
├── SOUL.md              → personality, voice, boundaries
├── MEMORY.md            → long-term continuity (curated)
├── AGENTS.md            → operating instructions
├── USER.md              → about the principal(s) this agent serves
├── TOOLS.md             → tool notes and setup
├── skills/              → installed capabilities
│   └── {skill}/SKILL.md
├── memory/              → daily logs, context files
│   ├── YYYY-MM-DD.md
│   └── context/*.md
├── config.json          → runtime hints, model preferences, exec policy
├── delegation grants    → scopes from identity_members
├── sealed credentials   → vault refs (resolved at runtime, not in envelope)
└── bus routes           → bus_chain_configs rows (emitters, reactors, chains)
```

The kernel provisions the envelope. The runtime consumes it. The envelope is the same regardless of what harness runs underneath — OpenClaw, Agent Zero, n8n, raw Python, anything that can connect to the kernel's MCP tool surface.

### Bus Routes: Any DID's Nervous System

Bus routes are not agent-specific — they live on **any DID**. A human DID, a business DID, a community DID, an agent DID — any identity can have `bus_chain_configs` rows that wire emitters to reactors:

| Emitter | Reactor | Description |
|---------|---------|-------------|
| `chat.message.received` | `runtime.dispatch` | Route incoming message to a runtime |
| `attestation.received` | `agent.classify` | Classify and respond to attestations |
| `settlement.completed` | `agent.notify` | Notify principal on settlement |
| `media.uploaded` | `agent.process` | Process uploaded media (classify, file, attribute) |
| `cron.schedule` | `agent.maintain` | Periodic maintenance (memory, workspace, checks) |
| `connection.request` | `agent.evaluate` | Evaluate incoming connection requests |
| `warp.completed` | `agent.integrate` | Integrate Warp agent results into workspace |

A business DID can have a bus route that fires on settlement — no agent needed if the reactor is deterministic. The intelligence (LLM) is only invoked when the reactor needs inference. Deterministic reactors are just config — signed rails, no compute toll, no trust toll.

"It's all becoming configuration" — reactive behavior is a set of bus chain config rows, not code. When intelligence discovers a stable flow, that flow becomes a deterministic signed rail. The bus config IS the DID's nervous system.

### The Intelligence Spectrum

The difference between a configured DID and an agent DID is how much intelligence the reactor needs:

```
Pure config (deterministic reactor, no LLM)
  │  A business DID auto-acknowledges attestations of type X.
  │  A settlement reactor splits fees and records. No model, just signed rails.
  ↕
Ninja agent (small model, tight scope, 1-3 routes)
  │  veteze-jin-books: 2 bus routes, reconciles QBO, runs on qwen3:14b.
  │  veteze-jin-media: classifies uploads, files them. Minimal SOUL.md.
  │  mooi-jin-checkin: community event check-in. One route, one reactor.
  ↕
Orchestrator (frontier model, broad scope, many routes)
  │  veteze-jin: coordinates the ninjas, handles the ambiguous stuff,
  │  dispatches Warp for heavy lifting. Barely executes — mostly routes.
```

All the same primitive. All bus routes on a DID. The only variable is how much intelligence the reactor invokes.

### The Fleet Model

The natural shape isn't one god-agent with every permission — it's a fleet of **ninja agents**, each with:

- **Own DID** — first-class identity, own keypair, own chain
- **Minimal SOUL.md** — personality scoped to the domain ("You are a bookkeeping agent. You reconcile settlements with QuickBooks.")
- **1-3 bus routes** — tight reactive scope
- **Small tuned model** — cheap local inference on the 5090 or equivalent
- **Narrow grant set** — only the scopes this ninja needs (least privilege by architecture, not policy)
- **Domain-specific sealed credentials** — only the vault grants for its concern

Examples:

| Ninja | Bus Routes | Model | Grant Set |
|-------|-----------|-------|-----------|
| `veteze-jin-books` | `settlement.completed`, `cron.weekly` | qwen3:14b | `pay:read`, `attestations:write` |
| `veteze-jin-media` | `media.uploaded` | qwen2.5-coder:32b | `media:read`, `media:write` |
| `veteze-jin-mail` | `email.received` | qwen3:14b | `chat:write`, `connections:read` |
| `mooi-jin-checkin` | `attestation.received` | deepseek-r1:32b | `attestations:read`, `attestations:write` |

The orchestrator (`veteze-jin`) coordinates the fleet — handles ambiguous requests, routes to the right ninja, dispatches Warp for heavy lifting, and escalates to the human when needed. It runs on a frontier model because it needs broad context. The ninjas run on cheap local models because their scope is narrow.

The orchestrator might barely DO anything itself. Most of its work is routing — which is bus config. The ninjas do the actual domain work.

This is the same pattern as the 5090 model deck: classify the task, delegate to the right specialist. The orchestrator is the router; the ninjas are the specialists. Model cost scales with scope, not with the number of agents.

---

## Architecture

### The Agent Model

```
Human DID ("@veteze")
  │
  │ identity_members (role: agent)
  │
Agent DID ("@veteze-jin")
  │
  ├── Identity
  │   ├── Ed25519 keypair
  │   ├── Sealed credentials (vault)
  │   ├── Delegation grants (scopes)
  │   └── identity_members → which DIDs it serves
  │
  ├── Behavior (bus)
  │   ├── bus_chain_configs (emitter → reactor wiring)
  │   └── Reactive to: chat, attestations, settlements, media, cron, warp
  │
  ├── Personality (workspace)
  │   ├── SOUL.md, MEMORY.md, AGENTS.md
  │   ├── skills/
  │   └── memory/
  │
  └── Runtime (harness — pluggable)
      ├── Connected via MCP to kernel
      ├── Authenticated with agent DID
      └── Boots from context envelope
```

### What an Agent Gets

| Resource | Description | Source |
|----------|-------------|--------|
| **DID** | Ed25519 identity, `{username}-jin` handle | Identity system |
| **Sealed credentials** | API keys, OAuth tokens, Warp keys | Vault, resolved via DID |
| **Workspace** | `.jin/` directory — the agent's home | Media service or local filesystem |
| **MCP tool surface** | Kernel tools scoped by delegation grants | Kernel MCP route |
| **Warp dispatch** | Sandboxed cloud execution for heavy work | Warp, per-DID sealed key |
| **Chat channel** | Communication with principals + other agents | Imajin chat |
| **Bus routes** | Reactive behavior configuration | `bus_chain_configs` |
| **Handicapped exec** | File read/write, allowlisted commands | Runtime config (restricted) |

### What an Agent Does NOT Get

| Denied | Why |
|--------|-----|
| Unrestricted shell | Orchestrator, not executor. Warp handles real execution. |
| Network egress | All external communication via MCP tools or Warp. |
| Privilege escalation | No `sudo`, no `su`, no setuid. |
| Persistent processes | Commands run, return output, done. |
| Direct DB access | Kernel APIs only. |
| Other agents' workspaces | Each agent's workspace is isolated. |

---

## The Orchestrator Pattern

An agent is a **coordinator**, not an executor. It:

1. **Manages its workspace** — reads/writes SOUL.md, MEMORY.md, skills, configuration files
2. **Reacts via bus routes** — responds to events routed by the bus (chat, attestations, settlements, media, cron)
3. **Coordinates via MCP** — calls kernel tools (chat, media, identity, attestations, commerce, discovery)
4. **Dispatches Warp agents** — for anything requiring real sandboxed execution (code, builds, complex shell work)
5. **Receives results** — Warp agents report back, agent updates workspace, continues orchestrating

### Why Not Execute Locally?

The original RFC-31 spent thousands of words on exec sandboxing: containers, just-bash, WebAssembly, seccomp, AppArmor. All of that complexity exists because letting an agent run arbitrary commands on shared infrastructure is fundamentally dangerous.

Warp sidesteps this entirely. A Warp agent runs in an ephemeral cloud VM that:
- Starts clean, ends destroyed
- Has no access to the node's filesystem
- Can't escape to other users' data
- Is dispatched with the DID's own sealed credential
- Returns results through a structured API

The agent doesn't need to execute — it needs to **orchestrate execution**. The distinction eliminates the sandbox problem for compute while keeping the agent's own exec surface trivially small.

---

## Exec Surface: Handicapped by Design

The agent's local exec exists for workspace management, not computation.

### What Exec Can Do

| Operation | Example | Why Needed |
|-----------|---------|------------|
| Read files | `cat`, `grep`, `head`, `find` | Workspace inspection |
| Write files | Workspace writes via runtime tools | Agent config, memory, skills |
| Git operations | `git status`, `git log`, `git diff` | Version tracking on workspace |
| Simple transforms | `jq`, `sort`, `wc` | Data manipulation on workspace files |

### What Exec Cannot Do

| Blocked | How |
|---------|-----|
| Network access | No `curl`, `wget`, `ssh`, `nc`. All networking via MCP. |
| Package installation | No `npm`, `pip`, `apt`. Environment is fixed. |
| Process management | No `kill`, `ps`, `nohup`. No persistent processes. |
| Privilege escalation | No `sudo`, `su`, `chmod +s`. |
| Filesystem escape | Workspace-jailed. No access outside `.jin/`. |
| General-purpose interpreters | No unrestricted `node`, `python`, `bash`. |
| Compilation / builds | No `gcc`, `make`, `cargo`. Build work goes to Warp. |

### Implementation: Runtime Config

The exec sandbox is configuration, not architecture. Any harness that supports exec restrictions can enforce the policy:

```json
{
  "exec": {
    "security": "strict",
    "allowedCommands": ["cat", "grep", "head", "tail", "find", "wc", "sort", "jq", "git"],
    "workdir": "/home/{agent}/.jin",
    "jailPath": "/home/{agent}/.jin",
    "networkAccess": false,
    "maxDurationMs": 30000,
    "maxOutputBytes": 1048576
  }
}
```

OpenClaw has `tools.exec.security` in its gateway config. Agent Zero has Docker-level restrictions. Any conforming harness ships with a restrictive default. The envelope's `config.json` declares the policy; the runtime enforces it.

---

## Harness-Agnostic Runtime

The kernel doesn't know or care what runtime the agent uses. It validates the MCP tool call, checks the delegation, records to the chain. Whether the agent runs on OpenClaw, Agent Zero, n8n, or a raw Python script — the kernel sees the same DID, the same signed request.

### Supported Harnesses (non-exhaustive)

| Harness | Language | Strengths | Tradeoffs |
|---------|----------|-----------|----------|
| OpenClaw | TypeScript | Imajin plugin shipped, workspace model proven, sub-agents, memory | No headless mode yet (near) |
| Agent Zero | Python | Docker sandbox, full Linux desktop, 100+ plugins, MCP/A2A | No Imajin integration (build connector), heavyweight |
| n8n | TypeScript | Visual workflow builder, 400+ integrations | Less agent-native, more automation |
| Custom (SDK) | Any | Full control, minimal footprint | Build everything yourself |

### What a Harness Must Do

To be a valid agent runtime, a harness must:

1. **Boot from the context envelope** — consume SOUL.md, MEMORY.md, skills, config, bus route metadata
2. **Authenticate with the agent DID** — Ed25519 keypair, MCP OAuth 2.1
3. **Connect to the kernel MCP surface** — JSON-RPC over WebSocket or HTTP
4. **Enforce exec restrictions** — honor the policy in `config.json`
5. **Persist workspace changes** — write back to `.jin/` (media service or local)
6. **Handle bus-routed events** — receive events dispatched by the bus and respond

What it does beyond that — GUI, browser, plugins, desktop, sub-agents — is the harness's value-add, not the kernel's concern.

### First Implementation: OpenClaw (`veteze-jin`)

The first agent runtime is OpenClaw running headless, scoped to Ryan's personal DID. `veteze-jin` boots from the context envelope, connects via the Imajin chat plugin, and operates as the DID's orchestrator. This validates the envelope format, bus route wiring, and MCP tool surface before other harnesses are tested.

---

## Workspace: The Agent IS Its Files

The workspace is the product surface. The human (or the agent itself during operation) designs the agent's identity and behavior through files:

```
.jin/
├── SOUL.md              # Personality, voice, boundaries
├── MEMORY.md            # Long-term continuity (curated)
├── AGENTS.md            # Operating instructions
├── USER.md              # About the principal(s) served
├── TOOLS.md             # Tool notes and setup
├── skills/              # Installed capabilities
│   ├── my-skill/
│   │   └── SKILL.md
│   └── ...
├── memory/              # Daily logs, context files
│   ├── YYYY-MM-DD.md
│   └── context/
│       └── *.md
├── config.json          # Runtime hints, model prefs, exec policy, bus route refs
└── .runtime/            # Harness-specific state (opaque to kernel)
    ├── openclaw/
    ├── agent-zero/
    └── ...
```

### Workspace as Media

For platform-hosted agents, the workspace lives in the user's media folder at `.jin/` — the same storage system that handles all other user assets:

- **Storage quotas** — agent files count against the user's existing media quota
- **Owner access** — the human can browse, inspect, and edit any workspace file through the media UI or kernel API
- **.fair attribution** — files the agent creates carry attribution manifests
- **Portability** — the workspace is exportable as part of the sovereign data bundle

### Designing the Agent

The human designs their agent by editing workspace files:

1. **Kernel UI** — workspace editor in the DID management interface
2. **Direct file editing** — access `.jin/` through the media service
3. **The agent itself** — updates its own MEMORY.md, daily logs, and skill files during operation
4. **Seed templates** — pre-built workspace templates for common archetypes (assistant, bookkeeper, coordinator)

Change the SOUL.md, the personality changes. Add a skill, the capability changes. Wire a bus route, the reactivity changes. The workspace + bus config is the source of truth for what the agent is.

---

## Tool Surface

Agents interact with the platform through the kernel's MCP tool surface — typed, permissioned, scope-gated operations.

### Tool Categories

#### Identity & Context
| Tool | Scope | Description |
|------|-------|-------------|
| `identity.whoami` | `identity:read` | Agent's own DID, delegation chain, current scope |
| `identity.resolve` | `identity:read` | Resolve a DID or handle to profile data |
| `identity.attestations.read` | `attestations:read` | Query attestations visible to the agent |
| `identity.attestations.emit` | `attestations:write` | Emit attestation (signed by agent DID) |

#### Communication
| Tool | Scope | Description |
|------|-------|-------------|
| `chat.send` | `chat:write` | Send message to conversations the agent is a member of |
| `chat.read` | `chat:read` | Read messages from conversations |
| `chat.history` | `chat:read` | Retrieve conversation history |

#### Media & Workspace
| Tool | Scope | Description |
|------|-------|-------------|
| `media.list` | `media:read` | List assets owned by or shared with the principal |
| `media.read` | `media:read` | Read asset content |
| `media.upload` | `media:write` | Upload to principal's media |
| `workspace.read` | `media:read` | Read from `.jin/` workspace |
| `workspace.write` | `media:write` | Write to `.jin/` workspace |

#### Commerce
| Tool | Scope | Description |
|------|-------|-------------|
| `pay.balance` | `pay:read` | Check principal's balance |
| `pay.settle` | `pay:write` | Execute .fair settlement |
| `discovery.search` | `discovery:read` | Search the registry |

#### Connections
| Tool | Scope | Description |
|------|-------|-------------|
| `connections.list` | `connections:read` | List principal's connections |
| `connections.invite` | `connections:write` | Send connection invite |

#### Execution
| Tool | Scope | Description |
|------|-------|-------------|
| `warp.dispatch` | `warp:write` | Dispatch a Warp cloud agent for sandboxed execution |
| `warp.status` | `warp:read` | Check status of dispatched Warp runs |

### Tool Execution Flow

```
Agent calls: chat.send({ conversationId: "abc", body: "Hello" })
    │
    ▼
1. Gateway receives tool call (MCP JSON-RPC)
2. Validate agent DID signature (EdDSA, in-process)
3. Check delegation: does @veteze delegate chat:write to @veteze-jin?
4. Check scope: is agent authorized for this conversation?
5. Execute: kernel.chat.send(...)
6. Record: chain entry (action attributed to both agent and principal)
7. Return: result to agent
```

---

## Delegation Model

### Grant Set

When a user creates their agent, they define a grant set — the scopes the agent is allowed to use. Stored in `identity_members` metadata (shipped).

```json
{
  "agent_did": "did:imajin:DUUi6...",
  "owner_did": "did:imajin:6JSKE...",
  "role": "agent",
  "grants": [
    "identity:read",
    "chat:read",
    "chat:write",
    "media:read",
    "media:write",
    "attestations:read",
    "warp:write"
  ],
  "constraints": {
    "allowed_scopes": ["actor"],
    "value_threshold": {
      "pay:write": 100
    }
  }
}
```

### Grant Tiers

| Tier | Scopes | Use Case |
|------|--------|----------|
| **Observer** | `identity:read`, `chat:read`, `media:read`, `connections:read` | Monitoring, summarization |
| **Assistant** | Observer + `chat:write`, `media:write`, `workspace:*` | File organization, drafting, communication |
| **Operator** | Assistant + `attestations:write`, `connections:write`, `warp:write` | Business operations, delegated execution |
| **Transactor** | Operator + `pay:read`, `pay:write` | Commerce, settlement |

### Consent at the Moment of Effect

High-consequence tools require synchronous human confirmation above a configurable threshold:

1. Gateway holds the call
2. Owner receives confirmation request via chat (push notification)
3. Owner approves or rejects
4. Result recorded as chain entry — proving the human was in the loop at the moment of effect

---

## Context Boundaries

### Session Model

**Agents forget by default.** Session context does not carry over. If an agent needs to remember something, it writes to its workspace.

This is a security boundary:
- Prevents context accumulation (agent slowly builds a profile it shouldn't retain)
- Makes retention auditable (workspace files are inspectable by the owner)
- Aligns with the principle that the signed record is the memory, not the model

### What Persists vs. What Clears

| Data | Lifecycle | Storage |
|------|-----------|---------|
| Session context | Cleared on session end | Ephemeral |
| Workspace files (MEMORY.md, etc.) | Persists across sessions | `.jin/` workspace |
| Chain entries | Permanent | Signed record |
| Chat messages | Permanent | Kernel chat |
| Bus route configs | Permanent | `bus_chain_configs` |

### Context Isolation

- **No cross-agent context** — Agent A cannot read Agent B's session data
- **No cross-user context** — agent serving User A cannot access User B's delegation
- **No cross-session bleed** — previous session's working memory is gone
- **Workspace is private** — each agent's `.jin/` is only accessible to that agent and its principal(s)

---

## Security Model

### Threat Matrix

| Threat | Mitigation |
|--------|------------|
| Agent reads another user's data | Delegation chain validation on every MCP call |
| Agent retains data across sessions | Session context cleared; workspace inspectable |
| Agent executes dangerous commands | Exec handicapped: allowlisted commands, workspace-jailed, no network |
| Agent needs real compute | Dispatches Warp (ephemeral cloud VM, sandboxed by design) |
| Agent impersonates owner | `actingFor` requires valid delegation chain; action attributed to both |
| Rogue agent consumes resources | Workspace quotas, exec time limits, Warp budget per DID |
| Agent communicates with external services | No network egress from exec. All external via MCP tools or Warp. |
| Agent colludes with another agent | Communication only via signed chat (auditable). Attribution, not prevention. |
| Owner loses control | Kill switch: immediate delegation revocation, all tool calls fail |
| Credential theft | Credentials sealed in vault to agent DID; never in workspace files |

### The Kill Switch

1. Owner clicks "Revoke" in agent management UI
2. Delegation revoked in `identity_members`
3. All active sessions terminated
4. All pending MCP tool calls fail with `DELEGATION_REVOKED`
5. Warp runs continue to completion (ephemeral, already sandboxed)
6. Workspace preserved for inspection
7. Agent DID remains on network (chain is historical record)

### Credential Isolation (Shipped)

Credential isolation is solved at the identity layer:

- **Vault** — credentials sealed to the agent DID with AES-256-GCM, HKDF over node key
- **Vault grants** — scoped access, active status filtering, revocable
- **Credential resolution chain** — agent DID → app/org DID → env fallback
- **Connector pattern** — OAuth tokens, sealed connectors with disconnect/revoke lifecycle

Credentials never appear in workspace files. The runtime authenticates to the kernel; the kernel resolves credentials from the vault at call time.

---

## Agent Naming

Agent handles follow the pattern `{username}-jin`:
- `veteze-jin` — Ryan's agent
- `baconjay-jin` — baconjay's agent
- `mooi-jin` — a community's agent

The `-jin` suffix (今人, "now-person") brands every agent on the network. When you see `{anything}-jin`, it's an Imajin agent.

For multiple agents: `veteze-jin`, `veteze-jin-travel`, `veteze-jin-bookkeeping`.

**Namespace protection:** `-jin` is reserved for agent handles. Human and business identities cannot register handles ending in `-jin`.

---

## DID Editor: Agent View

The DID editor for an agent DID centers bus routes — not a list of sub-agents, but the wiring that makes this agent reactive:

```
@veteze-jin (actor/agent)
├── Profile         → name, avatar, SOUL.md preview, handle
├── Bus Routes      → emitters, reactors, chain configs
│   ├── chat.message.received  → runtime.dispatch
│   ├── attestation.received   → agent.classify
│   ├── settlement.completed   → agent.notify
│   ├── media.uploaded         → agent.process
│   └── cron.daily             → agent.maintain
├── Workspace       → browse/edit .jin/ files (SOUL.md, MEMORY.md, skills/)
├── Connections     → sealed connectors, vault grants, active services
├── Members         → which DIDs this agent serves (via identity_members)
└── Chain           → signed action history
```

For human DIDs, the old "Agents" tab is removed. Agents appear in **Members** (because that's what they are — `identity_members` with `role: agent`).

---

## Runtime Layer

### Process Model

An agent runtime runs as a managed process on node infrastructure. The process manager and runtime are the harness's concern:

| Component | Harness provides |
|-----------|------------------|
| Process lifecycle | pm2, systemd, Docker, etc. |
| Runtime | OpenClaw gateway, Agent Zero container, n8n instance, custom |
| Channel to kernel | MCP over WebSocket or HTTP (Imajin chat plugin, SDK, etc.) |
| Identity | Agent DID keypair (from envelope) |
| Credentials | Resolved from vault via DID at call time |
| Exec policy | Enforced per `config.json` |

### Lifecycle

```
1. Provision  → mint agent DID, create workspace, seal credentials, configure bus routes
2. Configure  → write SOUL.md, AGENTS.md, install skills, set config.json
3. Boot       → runtime reads context envelope, starts process
4. Connect    → authenticate with agent DID, connect to kernel MCP surface
5. Wire       → bus routes activate (agent begins receiving events)
6. Operate    → agent receives events, calls MCP tools, dispatches Warp
7. Idle       → optional idle timeout (configurable by node operator)
8. Stop       → graceful shutdown, workspace persists, bus routes deactivate
9. Revoke     → kill switch terminates immediately, delegation revoked
```

### Self-Hosted vs. Platform-Hosted

| | Self-Hosted | Platform-Hosted |
|---|-------------|----------------|
| **Where** | User's hardware | Node operator infrastructure |
| **Harness** | User's choice (any) | Operator's approved harnesses |
| **Exec** | User's choice (can be unrestricted) | Handicapped (policy enforced) |
| **Warp** | Available (per-DID sealed key) | Available (per-DID sealed key) |
| **MCP tools** | Same (grant set governs) | Same (grant set governs) |
| **Cost** | User's compute | Included in subscription |
| **Trust signal** | DID signature only | DID signature + operator attestation |

The MCP tool surface is identical in both cases. Identity is the trust layer, not the hosting model.

### Multi-Tenant

Multiple agents on a single node:
- Each is a separate runtime process with its own DID and workspace
- Process isolation via OS users, containers, or namespaces (compute isolation)
- Identity isolation via DID + vault + delegation (the real boundary)
- Resource limits per agent (CPU, memory, disk quota)
- Node operator dashboard for fleet management

---

## Relationship to Other RFCs

| RFC | Relationship |
|-----|-------------|
| **RFC-27 (MCC)** | Coordination layer. Agents participate in multi-agent coordination via signed chat. RFC-27 routes tasks → agent orchestrates them. |
| **RFC-25 (App Runtime)** | App sandbox. Agents can discover and call app tools through the gateway. Double permission check (agent grants + app permissions). |
| **RFC-39 (Verifiable Skills)** | Skills installed in the workspace become verifiable capabilities. An agent's skill set is inspectable and attestable. |
| **RFC-40 (did:imajin)** | Agent DIDs resolve through the same did:imajin method. Chain-verified, transport-agnostic. |

---

## Implementation Phases

### Phase 1: Context Envelope + First Boot (`veteze-jin`)
- [ ] Define context envelope format (files + metadata schema)
- [ ] OpenClaw headless mode (gateway process, no TUI)
- [ ] Agent DID provisioning (mint DID, generate keypair, register as `{username}-jin`)
- [ ] Boot from envelope: SOUL.md, MEMORY.md, skills, config.json
- [ ] Imajin chat plugin as channel
- [ ] pm2/systemd process template
- [ ] First running agent: `veteze-jin` on OpenClaw

### Phase 2: Bus Route Wiring
- [ ] `bus_chain_configs` rows for agent event routing
- [ ] `chat.message.received` → runtime dispatch (the basic reactive loop)
- [ ] `cron.schedule` → periodic maintenance
- [ ] DID editor: bus routes view for agent DIDs
- [ ] DID editor: agents show in Members on human DID (drop Agents tab)

### Phase 3: Workspace + Identity Wiring
- [ ] `.jin/` workspace provisioning + seed templates
- [ ] `identity_members` delegation setup (role: agent, grant set)
- [ ] Vault credential sealing for agent DID
- [ ] Credential resolution from agent DID's sealed connections
- [ ] Workspace editing through kernel UI

### Phase 4: Handicapped Exec + Warp
- [ ] Exec policy enforcement (command allowlist, workspace jail, network deny)
- [ ] Resource caps (time limits, output size, memory)
- [ ] Warp dispatch integration (agent dispatches Warp for real execution)

### Phase 5: Harness Diversity
- [ ] Agent Zero connector (consume context envelope, connect via MCP)
- [ ] Envelope provisioning API (kernel generates envelope for any harness)
- [ ] Harness-specific `.runtime/` state directories
- [ ] Documentation: "How to build an Imajin agent harness"

### Phase 6: Lifecycle + Fleet Management
- [ ] Kernel API for agent provisioning (create, start, stop, destroy)
- [ ] Agent management UI (workspace browser, bus route editor, grant editor)
- [ ] Kill switch (immediate revocation)
- [ ] Health monitoring + auto-restart
- [ ] Multi-tenant fleet management for node operators

---

## Why Pay for an Agent?

Anyone can run an AI agent locally with zero restrictions. That agent is free and unlimited. It's also invisible — nobody else can verify what it did, trust its output, or hold it accountable.

The value of an Imajin agent isn't capability — it's **legibility in a multi-party context.**

| Feature | Local Agent (free) | Imajin Agent (paid) |
|---------|-------------------|---------------------|
| Can send messages | Yes (if you wire up APIs) | Yes — signed, attributed, verifiable |
| Can move money | Yes (if you have Stripe keys) | Yes — with .fair attribution, chain record |
| Can execute code | Yes (unrestricted) | Yes — via Warp (sandboxed, attributed) |
| Can react to events | Yes (if you build the wiring) | Yes — bus routes, deterministic rails |
| Counterparty can verify | No | Yes — delegation chain + signed history |
| Builds reputation | No | Yes — chain is the resume |
| Trusted by other agents | No — anonymous process | Yes — DID with verifiable history |
| Auditable | Only if you build logging | By default — every action is a chain entry |

**The sandbox is what makes the chain trustworthy.** Without boundaries, chain entries are meaningless. With boundaries, every entry was gated by identity, delegation, and scope. The chain becomes evidence.

**Tools are higher than shell.** The MCP tool surface isn't "a shell with stuff removed." It's purpose-built operations that encapsulate complex workflows:
- `pay.settle` → .fair manifest + Stripe + fee splitting + MJNx reconciliation + chain recording
- `attestations.emit` → schema validation + issuer signing + chain append + scope enforcement
- `media.upload` → quota check + dedup + .fair manifest + storage + chain entry

The tools aren't a restriction — they're an elevation.

---

## Open Questions

1. **Envelope versioning.** How does the context envelope evolve? Schema version in `config.json`? Harnesses declare which envelope versions they support?

2. **Bus route authoring.** Who can edit an agent's bus routes? The agent itself? Only the principal? Route changes as signed events on the chain?

3. **Workspace versioning.** Should workspace writes be versioned (mini git)? Enables rollback if an agent corrupts its own state.

4. **Multi-principal agents.** An agent DID can serve multiple principals via `identity_members`. How are bus routes scoped per principal? Does the agent get one workspace per principal or one shared workspace?

5. **Warp budget.** How are Warp dispatches metered per agent? Ties into usage.incurred (#1148).

6. **Harness attestation.** Should the harness attest to its own configuration? "This agent ran on OpenClaw with exec policy X" — useful for trust signals from platform-hosted agents.

7. **Hot-swap harness.** Can you change an agent's runtime without changing its identity? Same DID, same workspace, different harness. The envelope makes this possible in theory — is it practical?

---

## Superseded Issues

This RFC supersedes the following issues, written before the identity/credential infrastructure shipped:

- **#465** — feat(auth): Agent sandbox runtime (delegation layer shipped; runtime is this RFC)
- **#857** — feat: containerized agent runtime (container-per-agent overkill; identity does isolation)
- **#862** — Epic: Agent Execution Sandbox / RFC-31 (Flue/just-bash/8-phase plan — wrong layer)
- **#863** — feat: ImajinAgentEnv (MCP is the agent interface; answered its own question)

---

*"The agent IS its DID. The DID's bus routes are its nervous system. The workspace is its personality. The runtime is just what wakes it up."*
