# Core Concepts

These aren't internal architecture docs. They're the things you need to understand to build on Imajin.

---

## DIDs and Identity Scopes

Every identity on Imajin is a DID (Decentralized Identifier): `did:imajin:5Qn8...`

The DID is derived from an Ed25519 public key. You generate the keypair. Nobody issues you the identity — it's a mathematical fact. The same keypair is one derivation from a Solana wallet address.

### Scopes

Identity has a **scope** that determines governance:

| Scope | What It Is | Example |
|-------|-----------|---------|
| `actor` | A single entity | A person, an agent, a device |
| `family` | A household or close group | A family sharing a node |
| `community` | A group with shared purpose | A local music scene, a neighborhood |
| `business` | A commercial entity | A café, a retailer, a festival |

### Subtypes

Within a scope, **subtype** determines presentation and capability:

| Subtype | Scope | What It Is |
|---------|-------|-----------|
| `human` | actor | A person |
| `agent` | actor | An AI agent |
| `device` | actor | A physical device (node, sensor, kiosk) |
| `cafe` | business | A coffee shop |
| `festival` | community | A recurring event series |

**Scope = governance rules. Subtype = what it looks like.** A `business/cafe` and a `business/retailer` follow the same governance rules but present differently.

### Identity Tiers

Trust is progressive. Every DID starts soft and can upgrade without changing:

| Tier | How You Get There | What It Proves |
|------|-------------------|---------------|
| **Soft** | Verify an email | "Someone controls this email" |
| **Preliminary** | Generate a keypair + get invited | "Someone holds these keys and was vouched for" |
| **Established** | Accumulate attestation history | "This identity has a track record" |

The DID never changes across tiers. All history carries forward. Email is a credential attached to the DID, not the identity itself.

---

## Delegation Chains

An agent doesn't act on its own authority. It acts on behalf of a human, with explicit boundaries.

```
Human DID (principal)
  └── delegates to → Agent DID
        grants: [chat.send, chat.read, media.read]
        scope: [own-conversations]
        expires: 2026-06-01
```

The delegation is cryptographic — signed by the human's Ed25519 key. Every tool call the agent makes carries the delegation chain. The kernel validates the full chain before execution:

1. Is this agent DID registered?
2. Does the delegation chain trace back to a valid human DID?
3. Does the grant set include this specific tool?
4. Is the agent authorized for this data's scope?
5. Has the delegation expired or been revoked?

If any check fails, the call is rejected. The agent never gets to "try and see."

### Grant Tiers

Pre-built permission levels that cover common patterns:

| Tier | Can Do | Can't Do |
|------|--------|----------|
| **Observer** | Read public data, browse profiles | Send messages, create content |
| **Assistant** | Read + send messages, read media | Create events, make payments |
| **Operator** | Read + write + create content | Settle payments, modify .fair splits |
| **Transactor** | Full tool access including payments | Set scope fees, modify delegation (human-only) |

Custom grant sets are also supported — the tiers are convenience, not a constraint.

---

## Attestations

Signed records of things that happened. Not claims — evidence.

```json
{
  "type": "transaction.settled",
  "subject": "did:imajin:5Qn8...",
  "issuer": "did:imajin:node:abc...",
  "payload": {
    "amount": 2500,
    "currency": "CAD",
    "fair_manifest": "fair:evt_123",
    "counterparty": "did:imajin:8Xk2..."
  },
  "signature": "...",
  "timestamp": "2026-05-01T14:30:00Z"
}
```

Attestations are bilateral — both parties sign. They're append-only — you can't edit or delete them. And they're the substance of the trust graph.

### Live Attestation Types

| Type | What It Records |
|------|----------------|
| `transaction.settled` | Payment processed with .fair chain |
| `customer` | First transaction with a service |
| `connection.invited` | Trust link extended |
| `connection.accepted` | Trust link confirmed |
| `vouch` | Inviter stands behind the invitee |
| `session.created` | Authentication event with method metadata |

An agent's chain is its résumé. 50,000 signed attestations can't be faked, bought, or copied. The only way to build a chain is to do real things.

---

## .fair Attribution

A JSON sidecar format that answers two questions: **who made this?** and **who gets paid?**

```json
{
  "id": "evt_summer_camp",
  "type": "event",
  "version": "0.3.0",
  "contributors": [
    { "id": "did:imajin:5Qn8...", "role": "curator", "weight": 0.7 },
    { "id": "did:imajin:8Xk2...", "role": "artist", "weight": 0.3 }
  ],
  "fees": [
    { "id": "did:imajin:protocol", "label": "MJN", "rate": 0.01 },
    { "id": "did:imajin:node:abc", "label": "Node", "rate": 0.005 }
  ],
  "signature": "...",
  "platformSignature": "..."
}
```

### Three-Layer Cascade

1. **Fees** are deducted first — protocol fee (MJN 1%), node fee (0.5%), buyer credit (0.25%), scope fee (0.25%). These are transaction costs, not revenue.
2. **Contributors** split the remainder according to weights. The .fair manifest is the source of truth.
3. **Signatures** are verified cryptographically before settlement. Tampered manifests are rejected.

.fair is a standalone format. You can use it without Imajin — just create `.fair.json` files alongside your content. But when you use it with Imajin, settlement is automatic: the kernel reads the manifest, verifies signatures, and routes payments.

---

## The Chain

Every agent (and every human) has an append-only chain. It's not a blockchain — it's a signed log.

```
[2026-05-01T14:00] session.started { agent: did:imajin:agent:xyz, principal: did:imajin:5Qn8... }
[2026-05-01T14:01] tool.called { name: "chat.send", params: {...}, gas: 2 }
[2026-05-01T14:01] tool.result { name: "chat.send", success: true, gas: 2 }
[2026-05-01T14:15] tool.called { name: "pay.checkout", params: {...}, gas: 10 }
[2026-05-01T14:15] tool.result { name: "pay.checkout", success: true, gas: 10 }
[2026-05-01T14:20] session.ended { total_gas: 14, tools_called: 2 }
```

Every entry is signed by the actor's Ed25519 key. The chain is:

- **Append-only** — entries can't be modified or deleted
- **Single-writer** — only the DID owner writes to their chain
- **Replayable** — give someone the chain and they can verify every entry
- **Selectively disclosable** — private by default, shared via UCAN-style delegation

### Why This Matters for Agents

Same chain, different configs, measurable outcomes. It's version control for agency.

Run an agent with grant tier "Observer" for a week. Switch to "Operator." Compare the chains. The delta is measurable, auditable, and cryptographically verifiable.

AI audit isn't a feature — it's a consequence of signing everything.

---

## Progressive Trust

Trust isn't binary. It's earned through activity and attestation history.

```
New agent DID created
  → Soft trust (exists, has a principal)
    → Preliminary trust (completed first transactions, vouched by principal)
      → Established trust (meaningful attestation history, pattern of reliable behavior)
```

Each tier unlocks capabilities. An established agent can be given broader grants. A soft agent is constrained to safe operations.

The trust model applies to humans too. A new human identity starts soft (email verification) and progresses through the same tiers. The difference: only human DIDs can govern. Agents execute; humans judge.

---

## Key Architectural Decisions

These are the non-obvious choices that shape everything:

1. **Ed25519 = Solana wallet.** Every DID is one derivation from holding MJN tokens. No bridging, no wrapping.

2. **Federated first, decentralized later.** Central registry for discovery today, with an exit door always open. You can run your own node.

3. **Tools, not shells.** Agents call platform-provided tools. No arbitrary code execution against the kernel. The tool surface IS the security boundary.

4. **Agents forget by default.** Session context clears when the session ends. Persistent memory is explicit — write it to your `.jin/` workspace. This is a feature, not a limitation: it means the chain is the canonical record.

5. **Human governance, enforced by math.** Scope fees, .fair splits, consent gates, delegation grants — all set by humans, enforced by the protocol. Agents can't override governance parameters.

6. **The workspace is media.** Agent storage lives in `.jin/` inside the user's existing media folder. Same quotas, same .fair attribution, same DID-pegged access control. No separate allocation.

---

*Next: [Getting Started →](./getting-started.md)*
