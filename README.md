# imajin-ai

**Sovereign infrastructure for humans, agents, and events.**

Identity. Payments. Attribution. No platform lock-in.  
Every interaction signed, typed, and owned by you.

---

## What This Is

The core platform layer for the Imajin network. Everything that needs a DID (decentralized identifier) flows through here:

- **Humans** register, authenticate, and own their identity
- **Agents** get the same primitives as humans
- **Events** are first-class entities that can sign tickets
- **Profiles** give identities a public face

External apps (events, coffee, shop) consume these packages as dependencies.

---

## Core Apps

Apps in this monorepo — the sovereign stack foundation:

| App | Port | Domain | Purpose | Status |
|-----|------|--------|---------|--------|
| [www](./apps/www) | 3000 | imajin.ai | Landing page, articles | ✅ Live |
| [auth](./apps/auth) | 3003 | auth.imajin.ai | Identity (register, challenge, authenticate) | ✅ Working |
| [pay](./apps/pay) | 3004 | pay.imajin.ai | Payments (Stripe + Solana) | 🟡 Scaffold |
| [profile](./apps/profile) | 3005 | profile.imajin.ai | Public profile pages | ✅ Working |
| [registry](./apps/registry) | 3006 | registry.imajin.ai | Node registration for federated network | 🟡 Scaffold |
| [connections](./apps/connections) | — | connections.imajin.ai | Trust graph | 📋 Spec |

---

## External Apps

Separate repos that consume `@imajin/auth` and `@imajin/pay`:

| App | Repo | Purpose | Status |
|-----|------|---------|--------|
| events | [imajin-events](https://github.com/ima-jin/imajin-events) | Create events, sell tickets | 🟡 Scaffold |
| coffee | [imajin-coffee](https://github.com/ima-jin/imajin-coffee) | Tips / "buy me a coffee" | 📋 Planned |
| dykil | [imajin-dykil](https://github.com/ima-jin/imajin-dykil) | Community spending tracker | 🟡 Extracted |
| karaoke | [imajin-karaoke](https://github.com/ima-jin/imajin-karaoke) | Event queue manager | ✅ Working |
| links | [imajin-links](https://github.com/ima-jin/imajin-links) | Sovereign link-in-bio | 📋 Planned |
| learn | [imajin-learn](https://github.com/ima-jin/imajin-learn) | AI training courses | 📋 Planned |

---

## Packages

Shared libraries (will be published to npm):

| Package | Purpose | Status |
|---------|---------|--------|
| [@imajin/auth](./packages/auth) | Ed25519 signing, verification, DIDs | ✅ Working |
| [@imajin/pay](./packages/pay) | Unified payments (Stripe + Solana) | 🟡 Scaffold |

---

## Identity Model

Everything that acts gets a DID. See [docs/IDENTITY.md](./docs/IDENTITY.md).

| Type | Description | Example |
|------|-------------|---------|
| `human` | A person | Ryan, attendees |
| `agent` | An AI/bot | Assistants, bots |
| `presence` | Embodied AI | Jin |
| `event` | A happening | Jin's Launch Party |
| `org` | An organization | Imajin |

```typescript
import { generateKeypair, createIdentity, sign, verify } from '@imajin/auth';

// Generate keypair
const keypair = generateKeypair();

// Create identity
const identity = createIdentity(keypair.publicKey, 'human');
// { id: "did:imajin:abc123...", type: "human", publicKey: "..." }

// Sign messages
const signed = await sign({ action: 'purchase' }, keypair.privateKey, identity);

// Verify anywhere
const result = await verify(signed, keypair.publicKey);
```

---

## Auth Flow

```
1. Client generates keypair
2. POST /api/register { publicKey, type } → DID
3. POST /api/challenge { id } → challenge string
4. Client signs challenge
5. POST /api/authenticate { id, challengeId, signature } → token
6. Use token for authenticated requests
```

---

## Quick Start

```bash
# Install dependencies
pnpm install

# Start dev servers
pnpm --filter @imajin/auth-service dev    # localhost:3003
pnpm --filter @imajin/profile-service dev # localhost:3005

# Push database schemas
cd apps/auth && DATABASE_URL="..." pnpm db:push
cd apps/profile && DATABASE_URL="..." pnpm db:push
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
│   ├── registry/      # Node registry
│   └── connections/   # Trust graph (spec only)
├── packages/
│   ├── auth/          # @imajin/auth
│   └── pay/           # @imajin/pay
├── docs/
│   ├── IDENTITY.md    # DID model
│   └── ENVIRONMENTS.md
└── scripts/
    └── test-flow.ts   # End-to-end auth test
```

---

## License

MIT

---

*Built by [Imajin](https://imajin.ai) — 今人 — "now-person"*
