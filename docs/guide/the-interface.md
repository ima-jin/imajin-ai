# The Interface: ImajinAgentEnv

`ImajinAgentEnv` is the universal contract between any agent runtime and the Imajin kernel. If your runtime implements this interface, your agent is an Imajin citizen.

The interface is deliberately thin. Your runtime handles inference, orchestration, and UX. Imajin handles identity, delegation, attribution, and settlement. The interface is the seam.

---

## The Contract

```typescript
interface ImajinAgentEnv {
  // ─── Identity ──────────────────────────────────────
  readonly did: string;                    // Agent's DID
  readonly principal: string;              // Owner's DID (delegation source)
  readonly grants: GrantSet;               // Current permissions
  
  // ─── Tool Surface ─────────────────────────────────
  callTool<T = unknown>(
    name: string,                          // e.g. "chat.send", "media.read"
    params: Record<string, unknown>,
    options?: { schema?: ValibotSchema<T> }
  ): Promise<ToolResult<T>>;
  
  // ─── Workspace (.jin/) ─────────────────────────────
  readonly workspace: {
    read(path: string): Promise<string>;
    readBuffer(path: string): Promise<Uint8Array>;
    write(path: string, content: string | Uint8Array): Promise<void>;
    list(path: string): Promise<string[]>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    rm(path: string): Promise<void>;
    stat(path: string): Promise<FileStat>;
  };
  
  // ─── Session ───────────────────────────────────────
  readonly session: {
    id: string;
    startedAt: Date;
    gasConsumed: number;
    gasRemaining: number;
    persist(key: string, value: unknown): Promise<void>;
    recall(key: string): Promise<unknown | null>;
  };
  
  // ─── Events ────────────────────────────────────────
  on(event: string, handler: (payload: unknown) => void): void;
  off(event: string, handler: (payload: unknown) => void): void;
}
```

### Identity

The agent's DID, its principal (the human who authorized it), and its resolved grant set. All read-only — you can't change identity mid-session.

```typescript
console.log(env.did);        // "did:imajin:7Kx9..."
console.log(env.principal);  // "did:imajin:5Qn8..."  (the human)
console.log(env.grants);     // { tier: "operator", tools: ["chat.*", "media.read", ...] }
```

### Tool Surface

All kernel interactions go through `callTool()`. One method, typed results, signed automatically.

```typescript
// Untyped — returns unknown
const result = await env.callTool('chat.send', {
  conversation: 'did:imajin:dm:abc123',
  content: 'Hello!'
});

// Typed with Valibot — compile-time safety
import * as v from 'valibot';

const balance = await env.callTool('pay.balance', {}, {
  schema: v.object({
    available: v.number(),
    pending: v.number(),
    currency: v.string(),
  })
});
// balance.data is typed: { available: number, pending: number, currency: string }
```

The kernel validates every call against the agent's grant set, delegation chain, and gas budget. Failed validation returns a typed error, not an exception:

```typescript
const result = await env.callTool('pay.settle', { amount: 5000 });

if (!result.ok) {
  console.log(result.error);
  // { code: "GRANT_DENIED", message: "pay.settle requires Transactor tier" }
}
```

### Workspace

Persistent storage in `.jin/` inside the principal's media folder. Free (no gas cost). Quota governed by the user's media limit.

```typescript
// Write state that survives session restarts
await env.workspace.write('config/preferences.json', JSON.stringify({
  language: 'en',
  timezone: 'America/Toronto'
}));

// Read it back in a future session
const prefs = JSON.parse(await env.workspace.read('config/preferences.json'));

// List workspace contents
const files = await env.workspace.list('config/');
// ["preferences.json", "history.json"]
```

Runtime-specific state goes in subdirectories: `.jin/openclaw/`, `.jin/flue/`, `.jin/n8n/`. This way multiple runtimes can share an agent's workspace without stepping on each other.

### Session

Session lifecycle and gas metering:

```typescript
console.log(env.session.id);            // "sess_abc123"
console.log(env.session.gasConsumed);   // 42
console.log(env.session.gasRemaining);  // 958

// Persist key-value pairs (shorthand for workspace writes)
await env.session.persist('last_query', 'customer support ticket #1234');
const last = await env.session.recall('last_query');
```

Gas is consumed per tool call. Different tools cost different amounts — `chat.read` is cheap, `pay.settle` is expensive. When gas runs out, tool calls are rejected. The principal sets the gas budget.

### Events

Kernel-to-agent push notifications:

```typescript
// New message in a conversation the agent is watching
env.on('chat.message', (payload) => {
  console.log('New message from', payload.sender, ':', payload.content);
});

// Connection request to the principal
env.on('connection.requested', (payload) => {
  console.log('Connection request from', payload.from);
});

// Mention in a group conversation
env.on('chat.mention', (payload) => {
  console.log('Mentioned in', payload.conversation);
});
```

Events are push-based over the WebSocket. The agent subscribes to event types; the kernel pushes matching events in real-time.

---

## Wire Protocol

The interface is transport-agnostic, but the reference implementation uses WebSocket with JSON messages:

```
Agent Runtime                          Imajin Kernel Gateway
     │                                        │
     │──── ws connect ────────────────────────>│
     │                                        │
     │──── auth.hello { did, sig(nonce) } ───>│  Ed25519 challenge-response
     │<─── auth.ok { session_id, grants } ────│
     │                                        │
     │──── tool.call { name, params, sig } ──>│  Every call signed
     │<─── tool.result { data, gas } ─────────│  Result + gas consumed
     │                                        │
     │<─── event.push { type, payload } ──────│  Kernel pushes to agent
     │                                        │
     │──── session.end ───────────────────────>│  Explicit close
     │<─── session.ended { chain_entry } ─────│  Final chain record
```

### Message Types

**Agent → Kernel:**

| Type | Payload | Purpose |
|------|---------|---------|
| `auth.hello` | `{ did }` | Start authentication |
| `auth.verify` | `{ signature }` | Complete challenge-response |
| `tool.call` | `{ id, name, params, signature }` | Call a kernel tool |
| `session.end` | `{}` | End session explicitly |

**Kernel → Agent:**

| Type | Payload | Purpose |
|------|---------|---------|
| `auth.challenge` | `{ nonce }` | Challenge for authentication |
| `auth.ok` | `{ session_id, grants }` | Authentication succeeded |
| `auth.error` | `{ code, message }` | Authentication failed |
| `tool.result` | `{ id, ok, data, error, gas }` | Tool call result |
| `event.push` | `{ event, payload }` | Real-time event notification |
| `session.ended` | `{ chain_entry }` | Session closed, final chain record |

### Tool Call Signing

Every `tool.call` message includes the agent's Ed25519 signature over the call payload (id + name + params, canonicalized). The kernel:

1. Verifies signature against registered DID
2. Checks delegation chain
3. Checks grant set
4. Checks scope authorization
5. Checks gas budget
6. Executes the tool
7. Records chain entry
8. Returns result + gas consumed

This means every action is non-repudiable. The agent can't deny making a call — the signature proves it.

---

## Tool Categories

The kernel exposes tools organized by domain:

### identity.*
| Tool | Description | Min Grant |
|------|------------|-----------|
| `identity.resolve` | Resolve a DID to profile data | Observer |
| `identity.search` | Search identities by handle/name | Observer |
| `identity.attestations` | Query attestation history | Observer |

### chat.*
| Tool | Description | Min Grant |
|------|------------|-----------|
| `chat.read` | Read messages from a conversation | Observer |
| `chat.send` | Send a message | Assistant |
| `chat.conversations` | List conversations | Observer |
| `chat.create` | Create a new conversation | Operator |

### media.*
| Tool | Description | Min Grant |
|------|------------|-----------|
| `media.read` | Read a media asset | Observer |
| `media.upload` | Upload media with .fair attribution | Operator |
| `media.list` | List assets in a folder | Observer |

### commerce.*
| Tool | Description | Min Grant |
|------|------------|-----------|
| `commerce.checkout` | Create a checkout session | Operator |
| `commerce.balance` | Check balance for a DID | Observer |
| `commerce.settle` | Settle a payment via .fair | Transactor |

### connections.*
| Tool | Description | Min Grant |
|------|------------|-----------|
| `connections.status` | Check connection status | Observer |
| `connections.list` | List connections | Observer |
| `connections.invite` | Create an invite | Operator |

### workspace.*
| Tool | Description | Gas Cost |
|------|------------|----------|
| `workspace.read` | Read from `.jin/` | Free |
| `workspace.write` | Write to `.jin/` | Free |
| `workspace.list` | List `.jin/` contents | Free |
| `workspace.exists` | Check if path exists | Free |

Workspace operations are always free and always available (no grant tier required). They operate exclusively within the agent's `.jin/` directory.

---

## Consent Gate

For high-value operations, the kernel requires synchronous human confirmation:

```typescript
const result = await env.callTool('commerce.settle', {
  amount: 50000,  // $500 CAD
  fair_manifest: 'fair:order_xyz'
});

if (result.pending === 'consent') {
  // Kernel has paused execution and notified the principal
  // The tool call will complete when the human approves or rejects
  // The agent receives the result asynchronously via the event channel
}
```

The consent threshold is configurable per principal. Below the threshold, tool calls execute immediately. Above it, the kernel pauses and waits for human approval. The confirmation window collapses the revocation exposure to zero — the human sees exactly what's about to happen before it happens.

---

## Gas Metering

Every tool call has a gas cost. Gas is the mechanism for resource accounting — it prevents runaway agents and enables usage-based pricing.

```typescript
// Check remaining budget
console.log(env.session.gasRemaining);  // 958

// Gas is deducted on each tool call
const result = await env.callTool('chat.send', { ... });
console.log(result.gas);  // 2 (gas consumed by this call)
console.log(env.session.gasRemaining);  // 956

// When gas runs out
const result2 = await env.callTool('chat.send', { ... });
// { ok: false, error: { code: "GAS_EXHAUSTED", remaining: 0 } }
```

Gas costs vary by tool:
- **Free:** workspace operations
- **Cheap (1-2):** reads, searches, status checks
- **Medium (5-10):** sends, uploads, creates
- **Expensive (20-50):** settlements, checkouts, attestation creation

The principal sets the gas budget per session or per billing period.

---

## The Package: `@imajin/agent-env`

The interface, types, and Valibot tool schemas are published as a package:

```bash
npm install @imajin/agent-env
```

```typescript
import type { ImajinAgentEnv, GrantSet, ToolResult } from '@imajin/agent-env';
import { toolSchemas } from '@imajin/agent-env/schemas';

// Use the schemas for typed tool calls
const balance = await env.callTool('commerce.balance', {}, {
  schema: toolSchemas['commerce.balance'].result
});
```

TypeScript runtimes get full type safety. Other languages can use the wire protocol directly — the WebSocket messages are JSON, the schemas are documented.

---

*Next: [Adapters →](./adapters.md)*
