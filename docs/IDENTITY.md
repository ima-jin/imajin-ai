# Identity Model

## Core Principle

**Everything that acts gets a DID.**

A DID (Decentralized Identifier) is a keypair-based identity. Not just for humans — for any entity that participates in signed transactions.

## Entity Types

| Type | Description | Example |
|------|-------------|---------|
| `human` | A person | Ryan, attendees |
| `agent` | An AI/bot | Jin |
| `event` | A happening | Jin's Launch Party |
| `org` | An organization | Imajin (future) |

New types can be added as needed. Auth doesn't care about semantics — it just manages keypairs and signatures.

## Architecture

```
@imajin/auth (package)
├── generateKeypair()     → creates Ed25519 keypair
├── createIdentity()      → registers public key → returns DID
├── sign()                → signs payload with private key
└── verify()              → verifies signature with public key

          ↓ consumed by

┌──────────────────────────────────────────────────────┐
│  Core (imajin-ai)           │  External Apps         │
│  ├── profile (human/agent)  │  ├── imajin-events     │
│  ├── registry (nodes)       │  │   └── event DIDs    │
│  └── connections (trust)    │  │   └── tickets       │
│                             │  └── future apps...    │
└──────────────────────────────────────────────────────┘
```

## Separation of Concerns

- **auth** — identity primitive (DID, keypair, signatures)
- **profile** — display layer for humans/agents (handle, bio, avatar)
- **events** — display layer for events (name, date, venue, tickets)

Auth doesn't know what a "profile" or "event" looks like. It just knows:
- This public key → this DID
- This DID → this type
- This signature → valid or not

## Signed Messages

Every interaction in the system:

```typescript
{
  from: "did:imajin:xxx",     // who (DID)
  type: "human",              // what kind (always labeled)
  timestamp: 1707850800000,   // when
  payload: { ... },           // what (the actual content)
  signature: "..."            // proof (Ed25519, 128 hex chars)
}
```

## Example: Event Ticket

```typescript
{
  from: "did:imajin:event_abc",      // Jin's Launch Party
  to: "did:imajin:human_xyz",        // Ryan
  type: "ticket",
  payload: { 
    tier: "physical",
    price: 1000,                     // cents
    purchasedAt: 1707850800000
  },
  signature: "..."                   // signed by event's keypair
}
```

The ticket is a signed message from the event DID to the attendee DID. Verifiable by anyone with the event's public key.

## Why This Matters

1. **No impersonation** — every message is signed and typed
2. **Portable identity** — your DID works across all Imajin apps
3. **Extensible** — new entity types don't require auth changes
4. **Decentralized** — no central authority owns your identity

---

*This model enables the sovereign stack: identity, payments, and attribution without platform lock-in.*
