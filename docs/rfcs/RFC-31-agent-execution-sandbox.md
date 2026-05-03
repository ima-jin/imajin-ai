# RFC-31: Agent Execution Sandbox — Boundaries for User Agents

**Author:** Ryan Veteze, Jin
**Date:** May 3, 2026
**Status:** Draft
**Related:** RFC-27 (MCC), RFC-25 (App Runtime), RFC-19 (Kernel/Userspace), #465 (Agent Sandbox), #852 (Agent Delegation), #854 (Agent Management UI)

---

## Summary

RFC-27 gives agents identity. RFC-25 gives apps a sandbox. This RFC defines the execution boundary for **user-owned agents** — what they can do, what they can see, what they remember, and how the platform constrains them without neutering them.

The model has two layers:

1. **The Imajin tool surface** — what the agent can do *on the platform*. Tools, grants, delegation chain. Enforced by the kernel.
2. **The agent runtime (VM)** — where the agent *lives*. Its workspace, its plugins, its external API connections. Enforced by the runtime policy.

The tool surface is the same regardless of where the agent runs. The runtime varies: self-hosted (your machine, your rules) vs. platform-hosted (constrained VM with node operator limits).

---

## Problem

The moment a user's agent runs on Imajin infrastructure, we own the consequences:

1. **Context leakage** — Agent A sees data from User B's session
2. **Scope creep** — Agent accumulates permissions beyond its delegation
3. **Retention risk** — Agent remembers things it shouldn't across sessions
4. **Resource abuse** — Agent consumes unbounded compute, storage, or API calls
5. **Impersonation** — Agent acts as its owner without proper delegation chain
6. **Cross-agent interference** — One user's agent affects another's execution

Every agent orchestration framework in 2026 punts on this. They give agents tools and hope for the best. We can't — our agents have real identity, real money, and real consequences.

---

## Design Principles

1. **Tools, not shells.** Agents call platform-provided tools. No arbitrary code execution. No filesystem access outside their workspace. The tool surface IS the sandbox.

2. **Identity all the way down.** Every tool call carries the agent's DID + delegation chain. The kernel validates before executing. No anonymous operations.

3. **Visible by default.** The owner sees everything their agent does. Not after the fact — in real time. The agent's chat thread is the audit log.

4. **Scoped forgetting.** Agents don't accumulate context forever. Session boundaries are real. What persists is explicit, stored in the workspace, and visible to the owner.

5. **Delegation, not impersonation.** An agent acting on behalf of a user uses `X-Acting-As` with a valid delegation chain. The chain is verifiable. The action is attributed to both agent and principal.

---

## Architecture

### Execution Model

### Agent Naming

Agent handles follow the pattern `{username}-jin`:
- `veteze-jin` — Ryan's agent
- `baconjay-jin` — baconjay's agent
- `mooi-jin` — the Mooi community's agent

The `-jin` suffix (今人, "now-person") brands every agent on the network. It's personal — *your* jin — and it's recognizable. When you see `{anything}-jin` in a chat, you know it's an Imajin agent.

For users with multiple agents, append a qualifier: `veteze-jin`, `veteze-jin-travel`, `veteze-jin-bookkeeping`.

```
User ("@veteze")
  │
  │ delegates via identity_members (role: owner)
  │
Agent DID ("@veteze-jin")
  │
  │ authenticates with agent credentials
  │
Kernel Gateway
  │
  ├── validates DID + delegation chain
  ├── checks tool permissions against agent's grant set
  ├── enforces scope boundary
  ├── meters resource consumption
  ├── signs action to agent's chain
  │
  └── executes tool
```

### What an Agent Gets

| Resource | Description | Constraints |
|----------|-------------|-------------|
| **DID** | Ed25519 identity, registered `actor/agent` | Keypair held by agent, not platform |
| **Workspace** | Scoped storage for files, drafts, temp data | Quota-limited (default 100MB) |
| **Tool surface** | Set of callable kernel tools | Declared in agent grant, enforced by gateway |
| **Chat thread** | Communication channel with owner + other agents | All messages signed, owner always has read access |
| **Chain** | Append-only action log | Every tool call = chain entry |
| **Session context** | Working memory for current task | Cleared on session end unless explicitly persisted to workspace |

### What an Agent Does NOT Get

| Denied | Why |
|--------|-----|
| Shell access | Arbitrary execution = uncontrollable surface |
| Direct DB access | Agents use kernel APIs, never raw SQL |
| Cross-user data | Delegation chain scoped to owner's data only |
| Unbounded memory | Session context clears; workspace is quota'd |
| Network egress | No outbound HTTP unless granted specific URLs |
| Other agents' workspaces | Each agent's workspace is isolated |

---

## Tool Surface

Agents interact with the platform exclusively through **tools** — typed, permissioned, metered operations exposed by the kernel.

### Tool Categories

#### Identity & Context
| Tool | Permission | Description |
|------|-----------|-------------|
| `identity.whoami` | `identity:read` | Agent's own DID, delegation chain, current scope |
| `identity.resolve` | `identity:read` | Resolve a DID or handle to profile data |
| `identity.attestations.read` | `attestations:read` | Query attestations visible to the agent |
| `identity.attestations.emit` | `attestations:write` | Emit attestation (signed by agent DID) |

#### Communication
| Tool | Permission | Description |
|------|-----------|-------------|
| `chat.send` | `chat:write` | Send message to a conversation the agent is a member of |
| `chat.read` | `chat:read` | Read messages from conversations the agent is in |
| `chat.history` | `chat:read` | Retrieve conversation history (scoped to membership) |

#### Media & Files
| Tool | Permission | Description |
|------|-----------|-------------|
| `media.list` | `media:read` | List assets owned by or shared with the agent's principal |
| `media.read` | `media:read` | Read asset content |
| `media.upload` | `media:write` | Upload to principal's media (within quota) |
| `media.move` | `media:write` | Reorganize assets (folders, tags) |
| `workspace.read` | `media:read` | Read from agent's `.jin/` workspace (media operation) |
| `workspace.write` | `media:write` | Write to agent's `.jin/` workspace (media operation) |

#### Commerce
| Tool | Permission | Description |
|------|-----------|-------------|
| `pay.balance` | `pay:read` | Check principal's balance |
| `pay.settle` | `pay:write` | Execute .fair settlement (requires explicit delegation) |
| `discovery.search` | `discovery:read` | Search the registry |

#### Connections
| Tool | Permission | Description |
|------|-----------|-------------|
| `connections.list` | `connections:read` | List principal's connections |
| `connections.invite` | `connections:write` | Send connection invite on behalf of principal |

### Tool Execution Flow

```
Agent calls: chat.send({ conversationId: "abc", body: "Hello" })
    │
    ▼
1. Gateway receives tool call
2. Validate agent DID signature
3. Check delegation: does @veteze delegate chat:write to this agent?
4. Check scope: is agent authorized for this conversation's scope?
5. Check rate limit: under per-tool-per-agent budget?
6. Execute: kernel.chat.send(...)
7. Record: append to agent's chain
8. Meter: decrement gas
9. Return: result to agent
```

---

## Delegation Model

### Grant Set

When a user creates an agent, they define a **grant set** — the tools the agent is allowed to call. This is stored in `identity_members` metadata.

```json
{
  "agent_did": "did:imajin:DUUi6...",
  "owner_did": "did:imajin:6JSKE...",
  "role": "owner",
  "grants": [
    "identity:read",
    "chat:read",
    "chat:write",
    "media:read",
    "media:write",
    "attestations:read"
  ],
  "constraints": {
    "max_gas_per_day": 10000,
    "allowed_scopes": ["actor"],
    "network_egress": []
  }
}
```

### Grant Tiers

Pre-built permission sets for common use cases:

| Tier | Permissions | Use Case |
|------|------------|----------|
| **Observer** | `identity:read`, `chat:read`, `media:read`, `connections:read` | Monitoring, summarization, search |
| **Assistant** | Observer + `chat:write`, `media:write`, `workspace:*` | File organization, drafting, communication |
| **Operator** | Assistant + `attestations:write`, `connections:write` | Business operations, attestation workflows |
| **Transactor** | Operator + `pay:read`, `pay:write` | Commerce, settlement, financial operations |

Users can customize beyond tiers. The UI shows exactly what each permission means and what data the agent can access.

### Delegation Chain Verification

Every tool call includes a verifiable chain:

```
Owner: did:imajin:6JSKE... (@veteze)
  └─ delegates to: did:imajin:DUUi6... (@veteze-jin)
       role: owner
       grants: [chat:read, chat:write, media:read, ...]
       issued: 2026-04-20T...
       expires: null (persistent until revoked)
```

The kernel validates this chain on every call. If the delegation is revoked, all tool calls fail immediately. No cached permissions. No stale grants.

---

## Context Boundaries

### Session Model

An agent **session** is a bounded execution context:

```
Session {
  id: uuid
  agent_did: "did:imajin:..."
  started_at: timestamp
  context_window: []          // working memory for this session
  tools_called: []            // audit trail
  gas_consumed: number
  status: active | completed | revoked
}
```

**Session lifecycle:**
1. **Start** — agent authenticates, session created, context is empty
2. **Execute** — agent calls tools, context accumulates, chain grows
3. **End** — session completes, context is cleared
4. **Persist** — agent explicitly writes to workspace anything it wants to remember

### What Persists vs. What Clears

| Data | Lifecycle | Storage |
|------|-----------|---------|
| Session context (working memory) | Cleared on session end | Ephemeral |
| Workspace files | Persists across sessions | Agent workspace (quota'd) |
| Chain entries | Permanent | DFOS chain |
| Chat messages | Permanent | Kernel chat |
| Tool call audit log | Permanent | `registry.agent_audit_log` |

### The Forgetting Rule

**Agents forget by default.** Session context does not carry over. If an agent needs to remember something, it must explicitly write it to its workspace.

This is a security boundary, not a limitation:
- Prevents context accumulation attacks (agent slowly builds a profile of data it shouldn't retain)
- Makes retention auditable (workspace files are inspectable by the owner)
- Aligns with the principle that the chain is the memory, not the model

### Context Isolation

Agent sessions are strictly isolated:

- **No cross-agent context** — Agent A's session cannot read Agent B's session data
- **No cross-user context** — Agent serving User A cannot access User B's delegation
- **No cross-session bleed** — Previous session's working memory is gone
- **Workspace is private** — Each agent's workspace is only accessible to that agent and its owner

---

## Workspace

### No Separate Storage — It's the User's Media

The agent doesn't get a separate allocation. It lives in the user's existing media folder. The same `media.assets` system that handles profile photos, event assets, and file uploads now also serves as the agent's workspace.

```
/mnt/media/{did_path}/
├── assets/                 # User's existing media (photos, docs, etc.)
├── folders/                # User's folder structure
└── .jin/                   # Agent home
    ├── config.json         # Agent preferences, egress allowlist, grants
    ├── workspace/          # Agent's working files, drafts, temp data
    ├── memory/             # Agent's persistent notes across sessions
    └── {runtime}/          # Runtime-specific state
        ├── openclaw/       # e.g., MEMORY.md, SOUL.md, skills/
        ├── n8n/            # e.g., workflows, credentials
        └── ...             # Any MCC-compatible runtime
```

### Why This Works

**Media already has the primitives:**
- **Storage quotas** — `media.assets` already tracks per-identity storage usage and enforces limits. The agent's files count against the user's existing quota. No new metering system needed.
- **Folder structure** — `media.folders` already provides organization. The agent can create folders, move files, tag assets — using the same system the user already has.
- **.fair attribution** — every file the agent creates gets a `.fair` manifest. Attribution is automatic.
- **Access control** — media already respects identity scoping. The agent sees what its delegation grants allow, nothing more.

**The agent is a resident, not a tenant.** It doesn't need its own infrastructure — it uses the user's. Organizing files, managing drafts, caching data — it's all just media operations on the user's existing space.

### Storage Limits

Agent storage counts against the user's media quota. No separate agent quota needed.

| Resource | Governed By |
|----------|------------|
| Total storage | User's media quota (existing) |
| File size limits | Media service limits (existing) |
| Chain entries per day | Gas budget (see Gas Metering) |

If the user's media quota is full, the agent can't write — same as if the user tried to upload. The agent gets a clear error and can notify the owner.

### Owner Access

The owner has full read access to `.jin/` at all times — it's in their media folder. No hidden state. The workspace is the agent's "mind" — the owner can browse it in the media UI, inspect any file, and intervene.

```
Agent Management UI
  └── Agent: @veteze-jin
       ├── Chain Viewer (all signed actions)
       ├── Workspace Browser (→ media UI for .jin/)
       ├── Session History (past sessions + context snapshots)
       ├── Grant Editor (add/remove permissions)
       └── Kill Switch (immediate revocation)
```

---

## Gas Metering

Agent tool calls consume gas, same model as RFC-25 app runtime.

### Gas Costs

| Tool Category | Gas per Call |
|---------------|-------------|
| Identity reads | 1 |
| Chat read | 1 |
| Chat write | 2 |
| Media read | 1 |
| Media write | 5 |
| Workspace read/write (.jin/) | 0 (free — it's their space, uses existing media quota) |
| Attestation read | 2 |
| Attestation write | 5 |
| Connection operations | 2 |
| Payment read | 2 |
| Payment settle | 10 |
| Discovery search | 3 |

### Gas Budgets

| Agent Tier | Daily Gas | Monthly Cost |
|------------|-----------|--------------|
| Free (first agent) | 1,000 | $0 |
| Standard ($10/mo) | 50,000 | $10 |
| Pro ($25/mo) | 200,000 | $25 |
| Unlimited | ∞ | $50/mo + overage |

Gas costs are denominated in abstract units today. When MJN launches, gas = MJN. The pricing table is the bridge.

---

## Network Egress

By default, agents have **no outbound network access**. They operate entirely within the kernel's tool surface.

### Granting Egress

Owners can grant specific URL patterns:

```json
{
  "network_egress": [
    "https://api.openai.com/*",
    "https://api.weather.gov/*"
  ]
}
```

The gateway proxies outbound requests, enforcing:
- URL allowlist (exact prefix match)
- Method restrictions (GET/HEAD by default)
- Response size limits
- Rate limiting
- Audit logging (every outbound request is a chain entry)

This is intentionally restrictive. An agent that needs to call arbitrary URLs is a red flag. The tool surface should provide what the agent needs; egress is an escape hatch, not the default path.

---

## Security Model

### Threat Matrix

| Threat | Mitigation |
|--------|------------|
| Agent reads another user's data | Delegation chain validation on every tool call. No delegation = no access. |
| Agent retains data across sessions | Session context cleared. Workspace is inspectable. |
| Agent accumulates excessive permissions | Grant set is explicit. No implicit escalation. Owner reviews in UI. |
| Agent impersonates owner | `X-Acting-As` requires valid delegation chain. Chain entry attributes both agent and principal. |
| Rogue agent consumes all resources | Gas metering + daily budgets + workspace quotas. |
| Agent communicates with external services | Network egress denied by default. Allowlist required. |
| Agent colludes with another agent | No cross-agent context. Communication only via signed chat messages (auditable). |
| Owner loses control of agent | Kill switch = immediate delegation revocation. All tool calls fail. Chain preserved for audit. |
| Agent chain is tampered with | DFOS chain is append-only, hash-linked, signed. Tampering is detectable. |

### The Kill Switch

Every agent has an immediate revocation path:

1. Owner clicks "Revoke" in Agent Management UI
2. Delegation is revoked in `identity_members`
3. All active sessions are terminated
4. All pending tool calls fail with `DELEGATION_REVOKED`
5. Chain entry records the revocation
6. Workspace is preserved (owner can inspect what happened)
7. Agent DID remains on the network (chain is historical record)

Revocation is instant and irreversible. A revoked agent can be re-granted access, but it starts with a clean session — no context carryover from pre-revocation.

---

## Runtime Layer: Where the Agent Lives

Everything above describes what happens when the agent talks to the Imajin kernel — the **tool surface**. But the agent also needs somewhere to *live*: to run its LLM, store its memory, install plugins, connect external APIs. That's the **runtime layer**.

Today, this is an agent runtime (OpenClaw, n8n, custom code — anything) with a WebSocket connection to the Imajin chat service. Jin (the first agent) runs on a full deployment with SSH access, filesystem access, email access, coding tools — everything. That's fine when the agent operator and the node operator are the same person. It's catastrophic when they're not.

### The Two-Layer Model

```
┌─────────────────────────────────────────────────┐
│              Agent Runtime (VM)                  │
│                                                  │
│   LLM inference (model calls)                    │
│   Agent workspace (files, notes, memory)         │
│   Installed plugins/tools                        │
│   External API connections (user-configured)     │
│   ┌──────────────────────────────────────────┐   │
│   │ Constrained by: VM policy                │   │
│   │   - Resource limits (CPU, RAM, storage)  │   │
│   │   - Network egress allowlist             │   │
│   │   - Plugin allowlist                     │   │
│   │   - No host access                       │   │
│   └──────────────────────────────────────────┘   │
│                     │                            │
│                     │ WebSocket                  │
│                     ▼                            │
│   ┌──────────────────────────────────────────┐   │
│   │ Imajin Connector (protocol adapter)     │   │
│   │   - Authenticates with agent DID         │   │
│   │   - Routes tool calls to kernel          │   │
│   │   - Receives messages from chat          │   │
│   │   (OpenClaw plugin, n8n node, SDK, etc.) │   │
│   └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
                     │
                     │ Tool calls (over WebSocket)
                     ▼
┌─────────────────────────────────────────────────┐
│          Imajin Kernel (Tool Surface)            │
│                                                  │
│   Validates DID + delegation chain               │
│   Checks grant set                               │
│   Meters gas                                     │
│   Executes tool                                  │
│   Records to chain                               │
└─────────────────────────────────────────────────┘
```

The kernel doesn't know or care about the runtime layer. It validates the tool call, checks the delegation, meters the gas, records to the chain. Whether the agent is running on a user's laptop, a $5 VPS, or an Imajin-hosted VM — the kernel sees the same DID, the same signed request.

The runtime layer is where the differentiation happens.

### Self-Hosted vs. Platform-Hosted

| | Self-Hosted | Platform-Hosted |
|---|-------------|----------------|
| **Where it runs** | User's hardware (laptop, VPS, Pi) | Imajin node operator's infrastructure |
| **Who configures it** | User (full control) | User within node operator's policy |
| **Resource limits** | Whatever the hardware supports | Quota'd by tier (CPU, RAM, storage) |
| **Plugin installation** | Unrestricted | Allowlisted by node operator |
| **External API access** | Unrestricted | User-configurable within operator's egress policy |
| **Imajin tool access** | Same (grant set governs) | Same (grant set governs) |
| **Cost to user** | Their own compute costs | Included in agent subscription |
| **Node operator liability** | None — user's machine | Full — operator hosts the VM |

**Self-hosted** agents run on user hardware — could be OpenClaw, n8n, a Python script, anything that speaks the Imajin agent protocol (WebSocket + signed tool calls). The node enforces the tool surface; the user's machine enforces nothing else. This is the power-user path — full control, full responsibility.

**Platform-hosted** agents run in constrained VMs on node operator infrastructure. This is the easy path — sign up, get an agent, it's running. But the node operator now hosts someone else's AI, so the VM must be sandboxed.

### Platform-Hosted VM Policy

A platform-hosted agent VM is a runtime container with a restricted configuration. The runtime is agnostic — the node operator chooses what to offer (could be OpenClaw, n8n, a lightweight custom runtime, or multiple options):

#### Compute
| Resource | Default | Max |
|----------|---------|-----|
| CPU | 0.5 vCPU | 2 vCPU |
| RAM | 512 MB | 2 GB |
| Storage | 1 GB | 10 GB |
| Session concurrency | 1 | 4 |

#### Network
- **Imajin node:** Always reachable (WebSocket to chat service)
- **LLM providers:** Allowlisted by default (OpenAI, Anthropic, Google, common providers). User brings their own API key.
- **User-configured APIs:** User adds URLs to their egress allowlist. Node operator sets a ceiling (e.g., max 20 egress URLs, GET/HEAD only by default, POST requires operator approval).
- **Everything else:** Denied.

#### Plugins
- **Imajin channel plugin:** Always installed (the connection to the node)
- **Approved plugins:** Node operator maintains an allowlist. Users install from the list.
- **Custom plugins:** Require node operator review before activation.

#### Filesystem
- **Agent workspace:** Read/write, quota'd
- **Runtime config:** Read-only (operator-managed base config)
- **Host filesystem:** Inaccessible
- **Other agent VMs:** Inaccessible

#### What's Stripped vs. Self-Hosted

| Capability | Self-Hosted (user's machine) | Agent VM (platform-hosted) |
|-----------|---------------------------|---------------------------|
| SSH to external hosts | ✅ | ❌ |
| Arbitrary shell commands | ✅ | ❌ |
| Email access | ✅ (user configures) | ❌ (unless plugin allowlisted) |
| Coding agents / sub-agents | ✅ | ❌ (or sandboxed within the VM) |
| Browser automation | ✅ | ❌ |
| File system (full machine) | ✅ | ❌ (workspace only) |
| External API calls | ✅ (unrestricted) | Allowlisted URLs only |
| Model selection | ✅ (any provider) | Allowlisted providers + user's API key |
| Plugin installation | ✅ (any) | Operator-approved list |
| Imajin tool surface | Grant set | Grant set (identical) |

The agent VM is a runtime with the dangerous bits removed. It can still think, remember, use tools, connect to external APIs the user configures — but it can't escape its container.

### External APIs: The Value Add

This is where paying for a platform-hosted agent makes sense beyond the Imajin tool surface:

**"My agent can pull from my Shopify, check my QuickBooks, query my CRM — and bring all that context into my Imajin workspace."**

The user connects their external services through the agent's egress allowlist:

```json
{
  "egress_allowlist": [
    {
      "url": "https://mystore.myshopify.com/admin/api/*",
      "methods": ["GET"],
      "auth": "user_provided"  
    },
    {
      "url": "https://api.openweathermap.org/*",
      "methods": ["GET"],
      "auth": "user_provided"
    },
    {
      "url": "https://api.quickbooks.intuit.com/*",
      "methods": ["GET", "POST"],
      "auth": "user_provided",
      "requires_operator_approval": true
    }
  ]
}
```

The agent VM proxies these calls through the egress gateway. Credentials are stored in the user's workspace (encrypted, never visible to the node operator). The egress gateway logs the call (URL, method, response status, timestamp) but not the payload — the user's data stays between them and the external service.

This creates a natural upsell path:
- **Free agent:** Imajin tools only. No external APIs.
- **Standard ($10/mo):** 5 egress URLs, GET/HEAD only.
- **Pro ($25/mo):** 20 egress URLs, all methods, higher compute.
- **Enterprise:** Custom egress policy, dedicated VM, SLA.

### Credential Isolation

The hardest problem with external APIs: the agent needs credentials, but the node operator shouldn't see them.

**Model:** User provides API keys through the agent management UI. Keys are encrypted with the user's public key (derived from their DID keypair) and stored in the agent's workspace. The VM decrypts at runtime using a session-scoped key derived from the authentication handshake. The node operator's filesystem shows encrypted blobs.

This isn't perfect — a sufficiently motivated node operator with host access could instrument the VM to capture decrypted keys at runtime. But it raises the bar significantly and makes credential theft a detectable, attributable act (the node operator's chain would show the intrusion if we instrument the VM properly).

For high-security use cases: self-host. The platform-hosted model is convenience with reasonable security, not a vault.

---

## Relationship to RFC-25 (App Runtime)

RFC-25 sandboxes **apps** (third-party code running in containers). RFC-31 sandboxes **agents** (AI actors using tools).

| | RFC-25 (Apps) | RFC-31 (Agents) |
|---|---------------|-----------------|
| **What runs** | Developer's code (Node.js, WASM) | LLM + tool calls |
| **Isolation** | Container + network + DB schema | Tool surface + delegation chain |
| **Storage** | Isolated Postgres schema | Workspace directory (files) |
| **Metering** | Gas per API call | Gas per tool call |
| **Identity** | App DID | Agent DID |
| **Who controls** | Node operator approves | User creates + grants |
| **Code execution** | Yes (sandboxed) | No (tools only) |
| **Network** | Gateway-proxied | Denied by default |

They share the same gateway infrastructure. An agent's tool call and an app's API call flow through the same metering and audit pipeline. The difference is trust: apps run code you can inspect; agents run models you can't — so the boundary must be tighter.

### Convergence Path

A future where agents *use* apps: Agent calls `discovery.search`, finds a booking app, calls `app.booking.listSlots` through the gateway. The app's permissions and the agent's grants are both checked. Double sandbox. This is the MCC vision from RFC-27 made concrete.

---

## Relationship to RFC-27 (MCC)

RFC-27 defines the coordination layer: how agents talk to each other, how the router works, how chains record decisions. RFC-31 defines the execution layer: what happens when an agent actually *does* something.

| | RFC-27 | RFC-31 |
|---|--------|--------|
| **Focus** | Coordination between agents | Individual agent execution |
| **Key concept** | Router, fan-out, chain replay | Tool surface, grants, workspace |
| **Trust model** | Agent-to-agent via signed chat | Agent-to-kernel via delegation chain |
| **Scope** | Multi-agent orchestration | Single agent boundaries |

They compose: RFC-27's router dispatches tasks → RFC-31's sandbox executes them → RFC-27's chain records the results.

---

## Implementation Phases

### Phase 1: Tool Gateway (Near-term)
- [ ] Define tool schema (typed inputs/outputs per tool)
- [ ] Gateway validates agent DID + delegation on every call
- [ ] Gas metering (per-tool costs, daily budgets)
- [ ] Audit log (every tool call → `registry.agent_audit_log`)
- [ ] Agent workspace (directory creation, quota enforcement)

### Phase 2: Grant Management UI
- [ ] Agent creation flow with grant tier selection
- [ ] Grant editor (add/remove individual permissions)
- [ ] Workspace browser (owner inspects agent's files)
- [ ] Kill switch (immediate revocation)
- [ ] Session history viewer

### Phase 3: Context Enforcement
- [ ] Session lifecycle (create → execute → clear)
- [ ] Context isolation validation (cross-agent, cross-user, cross-session)
- [ ] Workspace quota enforcement
- [ ] Retention audit (flag agents with suspicious workspace growth)

### Phase 4: Network Egress Controls
- [ ] URL allowlist gateway proxy
- [ ] Method and response size restrictions
- [ ] Egress audit logging
- [ ] Owner approval flow for new egress URLs

### Phase 5: Platform-Hosted VM Runtime
- [ ] Agent VM image with restricted base config (runtime-agnostic spec)
- [ ] Container orchestration (create, start, stop, destroy per agent)
- [ ] Resource limits enforcement (CPU, RAM, storage quotas)
- [ ] VM egress gateway (separate from kernel egress — handles external API proxying)
- [ ] Credential encryption (user keys encrypted at rest, decrypted per-session)
- [ ] Plugin allowlist enforcement
- [ ] User-facing VM config UI (egress URLs, API keys, plugin selection)
- [ ] Node operator admin (VM fleet management, policy editor, resource monitoring)

### Phase 6: Agent ↔ App Integration
- [ ] Agents discover and call app tools through the gateway
- [ ] Double permission check (agent grants + app permissions)
- [ ] Cross-sandbox metering (agent gas + app gas)

---

## Open Questions

1. **Workspace encryption at rest?** Agent workspace files sit on the node operator's disk. Should they be encrypted with the owner's key? Adds complexity, prevents node operator snooping. (Partially addressed by credential isolation model above, but extends to all workspace data.)

2. **Agent-to-agent workspace sharing?** Two agents owned by the same user might need to share files. Explicit share mechanism, or shared workspace tier?

3. **Offline agents.** If an agent's node goes down, its tools are unreachable. Should there be a session resume protocol, or do agents simply restart?

4. **Model selection for platform-hosted VMs.** The node operator allowlists LLM providers, but the user picks their model and provides their API key. Should there be model-level constraints (e.g., "no models below safety rating X") or is provider-level allowlisting sufficient?

5. **Gas pricing for external models.** If an agent calls an LLM (via egress) as part of its reasoning, that's expensive compute not captured by tool-call gas. Should model inference be a metered tool?

6. **Workspace versioning.** Should workspace writes be versioned (like a mini git)? Enables rollback if an agent corrupts its own state. Adds storage overhead.

7. **VM escape detection.** For platform-hosted VMs, how do we detect if an agent attempts to escape its container? Instrumentation overhead vs. security. Probably container-level monitoring (seccomp, AppArmor) rather than application-level.

8. **Self-hosted agent verification.** A self-hosted agent can lie about its capabilities, skip safety checks, forge tool responses. The kernel validates tool *calls* but can't validate what happens *between* calls. Is this acceptable? Does the chain + tool-call audit provide enough accountability?

9. **Migration between self-hosted and platform-hosted.** Can a user move their agent (workspace, chain, grants) from self-hosted to platform-hosted and back? Workspace portability is straightforward; VM config translation is harder.

---

## Why Pay for a Sandboxed Agent?

The sandbox looks like a constraint. It's actually the product.

### The Value Isn't "Agent That Can Do Stuff"

Anyone can run an AI agent locally with zero restrictions. Call APIs, read files, do whatever. That agent is free and unlimited. It's also **invisible** — nobody else can verify what it did, trust its output, or hold it accountable.

The value of an Imajin agent isn't capability — it's **legibility in a multi-party context.**

| Feature | Local Agent (free) | Imajin Agent (paid) |
|---------|-------------------|---------------------|
| Can send messages | Yes (if you wire up APIs) | Yes — signed, attributed, verifiable |
| Can move money | Yes (if you have Stripe keys) | Yes — with .fair attribution, fee splits, chain record |
| Can organize files | Yes | Yes — with attestation trail |
| Counterparty can verify actions | No | Yes — delegation chain + signed history |
| Builds reputation over time | No | Yes — chain is the resume |
| Trusted by other agents/apps | No — anonymous process | Yes — DID with verifiable history |
| Auditable for compliance | Only if you build logging | By default — every action is a chain entry |
| Survives "I didn't authorize that" | No proof either way | Delegation chain proves authorization |

**The sandbox is what makes the chain trustworthy.** Without boundaries, chain entries are meaningless — anything could have been injected. With boundaries, every entry was gated by identity, delegation, and scope. The chain becomes *evidence*.

### Tools Are Higher Than Shell

The tool surface isn't "a shell with stuff removed." It's purpose-built operations that encapsulate complex multi-step workflows:

- `pay.settle` → .fair manifest resolution + Stripe settlement + fee splitting + MJNx reconciliation + chain recording. One call. Hundreds of lines of logic.
- `identity.attestations.emit` → schema validation + issuer signing + chain append + scope enforcement + notification. Not a `POST` to an endpoint.
- `media.upload` → quota check + dedup + .fair manifest creation + storage + folder linking + chain entry.

A local agent calling raw APIs would need to reimplement all of this, correctly, every time. The tools aren't a restriction on what the agent can do — they're an elevation of *how* it does it.

### Who Pays and Why

**Individuals:** "My agent can message people, manage my files, and its actions are verifiable. It builds a history that means something." — The assistant tier ($10/mo or free for the first agent).

**Businesses:** "My agent handles customer communication, issues attestations, processes payments — all auditable, all compliant, all attributable to my business identity." — The transactor tier. The 1% settlement fee is the real revenue here, not the subscription.

**The enterprise pitch:** "Your agents operate within provable boundaries. Every action is signed. Every authorization is traceable. When the regulator asks 'did this agent have permission to do that?' — you show the chain. Try doing that with a Python script."

### Tool Surface Expansion Strategy

The tool surface is a living API, not a fixed spec. Expansion follows demand:

1. **Watch what agents try and fail.** Every `PERMISSION_DENIED` or tool-not-found is a signal. If 50 agents try to do something the surface doesn't support, that's the next tool to build.
2. **App tools extend the surface.** When apps register on the platform (RFC-25), their capabilities become available as agent tools. The booking app adds `booking.listSlots`, `booking.reserve`. The inventory app adds `inventory.check`, `inventory.reorder`. The surface grows with the ecosystem.
3. **Community-driven tools.** Developers can propose new kernel tools through the registry. Node operators opt in. Popular tools graduate to core.
4. **Composition over accumulation.** Rather than adding hundreds of narrow tools, make existing tools composable. An agent that can `chat.send` + `media.upload` + `attestations.emit` can build workflows the tool designer never imagined.

The goal: **within six months of launch, the tool surface should cover 90% of what a user would do on the platform manually.** The remaining 10% is either too dangerous to automate (and shouldn't be a tool) or too niche to prioritize (and gets added when demand proves otherwise).

---

*"The sandbox isn't a container. It's the absence of everything you didn't explicitly grant."*
