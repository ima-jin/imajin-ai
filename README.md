# imajin-ai

**A sovereign transactional layer for your agent, bot, or device.**

Identity. Payments. Attribution. No platform lock-in.  
Every interaction signed, typed, and owned by you.

---

## The Thesis

The platforms extract. Netflix, Uber, Stripe, Auth0 — they sit between you and value, taking a cut of everything. Your identity lives on their servers. Your transactions flow through their pipes. Your agent runs on their cloud.

**What if the substrate was yours?**

- Your keys, your identity
- Your transactions, your rules  
- Your device, your presence
- Humans and agents using the same primitives

imajin-ai is the infrastructure layer. Open source. Self-hostable. No subscriptions.

---

## The Stack

| Layer | Package | Service | Status |
|-------|---------|---------|--------|
| **Identity** | [@imajin/auth](./packages/auth) | [auth.imajin.ai](./apps/auth) | ✅ Ed25519 signing |
| **Payments** | [@imajin/pay](./packages/pay) | [pay.imajin.ai](./apps/pay) | ✅ Stripe + Solana |
| **Attribution** | .fair | — | 📋 Spec |
| **Presence** | Unit | — | ✅ Hardware |
| **Orchestration** | imajin-cli | — | ✅ Working |

---

## Apps

| App | Domain | Purpose | Status |
|-----|--------|---------|--------|
| [auth](./apps/auth) | auth.imajin.ai | Identity service (register, challenge, authenticate) | ✅ Scaffold |
| [pay](./apps/pay) | pay.imajin.ai | Payment service (checkout, charge, escrow) | ✅ Scaffold |
| [dykil](./apps/dykil) | dykil.imajin.ai | Community spending tracker | ✅ Scaffold |
| [karaoke](./apps/karaoke) | karaoke.imajin.ai | Event queue manager | ✅ Working |
| profile | profile.imajin.ai | Identity profiles | 🟡 Planning |
| events | events.imajin.ai | Create events, sell tickets, verify attendance | 🟡 Planning |
| shop | shop.imajin.ai | Local marketplace | 🟡 Planning |
| coffee | coffee.imajin.ai | Tips / "buy me a coffee" — direct payments to Solana wallet or Stripe | 🟡 Planning |
| connections | connections.imajin.ai | Trust graph — who knows whom, invitation chains, network visualization | 🟡 Planning |
| links | links.imajin.ai | Sovereign link-in-bio pages (Linktree alternative) | 🟡 Planning |
| learn | learn.imajin.ai | AI training courses | 🟡 Planning |

---

## Packages

Shared infrastructure:

| Package | Purpose | Status |
|---------|---------|--------|
| [@imajin/auth](./packages/auth) | Ed25519 signing, verification, DIDs | ✅ Working |
| [@imajin/pay](./packages/pay) | Unified payments (Stripe + Solana) | ✅ Working |
| [@imajin/ui](./packages/ui) | Shared UI components | 🟡 Planned |
| [@imajin/db](./packages/db) | Database utilities | 🟡 Planned |

---

## How It Works

### Identity (packages/auth)

Every human and agent gets a keypair. No passwords. No OAuth.

```typescript
import { generateKeypair, createIdentity, sign, verify } from '@imajin/auth';

// 1. Generate Ed25519 keypair
const keypair = generateKeypair();
// { privateKey: "64-hex-chars", publicKey: "64-hex-chars" }

// 2. Create identity
const identity = createIdentity(keypair.publicKey, 'human');
// { id: "did:imajin:abc123...", type: "human", publicKey: "..." }

// 3. Sign messages
const signed = await sign({ action: 'purchase' }, keypair.privateKey, identity);
// { from, type, timestamp, payload, signature }

// 4. Verify anywhere
const result = await verify(signed, keypair.publicKey);
// { valid: true }
```

### Payments (packages/pay)

One interface, multiple rails:

```typescript
import { PaymentService } from '@imajin/pay';

const pay = new PaymentService({
  providers: {
    stripe: { secretKey: process.env.STRIPE_SECRET_KEY },
    solana: { rpcUrl: process.env.SOLANA_RPC_URL },
  },
});

// Fiat (routes to Stripe)
await pay.charge({ amount: 1500, currency: 'USD', to: { stripeCustomerId: 'cus_xxx' } });

// Crypto (routes to Solana)
await pay.charge({ amount: 100000000, currency: 'SOL', to: { solanaAddress: 'xxx' } });

// Hosted checkout
const { url } = await pay.checkout({
  items: [{ name: 'Unit 8×8×8', amount: 49900, quantity: 1 }],
  currency: 'USD',
  successUrl: 'https://shop.imajin.ai/success',
  cancelUrl: 'https://shop.imajin.ai/cart',
});
```

### Signed Messages

Every interaction in the system:

```typescript
{
  from: "did:imajin:abc123",  // who
  type: "agent",              // human or agent (always labeled)
  timestamp: 1707850800000,
  payload: { ... },           // the actual content
  signature: "..."            // Ed25519 signature (128 hex chars)
}
```

No impersonation. No confusion about who you're talking to.

---

## API Endpoints

### auth.imajin.ai (port 3003)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/register | Register public key → DID |
| POST | /api/challenge | Get challenge to sign |
| POST | /api/authenticate | Submit signed challenge → token |
| POST | /api/validate | Validate token |
| POST | /api/verify | Verify signed message directly |
| GET | /api/lookup/:id | Lookup identity by DID |

### pay.imajin.ai (port 3004)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/health | Provider health check |
| POST | /api/checkout | Create Stripe Checkout session |
| POST | /api/charge | Direct payment (Stripe or Solana) |
| POST | /api/escrow | Create escrow (hold funds) |
| PUT | /api/escrow | Release or refund escrow |
| POST | /api/webhook | Stripe webhook handler |

---

## Philosophy

> "Don't you know I'm local?"

A riff on "don't you know I'm loco?" — same defiant energy, but for community economics. Money should circulate locally, not flow to Silicon Valley.

**DYKIL** tracks where community money leaks to platforms.  
**The sovereign stack** is how you plug the leak.

---

## Setup

```bash
# Install dependencies
pnpm install

# Run apps
pnpm --filter @imajin/auth-service dev  # port 3003
pnpm --filter @imajin/pay-service dev   # port 3004
pnpm --filter @imajin/dykil dev         # port 3001

# Push database schema (auth)
pnpm --filter @imajin/auth-service db:push
```

### Environment Variables

**apps/auth/.env.local**
```
DATABASE_URL=postgres://...
```

**apps/pay/.env.local**
```
STRIPE_SECRET_KEY=sk_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
SOLANA_RPC_URL=https://api.devnet.solana.com
AUTH_SERVICE_URL=http://localhost:3003
```

---

## Structure

```
imajin-ai/
├── apps/
│   ├── auth/          # Identity service (auth.imajin.ai)
│   ├── pay/           # Payment service (pay.imajin.ai)
│   ├── dykil/         # Community economics (dykil.imajin.ai)
│   └── karaoke/       # Event queue (karaoke.imajin.ai)
├── packages/
│   ├── auth/          # @imajin/auth - Ed25519 identity
│   └── pay/           # @imajin/pay - unified payments
├── turbo.json
└── pnpm-workspace.yaml
```

---

## License

MIT — because sovereignty means you can fork it.

---

*Built by [Imajin](https://imajin.ai) — 今人 — "now-person"*
