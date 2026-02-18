# apps/pay — pay.imajin.ai

Payment service API for the Imajin ecosystem.

## Sovereign Architecture

This service follows the **sovereign node model** — each node operator runs their own pay service with their own payment credentials.

```
┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────────┐
│  alice.imajin.ai    │    │   bob.imajin.ai     │    │  carol.imajin.ai    │
│  (Alice's keys)     │    │   (Bob's keys)      │    │  (Carol's keys)     │
│                     │    │                     │    │                     │
│  ┌───────────────┐  │    │  ┌───────────────┐  │    │  ┌───────────────┐  │
│  │  pay service  │  │    │  │  pay service  │  │    │  │  pay service  │  │
│  └───────────────┘  │    │  └───────────────┘  │    │  └───────────────┘  │
└─────────────────────┘    └─────────────────────┘    └─────────────────────┘
         │                          │                          │
         ▼                          ▼                          ▼
   Alice's Stripe            Bob's Stripe             Carol's Stripe
   Alice's Wallet            Bob's Wallet             Carol's Wallet
```

**This is NOT a platform model.** There's no central authority routing payments or taking fees. Each node is independent:

- Node operator configures their own Stripe keys and Solana wallets
- Payments flow directly to the node operator
- No middleman, no platform cut
- Full sovereignty over your money

This is exit infrastructure — not another platform to depend on.

## Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/health` | Provider health check | No |
| POST | `/api/checkout` | Create Stripe Checkout session | Optional |
| POST | `/api/charge` | Direct payment (Stripe/Solana) | Optional |
| POST | `/api/escrow` | Create escrow | Required |
| PUT | `/api/escrow` | Release/refund escrow | Required |
| POST | `/api/webhook` | Stripe webhook handler | Signature |

## Configuration

Each node configures its own payment credentials:

```bash
# Stripe (node operator's account)
STRIPE_SECRET_KEY=sk_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PUBLISHABLE_KEY=pk_xxx

# Solana (node operator's wallet)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Service URLs
NEXT_PUBLIC_BASE_URL=http://localhost:3004
AUTH_SERVICE_URL=http://localhost:3003
```

## Usage

### Hosted Checkout (Stripe)

Other services on the same node call the pay service to create checkout sessions:

```typescript
// events app, shop app, etc. — no Stripe keys needed
const response = await fetch('http://localhost:3004/api/checkout', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    items: [
      { name: 'Event Ticket', amount: 1000, quantity: 1 }
    ],
    currency: 'USD',
    successUrl: 'https://events.example.com/success',
    cancelUrl: 'https://events.example.com/event',
    metadata: { eventId: 'launch-party', ticketType: 'virtual' }
  }),
});

const { url } = await response.json();
// redirect user to Stripe hosted checkout
```

### Direct Charge (Stripe)

```typescript
const response = await fetch('https://pay.imajin.ai/api/charge', {
  method: 'POST',
  headers: { 
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx', // Optional
  },
  body: JSON.stringify({
    amount: 1500, // $15.00 in cents
    currency: 'USD',
    to: { stripeCustomerId: 'cus_xxx' },
    description: 'Premium subscription',
  }),
});

const { clientSecret } = await response.json();
// Use Stripe.js to confirm with clientSecret
```

### Direct Charge (Solana)

```typescript
const response = await fetch('https://pay.imajin.ai/api/charge', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    amount: 100000000, // 0.1 SOL in lamports
    currency: 'SOL',
    to: { solanaAddress: 'xxx...' },
  }),
});

const { status, metadata } = await response.json();
// status === 'requires_action'
// Use wallet adapter to sign and send transaction
```

### Escrow

```typescript
// Create escrow (requires auth)
const response = await fetch('https://pay.imajin.ai/api/escrow', {
  method: 'POST',
  headers: { 
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    amount: 150000, // $1,500 in cents
    currency: 'USD',
    from: 'did:imajin:buyer123',
    to: 'did:imajin:seller456',
  }),
});

const { id, status } = await response.json();
// status === 'held'

// Release escrow
await fetch('https://pay.imajin.ai/api/escrow', {
  method: 'PUT',
  headers: { 
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    escrowId: id,
    provider: 'stripe',
    action: 'release', // or 'refund'
  }),
});
```

## Webhook Setup

For production, configure Stripe webhooks to point to:

```
https://pay.your-node.imajin.ai/api/webhook
```

Events to enable:
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.deleted`

## Local Development

```bash
cd apps/pay
cp .env.example .env.local
# Edit .env.local with your keys

pnpm dev
# → http://localhost:3004
```

For webhook testing locally, use Stripe CLI:

```bash
stripe listen --forward-to localhost:3004/api/webhook
# Use the webhook secret it outputs
```

## Integration with Auth

The pay service optionally validates tokens with the node's auth service:

- **Without auth**: Anonymous/guest checkout works
- **With auth**: Links payments to identity, required for escrow

Set `AUTH_SERVICE_URL` to point to your auth service.

## Future

- [ ] Subscription management
- [ ] Invoice generation
- [ ] .fair revenue split automation
- [ ] DID → payment address resolution
- [ ] Multi-currency conversion
- [ ] Payment history/receipts API
