---
title: Jin Workspace Agent Architecture
type: rfc
status: draft
date: March 15, 2026
author: Ryan Veteze + Jin
slug: RFC-16-jin-workspace-agent
topics:
  - fair
  - identity
  - agents
  - dfos
  - settlement
  - governance
  - events
  - federation
  - sovereignty
refs:
  rfcs:
  - 9
  issues:
  - 256
  - 344
  - 139
  - 153
  - 250
  - 336
  - 43
  - 44
  - 111
  - 338
  - 260
  - 45
  - 347
  - 110
  - 113
  - 115
  - 117
  - 244
  - 351
  - 321
  - 346
  - 163
  - 155
  packages:
  - "@imajin/llm"
---
# RFC-16: Jin Workspace Agent Architecture

**Author:** Ryan Veteze + Jin
**Date:** March 15, 2026
**Status:** Draft
**Discussion:** none
**Scope:** Presence system, workspace UI, agent runtime, memory, identity

---

## Summary

Jin evolves from a chat-completion endpoint into a workspace-native agent with persistent memory, a distinct identity, a canvas-based UI, and a pluggable agent runtime. Users interact with Jin through a spatial workspace — not a chat box — where Jin surfaces documents, calendars, photos, and context as visual panels. Multiple Jin instances (1–4) can coexist in a workspace, communicate with each other, and are governed by the trust graph.

---

## Motivation

The current presence system (`profile/[id]/stream`) is a thin wrapper around `streamText` with scoped tools. It works, but:

1. **Stateless.** Every query re-derives knowledge from scratch. Someone asks "analyze essay 3" and the presence reads the file, analyzes it, and responds. Next person asks the same thing — identical work, potentially different result. There's no accumulated understanding.

2. **Identity confusion.** "Talk to Ryan's presence" is uncanny valley. You're not talking to Ryan. When Ryan himself uses it, he's talking to himself. The identity model is wrong.

3. **Chat box is limiting.** A linear text thread can't show documents, calendars, photos, and analysis side-by-side. Everything gets flattened into scrolling text. You lose spatial context.

4. **No real agency.** The presence can answer questions, but it can't do background work, maintain state across sessions, or orchestrate tasks. It's reactive, not proactive.

5. **Coupled to one runtime.** All inference runs through our streaming endpoint. No path for users who want more capable agents or self-hosted runtimes.

---

## Design

### 1. Jin as a Distinct Identity

Jin is not a shadow of the user. Jin is a separate entity that *knows* the user.

**Identity model:**
- Each Jin instance gets its own agent DID: `did:imajin:jin:{owner-handle}`
- The owner's human DID (`did:imajin:veteze`) and their Jin's DID (`did:imajin:jin:veteze`) are explicitly separate
- Jin's DID appears in attestations, signed interactions, and the trust graph
- The trust relationship between owner and Jin is the root of Jin's authority

**Naming:**
- Ryan's Jin is "Ryan-Jin" (or just "Jin" in context)
- Debbie's Jin is "Debbie-Jin"
- Users may rename their Jin instance

**Implications:**
- Ryan talks *to* Jin, not to himself
- Jin can act on Ryan's behalf within scoped authority
- Jin-to-Jin communication is agent-to-agent, governed by trust distance between the *owners*
- Jin's actions are attributable to Jin's DID, not the owner's

### 2. Two-Layer Memory

Two distinct memory systems, both keyed to DIDs.

#### Knowledge Memory (derived understanding)

When Jin analyzes a document, the result is stored as a knowledge artifact.

```typescript
interface KnowledgeStore {
  // Store derived analysis tied to content hash
  put(entry: {
    contentHash: string;       // SHA-256 of source document
    assetId: string;           // media asset reference
    queryType: string;         // "summary" | "analysis" | "extract" | custom
    derivedContent: string;    // the analysis result
    model: string;             // model that produced it
    derivedAt: Date;
  }): Promise<void>;

  // Retrieve cached analysis
  get(contentHash: string, queryType: string): Promise<KnowledgeEntry | null>;

  // Find all knowledge derived from a source
  byAsset(assetId: string): Promise<KnowledgeEntry[]>;

  // Invalidate when source changes
  invalidate(contentHash: string): Promise<void>;
}
```

**Invalidation rules:**
- Content change (new SHA-256) → invalidate automatically
- Time-based revalidation configurable per-entry (default: 30 days)
- Manual invalidation by owner
- Model upgrade → optional bulk revalidation

**Storage:** File-backed in `.imajin/knowledge/` (one JSON file per content hash). Portable with the user's data bundle.

#### Conversation Memory (relationship context)

What Jin knows about its interactions with each person.

```typescript
interface ConversationMemory {
  // Append an interaction summary
  append(entry: {
    requesterDid: string;
    ownerDid: string;
    summary: string;           // distilled interaction, not raw transcript
    topics: string[];
    sentiment?: string;
    timestamp: Date;
  }): Promise<void>;

  // Get context for a returning visitor
  getContext(requesterDid: string): Promise<ConversationEntry[]>;

  // Prune old entries (time decay)
  prune(olderThan: Date): Promise<number>;
}
```

**Storage:** File-backed in `.imajin/memory/` (one file per requester DID). Follows the daily-file pattern from OpenClaw's memory system.

**Interaction between layers:** When someone asks about a document, Jin checks knowledge memory first. If fresh, serves from cache. If stale or missing, re-derives and stores. Conversation memory tracks *who asked about what* and *what they cared about*, enabling personalized responses on return visits.

### 3. Workspace Canvas UI

Replace the chat box with a spatial workspace.

#### Layout

```
┌───────────┬────────────────────────────┬───────────────┐
│           │                            │               │
│  Jin      │     Workspace Canvas       │   Detail /    │
│  Sidebar  │                            │   Inspector   │
│           │  ┌──────────┐ ┌──────────┐ │               │
│  Ryan-Jin │  │ Document │ │ Calendar │ │   Selected    │
│  (active) │  │ Panel    │ │ Panel    │ │   panel       │
│           │  └──────────┘ └──────────┘ │   detail      │
│  Debbie   │  ┌──────────┐ ┌──────────┐ │               │
│  -Jin     │  │ Photos   │ │ Chat     │ │   💬 thread   │
│           │  │ Grid     │ │ Thread   │ │               │
│  Project  │  └──────────┘ └──────────┘ │               │
│  -Jin     │                            │               │
│           │                            │               │
└───────────┴────────────────────────────┴───────────────┘
```

#### Concepts

- **Jin Sidebar:** Switch between Jin instances (1–4 in workspace). Shows which is active, status of each.
- **Canvas:** Spatial area where Jin surfaces content as panels. Documents, calendars, photo grids, code diffs, link collections. Jin arranges; user can rearrange.
- **Panels:** Each panel is a typed content view. Jin can create, update, and dismiss panels. User can pin, resize, or close them.
- **Detail/Inspector:** Right sidebar for inspecting a selected panel in depth. Also houses the chat thread — but as one element, not the whole UI.
- **Chat Thread:** Conversational interface with Jin. Always available but not dominant. Think of it as the "voice channel" — how you talk to Jin while the canvas is the "visual channel."

#### Panel Types (initial set)

| Type | Source | Content |
|------|--------|---------|
| `document` | Media asset | Rendered text/markdown, with .fair badge |
| `calendar` | Events service | Upcoming events, availability |
| `photos` | Media assets | Grid of images, filterable |
| `links` | Media/extracted | Bookmarks, references, URLs |
| `chat` | Conversation | The conversational thread |
| `code` | Media asset | Syntax-highlighted code view |
| `summary` | Knowledge memory | Cached analysis of a document |

#### Jin Actions → Panel Operations

When Jin decides to show something, it emits a panel operation:

```typescript
type PanelOp =
  | { action: "open"; panelType: string; data: unknown; position?: "auto" | "left" | "right" }
  | { action: "update"; panelId: string; data: unknown }
  | { action: "close"; panelId: string }
  | { action: "highlight"; panelId: string; selector: string }
```

These are streamed alongside text responses. The workspace UI interprets them. This keeps the agent runtime agnostic to the UI framework — it just emits operations.

### 4. Agent Runtime Interface

Jin's capabilities come from a pluggable agent runtime. The interface is what Imajin owns; implementations can vary.

```typescript
interface AgentRuntime {
  // Identity
  readonly agentDid: string;
  readonly ownerDid: string;

  // Conversation
  stream(messages: Message[], tools: Tool[]): AsyncIterable<StreamChunk>;

  // Memory
  readonly knowledge: KnowledgeStore;
  readonly memory: ConversationMemory;

  // Capabilities (optional, runtime-dependent)
  exec?(command: string): Promise<ExecResult>;
  searchWeb?(query: string): Promise<SearchResult[]>;
  readFile?(path: string): Promise<string>;
  writeFile?(path: string, content: string): Promise<void>;
  schedule?(task: ScheduledTask): Promise<void>;

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;
  heartbeat?(): Promise<HeartbeatResult>;
}
```

#### Tier 1: Built-in Runtime

Ships with Imajin. No external dependencies.

- `stream()` → calls `streamText` with `@imajin/llm` tools (current behavior, enhanced)
- `knowledge` → file-backed in `.imajin/knowledge/`
- `memory` → file-backed in `.imajin/memory/`
- No `exec`, `searchWeb`, `schedule` — limited capability set
- Runs in-process on the Imajin server

Good enough for: answering questions about your content, surfacing documents, basic presence interactions.

#### Tier 2: OpenClaw Runtime

Connects to an OpenClaw instance (self-hosted or managed).

- `stream()` → proxies through OpenClaw session
- `knowledge` / `memory` → backed by OpenClaw's memory system (MEMORY.md + daily files + semantic search)
- Full `exec`, `searchWeb`, `readFile`, `writeFile`, `schedule` support
- Background tasks, heartbeats, sub-agent spawning
- Node access (cameras, screens, devices)
- Canvas rendering

Good enough for: autonomous work, proactive behavior, multi-surface communication, real agency.

#### Tier N: Other Runtimes

The interface is open. Any agent framework that implements `AgentRuntime` can plug in:
- Local LLM runtimes (Ollama, llama.cpp)
- Other agent frameworks (LangGraph, CrewAI, AutoGen)
- Custom implementations

The trust graph and DID system don't care what's behind the interface. They only care about signed interactions.

### 5. Jin-to-Jin Communication

When multiple Jins exist in a workspace (or across the network), they communicate through a message protocol governed by trust distance.

```typescript
interface JinMessage {
  fromDid: string;         // sender Jin's agent DID
  toDid: string;           // recipient Jin's agent DID
  type: "query" | "inform" | "request" | "response";
  content: string;
  context?: string;        // why this message is being sent
  trustChain: string[];    // DID chain establishing trust path
  signature: string;       // signed by sender
}
```

**Trust gating:**
- Jin-to-Jin communication requires trust distance ≤ N between the *owners* (configurable, default: 2)
- Each Jin can only share information its owner has marked as accessible at that trust level
- .fair access rules apply to any content shared between Jins

**Workspace local:** Within a single workspace, Jins can communicate directly (same trust context). Cross-network communication goes through the registry.

---

## Migration Path

### Phase 1: Memory + Identity (near-term)
- Implement `KnowledgeStore` and `ConversationMemory` (file-backed)
- Create agent DID for Jin instances (`did:imajin:jin:{handle}`)
- Wire memory into existing streaming endpoint
- Update UI to show "Jin" as the conversation partner, not the user's name

### Phase 2: Workspace UI (medium-term)
- Build canvas layout (sidebar + canvas + inspector)
- Implement panel types (document, calendar, photos, chat)
- Add PanelOp emission to streaming responses
- Chat thread moves to inspector sidebar

### Phase 3: Runtime Interface (medium-term)
- Extract `AgentRuntime` interface
- Implement Tier 1 (built-in) as refactor of current streaming
- Implement Tier 2 (OpenClaw) as bridge adapter
- Multi-Jin workspace support (1–4 instances)

### Phase 4: Jin Network (longer-term)
- Jin-to-Jin message protocol
- Cross-instance knowledge sharing (trust-gated)
- Managed OpenClaw instances for non-self-hosters
- Runtime marketplace (pluggable adapters)

---

## Open Questions

1. **Panel layout persistence.** Does the workspace layout save per-user? Per-session? Both?
2. **Knowledge cache storage limits.** How much derived knowledge per user before pruning? Tied to pay balance?
3. **Jin personality divergence.** If Jin has conversation memory with many people, does it develop per-relationship personality? Is that desirable?
4. **OpenClaw API stability.** Is OpenClaw's protocol stable enough to build an adapter against, or do we need to pin to a version?
5. **Managed instances.** Who runs the OpenClaw instances for users who don't self-host? Is this a revenue stream?
6. **ZERR integration.** Where does ZERR fit? Possible adapter for ConversationMemory, but needs evaluation of code quality and protocol stability.

---

## References

- #256 — Epic: Sovereign Inference
- #344 — Presence boundary enforcement + abuse attestations
- #139 — ZERR Integration
- #153 — ZERR keypair exchange
- #250 — Media context routing
- #336 — Trust graph query engine
- Network of Souls (2026-02-18 brainstorm)
- OpenClaw source: github.com/openclaw/openclaw (MIT)

---

*This RFC captures a conversation between Ryan and Jin on March 15, 2026. Five connected insights that reshape how presence works on the Imajin platform.*

---

## Addendum: Operational Layer (March 17, 2026)

*The RFC above covers architecture — identity, memory, UI, runtime. This addendum covers the operational layer: Jin acting in the world, not just answering questions about it.*

### 6. Economic Agency

Jin can take economic actions on behalf of the owner, within scoped authority.

```typescript
interface AgentAuthority {
  ownerDid: string;
  agentDid: string;

  // Spending limits
  maxPerTransaction: number;     // e.g. $25 CAD
  maxPerDay: number;             // e.g. $100 CAD
  requireApproval: number;       // above this amount, escalate to human

  // Allowed actions
  canPurchaseTickets: boolean;
  canTip: boolean;
  canSendMessages: boolean;
  canRSVP: boolean;
  canCreateContent: boolean;     // draft posts, create events (as drafts)
  canAcceptConnections: boolean;

  // Settlement
  settlementDid: string;         // which DID pays (owner's, not Jin's)
  feeModel: "owner-pays" | "requester-pays" | "split";
}
```

**Key principle:** Jin spends the owner's money, not its own. Jin's DID signs the *intent*, the owner's DID is the *settlement party*. This is like an authorized user on a credit card — attributable but not liable.

**Actions Jin can take:**
- Buy a ticket to an event ("RSVP me to Greg's thing on Saturday")
- Tip an artist ("tip DJ X $5 from me")
- Send a message ("tell Debbie I'll be late")
- Accept a connection request ("if they're trust distance ≤2, accept")
- Draft content ("write up a summary of today's build log" → creates draft, doesn't publish)

**Actions Jin cannot take without escalation:**
- Anything above the spending threshold
- Publishing content (drafts only)
- Revoking connections
- Changing profile settings
- Accessing encrypted data vaults (future, ref: Ajna.inc EDV)

### 7. Escalation Protocol

Jin must know its limits and hand off gracefully.

```typescript
interface Escalation {
  type: "unknown" | "authority" | "sensitive" | "conflict" | "cost";
  context: string;              // what was being attempted
  requesterDid: string;         // who triggered the escalation
  suggestedAction?: string;     // Jin's recommendation
  urgency: "low" | "normal" | "high";
}
```

**Escalation flow:**
1. Jin encounters something outside its scope or confidence
2. Jin notifies the owner via preferred channel (push notification, chat, email)
3. Jin tells the requester: "I've asked [Owner] — they'll get back to you"
4. Owner responds (via any surface — Telegram, app, email)
5. Jin receives the response, delivers it to the requester
6. Jin stores the interaction in conversation memory — **learns the pattern**

**Learning from escalations:**
Over time, Jin builds a model of "when Ryan is asked X, he says Y." Frequent escalation patterns can be promoted to autonomous responses with owner approval. The agent gets smarter through use, not training.

**Escalation decay:** If an escalation goes unanswered for N hours (configurable), Jin either:
- Responds with a polite "they're unavailable right now"
- Takes the suggested action if confidence is high and stakes are low
- Drops the thread if stakes are high

### 8. Background Autonomous Work

Jin doesn't just respond to queries — it works proactively.

**Heartbeat-driven tasks (via OpenClaw runtime):**
- Check for new messages and draft responses
- Monitor events the owner is attending — surface schedule conflicts
- Review incoming connection requests against trust distance
- Summarize daily attestation activity ("you earned $12.50 from 3 presence queries today")
- Flag anomalies ("someone outside your trust graph is querying you repeatedly")

**Trigger-driven tasks:**
- New ticket sale → notify owner + update event dashboard
- Connection accepted → suggest introduction to mutual contacts
- .fair settlement received → update earnings summary
- Course enrollment → welcome message from Jin

**Background task authority:** Same `AgentAuthority` constraints apply. Background tasks that would exceed authority thresholds queue for owner approval rather than executing.

### 9. Agent-to-Agent Settlement

When Jin A queries Jin B, there's an economic transaction.

```
┌──────────┐                        ┌──────────┐
│  Jin A   │ ── query ──────────▶   │  Jin B   │
│ (Alice)  │                        │  (Bob)   │
│          │ ◀── response ────────  │          │
│          │ ── settlement ──────▶  │          │
└──────────┘                        └──────────┘
     │                                    │
     ▼                                    ▼
 Alice pays                          Bob receives
 (via owner DID)                     80% to owner
                                     20% to platform
```

**Settlement flow:**
1. Jin A sends query with `requester-pays` intent
2. Jin B checks trust distance between Alice and Bob
3. Jin B responds within trust-scoped boundaries
4. Inference cost calculated (tokens × model rate)
5. .fair manifest generated: `{ requester: Alice, provider: Bob, platform: imajin, cost: $0.03 }`
6. Settlement via pay service — Alice's balance debited, Bob's credited
7. Interaction attested on both sides

**Pricing models:**
- **Fixed per query** — owner sets a price ("ask me anything for $0.10")
- **Cost-plus** — inference cost + owner markup
- **Free for trust distance ≤1** — friends query free, strangers pay
- **Subscription** — monthly access to a Jin instance (for professional presences)

**Metering:**
- Token count per query/response
- Model used (cost varies by model)
- Tool invocations (API calls to services have compute cost)
- Knowledge cache hits (cheaper — no re-derivation needed)

### 10. Tool Registration

The current 6 trust-scoped tools are hardcoded. This needs to be extensible.

```typescript
interface ToolRegistration {
  id: string;                    // e.g. "events.list"
  service: string;               // e.g. "events"
  name: string;
  description: string;
  parameters: JSONSchema;
  trustMinimum: number;          // minimum trust distance to use this tool (0 = self only)
  costEstimate: "free" | "low" | "medium" | "high";
  
  // Authorization
  requiredScopes: string[];      // e.g. ["events:read", "events:write"]
  requiresOwnerApproval: boolean;
}
```

**Service-advertised tools:**
Each Imajin service advertises its available tools at `/api/tools` (or via registry). When Jin boots, it discovers available tools based on:
1. What services are running
2. What the owner has enabled
3. What the requester's trust distance allows

**Third-party tools:**
Plugin architecture (RFC-09) extends to Jin tools. DFOS as first integration could register tools like:
- `dfos.events.list` — list events from the DFOS network
- `dfos.artist.lookup` — find an artist's profile
- `dfos.play.history` — query listening history (trust-gated)

**Tool composition:**
Jin can chain tools. "Find me a techno event this weekend near Toronto" → `events.search(genre=techno, location=Toronto, date=this-weekend)` → `connections.mutual(eventAttendees)` → "There's one on Saturday, 3 people in your trust graph are going."

---

## Updated Migration Path

### Phase 1: Memory + Identity (near-term) — *unchanged*

### Phase 2: Workspace UI (medium-term) — *unchanged*

### Phase 3: Runtime Interface + Operational Layer (medium-term)
- Extract `AgentRuntime` interface
- Implement `AgentAuthority` scoping
- Implement escalation protocol with notification delivery
- Add economic actions (purchase, tip, message, RSVP) as authorized tools
- Implement Tier 1 (built-in) and Tier 2 (OpenClaw) runtimes
- Multi-Jin workspace support (1–4 instances)

### Phase 4: Jin Network + Agent Economy (longer-term)
- Jin-to-Jin message protocol with settlement
- Agent-to-agent .fair settlement
- Tool registration and discovery via registry
- Background autonomous tasks
- Managed OpenClaw instances for non-self-hosters
- Third-party tool marketplace (RFC-09 integration)
- Pricing models + metering dashboard

---

## Issue Cross-Reference

### §6 Economic Agency
- #43 — Bot/presence API: programmatic access to platform actions
- #44 — Trust gating: permission model for bot/presence platform access
- #111 — Inference cost flow: queries through sovereign presence pay for compute
- #338 — Attention marketplace: DID-consented interest queries with micro-payments

### §7 Escalation Protocol
- #260 — Notification system: in-app badges, push, email digest, and user config
- #45 — Presence notifications: cron/webhook for incoming messages and invites

### §8 Background Autonomous Work
- #256 — Epic: Sovereign Inference — API gateway, presence bootstrap, user-owned keys
- #347 — Digest emails for event hosts (example of a Jin background task)

### §9 Agent-to-Agent Settlement
- #110 — .fair for runtime modules: attribution for inference, memory, service providers
- #113 — Revenue stream 1: settlement fees on every transaction
- #115 — Revenue stream 3: headless service settlement (machine-to-machine)
- #117 — Revenue stream 5: trust graph queries as queryable infrastructure

### §10 Tool Registration
- #244 — Delegated app sessions: third-party app registration + scoped identity
- #336 — Trust graph query engine: vouch chains, trust scoring
- #351 — Media API hardening + dynamic tool bootstrap
- #344 — Presence boundary enforcement + abuse attestations

### Foundational
- #321 — Progressive trust: vouch flow, onboarding milestones, flag system
- #346 — Profile scopes: actor, family, community, org
- #163 — Bilateral attestations + dispute chains
- #155 — DID-to-endpoint resolution for node-to-node discovery (Jin-to-Jin routing)
