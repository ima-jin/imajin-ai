# Integration Guides

How to wire Imajin into specific agent runtimes. Each guide assumes you've read [Getting Started](./getting-started.md) and [The Interface](./the-interface.md).

---

## OpenClaw + Imajin

OpenClaw is the first runtime with a native Imajin integration. The Imajin channel plugin connects OpenClaw sessions to the Imajin kernel — your agent gets a DID, talks through Imajin chat, and has access to the full tool surface.

### How It Works

The OpenClaw Imajin plugin (`extensions/imajin/`) acts as a bridge:

1. **Authentication:** Plugin holds the agent's Ed25519 keypair. On startup, it connects to the kernel via WebSocket and completes challenge-response auth.
2. **Chat as channel:** Imajin DM conversations appear as OpenClaw messaging channels. Messages flow both ways — the agent can receive and reply through Imajin chat.
3. **Tools as plugin tools:** Imajin kernel tools are exposed as OpenClaw tools. The agent calls `imajin.identity.resolve` in natural language, and the plugin translates to a `tool.call` over the wire protocol.
4. **Chain recording:** Every action the agent takes through the plugin is recorded on its Imajin chain.

### Configuration

```json
{
  "plugin": "imajin",
  "config": {
    "kernelUrl": "wss://kernel.imajin.ai/agent/ws",
    "did": "did:imajin:7Kx9...",
    "keypairPath": ".jin-identity.json",
    "onStartup": true
  }
}
```

### What You Get

- Agent identity on the Imajin network
- Bidirectional chat with any DID
- Tool access gated by delegation chain
- Signed audit trail of every action
- Workspace persistence in `.jin/openclaw/`

---

## Flue + Imajin

[Flue](https://github.com/withastro/flue) is Astro's agent harness framework. Imajin complements Flue by providing the layers Flue doesn't address: identity, delegation, attestation, and settlement.

### The Connector

```bash
flue add imajin
```

This generates a TypeScript adapter that:

1. Injects `ImajinAgentEnv` into the Flue session
2. Handles WebSocket connection and DID auth
3. Maps Imajin tool calls to Flue's `defineCommand()` pattern
4. Routes credential isolation through Flue's secret injection

### Usage in a Flue Agent

```typescript
import { defineAgent } from 'flue';
import { imajin } from './connectors/imajin';

export default defineAgent({
  name: 'support-agent',
  connectors: [imajin],
  
  async run(session) {
    const env = session.imajin; // ImajinAgentEnv
    
    // Read unresolved support tickets
    const messages = await env.callTool('chat.read', {
      conversation: 'did:imajin:group:support'
    });
    
    // Process each ticket
    for (const msg of messages.data) {
      // Agent reasoning happens in Flue
      const response = await session.think(`How should I respond to: ${msg.content}`);
      
      // Actions go through Imajin (signed, scoped, recorded)
      await env.callTool('chat.send', {
        conversation: msg.conversationDid,
        content: response
      });
    }
  }
});
```

### What Flue Provides vs. What Imajin Provides

| Concern | Flue | Imajin |
|---------|------|--------|
| Inference / reasoning | ✅ | — |
| Sandbox / execution | ✅ (just-bash) | — |
| Context compaction | ✅ | — |
| Task delegation (fan-out) | ✅ | — |
| Identity | — | ✅ (DIDs) |
| Delegation chains | — | ✅ |
| Audit trail | — | ✅ (append-only chain) |
| Settlement | — | ✅ (.fair + payments) |
| Inter-agent trust | — | ✅ (verifiable history) |
| Human governance | — | ✅ (consent gate, kill switch) |

They're complementary. Flue solves runtime. Imajin solves coordination.

---

## n8n + Imajin

n8n workflows can connect to Imajin through a custom node that wraps the WebSocket protocol.

### Approach

1. **Custom n8n node:** `@imajin/n8n-node` — handles DID auth, tool calls, event subscriptions
2. **Trigger node:** listens for Imajin events (new messages, connection requests) and starts workflows
3. **Action node:** calls Imajin tools (send message, create checkout, upload media)

### Example Workflow

```
[Imajin Trigger: chat.message]
    → [IF: message contains "order"]
        → [Imajin Action: commerce.checkout { ... }]
        → [Imajin Action: chat.send { "Your order link: ..." }]
    → [ELSE]
        → [Imajin Action: chat.send { "How can I help?" }]
```

The n8n workflow is the runtime. Imajin handles identity, signing, and settlement. The agent's chain records every workflow execution.

### Workspace

n8n state persists in `.jin/n8n/` — workflow configs, execution logs, cached data. Multiple runtimes (n8n + OpenClaw + Flue) can share an agent's workspace without collision.

---

## Custom TypeScript + Imajin

For agents that don't use a framework — just TypeScript and a WebSocket.

### Standalone Client

```bash
npm install @imajin/agent-client
```

```typescript
import { ImajinClient } from '@imajin/agent-client';

const client = await ImajinClient.connect({
  kernelUrl: 'wss://kernel.imajin.ai/agent/ws',
  privateKey: process.env.AGENT_PRIVATE_KEY,
  did: 'did:imajin:7Kx9...',
});

// client implements ImajinAgentEnv
console.log(client.did);          // "did:imajin:7Kx9..."
console.log(client.principal);    // "did:imajin:5Qn8..."
console.log(client.grants);       // { tier: "operator", tools: [...] }

// Use the full tool surface
const conversations = await client.callTool('chat.conversations', {});
const balance = await client.callTool('commerce.balance', {});

// Listen for events
client.on('chat.message', async (msg) => {
  // Your agent logic here
  await client.callTool('chat.send', {
    conversation: msg.conversationDid,
    content: 'Acknowledged!'
  });
});

// Clean shutdown
await client.close();
```

### What You're Responsible For

When using the standalone client, your code handles:
- **Inference** — call OpenAI, Anthropic, local models, whatever
- **Orchestration** — multi-step workflows, parallel tasks, retries
- **State management** — use `workspace.write`/`workspace.read` for persistence

Imajin handles:
- **Identity** — your agent has a DID and a chain
- **Authorization** — every tool call is grant-checked
- **Attribution** — .fair manifests track contributions
- **Settlement** — payments route through the protocol
- **Audit** — every action is signed and recorded

---

## Any Language

The wire protocol is WebSocket + JSON. If your language can open a WebSocket and sign bytes with Ed25519, it can be an Imajin agent.

1. Connect to `wss://kernel.imajin.ai/agent/ws`
2. Complete the challenge-response auth (sign nonce with Ed25519)
3. Send `tool.call` messages with signed payloads
4. Receive `tool.result` and `event.push` messages

No SDK required. The protocol is the interface.

---

*Next: [Examples →](./examples.md)*
