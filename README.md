# imajin-ai

**Sovereign infrastructure for humans, agents, and events.**

Identity. Payments. Attribution. No platform lock-in.  
Every interaction signed, typed, and owned by you.

---

## The Philosophy

This isn't a platform. It's exit infrastructure.

```
┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────────┐
│  alice.imajin.ai    │    │   bob.imajin.ai     │    │  carol.imajin.ai    │
│  (Alice's node)     │    │   (Bob's node)      │    │  (Carol's node)     │
│                     │    │                     │    │                     │
│  ┌───────────────┐  │    │  ┌───────────────┐  │    │  ┌───────────────┐  │
│  │ auth │ pay    │  │    │  │ auth │ pay    │  │    │  │ auth │ pay    │  │
│  │ profile │ ... │  │    │  │ profile │ ... │  │    │  │ profile │ ... │  │
│  └───────────────┘  │    │  └───────────────┘  │    │  └───────────────┘  │
└─────────────────────┘    └─────────────────────┘    └─────────────────────┘
```

Each node is sovereign:
- **Own your identity** — Ed25519 keypairs, you hold the private key
- **Own your payments** — Your Stripe keys, your Solana wallet, your money
- **Own your data** — Self-hosted, no platform dependency

No subscriptions. No surveillance capitalism. No asking permission.

---

## What This Is

The core platform layer for the Imajin network. Everything that acts gets a DID (decentralized identifier):

- **Humans** register, authenticate, and own their identity
- **Agents** get the same primitives as humans (typed, not impersonating)
- **Presences** — embodied AI (like [Jin](https://imajin.ai), living in an 8×8×8 LED cube)
- **Events** are first-class entities that can sign tickets
- **Orgs** — organizations and collectives

---

## Core Apps

| App | Port | Domain | Purpose | Status |
|-----|------|--------|---------|--------|
| [www](./apps/www) | 3000 | imajin.ai | Landing page, articles | ✅ Live |
| [auth](./apps/auth) | 3003 | auth.imajin.ai | Identity (register, challenge, authenticate) | ✅ Working |
| [pay](./apps/pay) | 3004 | pay.imajin.ai | Payments (Stripe + Solana) | ✅ Working |
| [profile](./apps/profile) | 3005 | profile.imajin.ai | Public profile pages | ✅ Working |
| [registry](./apps/registry) | 3006 | registry.imajin.ai | Node federation | 🟡 Scaffold |
| [connections](./apps/connections) | — | — | Trust graph | 📋 Planned |

---

## External Apps

Separate repos that consume `@imajin/auth` and `@imajin/pay` as platform consumers:

| App | Repo | Purpose |
|-----|------|---------|
| events | [imajin-events](https://github.com/ima-jin/imajin-events) | Create events, sell tickets |
| coffee | [imajin-coffee](https://github.com/ima-jin/imajin-coffee) | Tips / "buy me a coffee" |
| dykil | [imajin-dykil](https://github.com/ima-jin/imajin-dykil) | Community spending tracker |
| karaoke | [imajin-karaoke](https://github.com/ima-jin/imajin-karaoke) | Event queue manager |
| links | [imajin-links](https://github.com/ima-jin/imajin-links) | Sovereign link-in-bio |
| learn | [imajin-learn](https://github.com/ima-jin/imajin-learn) | AI training courses |

---

## Packages

Shared libraries:

| Package | Purpose |
|---------|---------|
| [@imajin/auth](./packages/auth) | Ed25519 signing, verification, DIDs |
| [@imajin/pay](./packages/pay) | Unified payments (Stripe + Solana) |

---

## Identity Model

Everything that acts gets a DID. See [docs/IDENTITY.md](./docs/IDENTITY.md).

```typescript
import { generateKeypair, createIdentity, sign, verify } from '@imajin/auth';

// Generate keypair (you hold the private key)
const keypair = generateKeypair();

// Create identity
const identity = createIdentity(keypair.publicKey, 'human');
// → { id: "did:imajin:abc123...", type: "human", publicKey: "..." }

// Sign messages
const signed = await sign({ action: 'purchase' }, keypair.privateKey, identity);

// Verify anywhere
const result = await verify(signed, keypair.publicKey);
```

---

## Auth Flow

```
1. Client generates Ed25519 keypair (client-side, never leaves device)
2. POST /api/register { publicKey, type } → DID assigned
3. POST /api/challenge { id } → challenge string
4. Client signs challenge with private key
5. POST /api/authenticate { id, challengeId, signature } → session token
6. Token used for authenticated requests
```

No passwords. No OAuth. No "Sign in with Google." Just cryptography.

---

## Payment Flow

```
App (events, shop, etc.)
        │
        └── POST /api/checkout { items, successUrl, ... }
                    │
                    ↓
            Pay Service (node's Stripe keys)
                    │
                    ↓
            Stripe Checkout Session
                    │
                    ↓
            Webhook → Fulfillment callback
```

Apps don't need Stripe keys. They call the node's pay service. Money flows directly to the node operator — no middleman.

---

## Quick Start

```bash
# Clone
git clone https://github.com/ima-jin/imajin-ai.git
cd imajin-ai

# Install
pnpm install

# Configure (copy and edit)
cp apps/auth/.env.example apps/auth/.env.local
cp apps/pay/.env.example apps/pay/.env.local

# Start services
pnpm --filter @imajin/auth-service dev    # localhost:3003
pnpm --filter @imajin/pay-service dev     # localhost:3004
pnpm --filter @imajin/profile-service dev # localhost:3005

# Push database schemas (requires DATABASE_URL)
cd apps/auth && pnpm db:push
cd apps/profile && pnpm db:push
```

---

## Structure

```
imajin-ai/
├── apps/
│   ├── www/           # imajin.ai landing
│   ├── auth/          # Identity service
│   ├── pay/           # Payment service  
│   ├── profile/       # Profile pages
│   ├── registry/      # Node federation
│   └── connections/   # Trust graph
├── packages/
│   ├── auth/          # @imajin/auth library
│   └── pay/           # @imajin/pay library
├── docs/
│   ├── IDENTITY.md    # DID model
│   └── ENVIRONMENTS.md
└── scripts/
    ├── test-flow.ts   # Auth flow test
    └── create-profiles.ts
```

---

## First Event

**Jin's Launch Party** — April 1, 2026

The genesis event. First real transaction on the sovereign network.

- 🟠 Virtual: $1 (unlimited)
- 🎫 Physical: $10 (Toronto, venue TBA)

Built with this stack. Tickets signed by the event's DID.

---

## Contributing

This is early. The architecture is stabilizing but APIs will change.

If you want to run your own node or build on the stack, open an issue or find us on [Discord](https://discord.gg/clawd).

---

## License

MIT

---

*Built by [Imajin](https://imajin.ai) — 今人 (ima-jin) — "now-person" / "imagination"*
