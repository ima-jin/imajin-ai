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

## Apps

### Platform Services

Core services that make up the sovereign stack.

| App | Dev Port | Prod Port | Domain | Purpose | Status |
|-----|----------|-----------|--------|---------|--------|
| [www](./apps/www) | 3000 | 7000 | [imajin.ai](https://imajin.ai) | Landing page, essays | ✅ Live |
| [auth](./apps/auth) | 3001 | 7001 | [auth.imajin.ai](https://auth.imajin.ai) | Identity (keypair, DID, sign/verify) | ✅ Live |
| [registry](./apps/registry) | 3002 | 7002 | [registry.imajin.ai](https://registry.imajin.ai) | Node discovery & federation | ✅ Live |
| [connections](./apps/connections) | 3003 | 7003 | [connections.imajin.ai](https://connections.imajin.ai) | Trust graph | ✅ Live |
| [pay](./apps/pay) | 3004 | 7004 | [pay.imajin.ai](https://pay.imajin.ai) | Payments (Stripe + Solana) | ✅ Live |
| [profile](./apps/profile) | 3005 | 7005 | [profile.imajin.ai](https://profile.imajin.ai) | Public identity pages | ✅ Live |
| [events](./apps/events) | 3006 | 7006 | [events.imajin.ai](https://events.imajin.ai) | Create events, sell tickets | ✅ Live |
| [chat](./apps/chat) | 3007 | 7007 | [chat.imajin.ai](https://chat.imajin.ai) | E2EE messaging, trust-bound | ✅ Live |

### Profile Extensions

Account-based apps tied to a user's DID, accessible at `{service}.imajin.ai/{handle}`.

| App | Dev Port | Prod Port | Purpose | Status |
|-----|----------|-----------|---------|--------|
| [coffee](./apps/coffee) | 3008 | 7008 | Tip jar / support page | 📋 Scaffolded |
| [dykil](./apps/dykil) | 3009 | 7009 | Surveys & polls (event integration) | 📋 Scaffolded |
| [links](./apps/links) | 3010 | 7010 | Curated link collection | 📋 Scaffolded |
| learn | 3011 | 7011 | Lessons & courses | 📋 Planned |

### Standalone Apps

Separate repos — consume the platform but aren't part of it. Own databases.

| App | Repo | Domain | Purpose | Status |
|-----|------|--------|---------|--------|
| fixready | [imajin-fixready](https://github.com/ima-jin/imajin-fixready) | [fixready.imajin.ai](https://fixready.imajin.ai) | Home repair knowledge marketplace | ✅ Live |
| karaoke | [imajin-karaoke](https://github.com/ima-jin/imajin-karaoke) | [karaoke.imajin.ai](https://karaoke.imajin.ai) | Music & performance | ✅ Live |

---

## Packages

Shared libraries used across all apps.

| Package | Purpose |
|---------|---------|
| [@imajin/auth](./packages/auth) | Ed25519 signing, verification, DID creation |
| [@imajin/db](./packages/db) | Database layer (postgres-js + drizzle-orm) |
| [@imajin/pay](./packages/pay) | Unified payments (Stripe + Solana) |
| [@imajin/config](./packages/config) | Shared configuration |
| [@imajin/ui](./packages/ui) | Shared UI components |

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
App (events, coffee, etc.)
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

# Configure (copy and edit .env.local for each app you want to run)
# Each app needs at minimum: DATABASE_URL

# Start a service in dev mode
pnpm --filter @imajin/auth dev       # localhost:3001
pnpm --filter @imajin/events dev     # localhost:3006

# Build
pnpm --filter @imajin/www build

# Push database schemas (requires DATABASE_URL)
cd apps/auth && pnpm db:push
```

---

## Structure

```
imajin-ai/
├── apps/
│   ├── www/           # imajin.ai — landing, essays
│   ├── auth/          # Identity service
│   ├── registry/      # Node federation
│   ├── connections/   # Trust graph
│   ├── pay/           # Payment service
│   ├── profile/       # Profile pages
│   ├── events/        # Events & ticketing
│   ├── chat/          # E2EE messaging
│   ├── coffee/        # Tip jar
│   ├── dykil/         # Surveys & polls
│   └── links/         # Link collection
├── packages/
│   ├── auth/          # @imajin/auth — signing, DIDs
│   ├── db/            # @imajin/db — database layer
│   ├── pay/           # @imajin/pay — payments
│   ├── config/        # @imajin/config — shared config
│   └── ui/            # @imajin/ui — shared components
├── articles/          # Essays & reference docs
│   ├── THESIS.md      # Canonical concept definitions
│   ├── ARCHITECTURE.md # Technical architecture
│   └── essay-*.md     # The essay series (29 essays)
├── docs/
│   ├── IDENTITY.md    # DID model
│   ├── ENVIRONMENTS.md # Database & deployment config
│   └── mjn-whitepaper.md # MJN protocol spec
└── tests/
    ├── HAPPY_PATH.md  # End-to-end test cases
    └── AUDIT.md       # Security audit checklist
```

---

## Deployment

Self-hosted on HP ProLiant ML350p Gen8 (Ubuntu 24.04). Caddy for reverse proxy + auto-SSL. pm2 for process management. GitHub Actions self-hosted runner for CI/CD.

**Port convention:** `3xxx` = dev, `7xxx` = prod (1:1 mapping). `x000-x099` = platform services, `x400+` = standalone client apps.

**pm2 naming:** Bare names = prod (`www`, `auth`, `events`). Prefixed = dev (`dev-www`, `dev-auth`, `dev-events`).

See [articles/ARCHITECTURE.md](./apps/www/articles/ARCHITECTURE.md) for full deployment topology.

---

## Grounding Documents

| Document | Purpose |
|----------|---------|
| [THESIS.md](./apps/www/articles/THESIS.md) | Canonical concept definitions — what we mean |
| [ARCHITECTURE.md](./apps/www/articles/ARCHITECTURE.md) | Technical architecture — how it works |
| [essay-00-sequence.md](./apps/www/articles/essay-00-sequence.md) | Essay order & structure |
| [essay-00-master-timeline.md](./apps/www/articles/essay-00-master-timeline.md) | Biographical chronology |

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
