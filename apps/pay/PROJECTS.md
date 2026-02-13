# apps/pay — pay.imajin.ai

Payment service API for the Imajin ecosystem.

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

```bash
# Required for Stripe
STRIPE_SECRET_KEY=sk_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PUBLISHABLE_KEY=pk_xxx  # For frontend

# Required for Solana
SOLANA_RPC_URL=https://api.devnet.solana.com

# Service URLs
NEXT_PUBLIC_BASE_URL=http://localhost:3004
AUTH_SERVICE_URL=http://localhost:3003
```

## Usage

### Hosted Checkout (Stripe)

```typescript
const response = await fetch('https://pay.imajin.ai/api/checkout', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    items: [
      { name: 'Unit 8×8×8', amount: 49900, quantity: 1 }
    ],
    currency: 'USD',
    successUrl: 'https://shop.imajin.ai/success',
    cancelUrl: 'https://shop.imajin.ai/cart',
  }),
});

const { url } = await response.json();
window.location.href = url; // Redirect to Stripe Checkout
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
    description: 'DYKIL Premium',
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
https://pay.imajin.ai/api/webhook
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

The pay service optionally validates tokens with auth.imajin.ai:

- **Without auth**: Anonymous/guest checkout works
- **With auth**: Links payments to identity, required for escrow

Set `AUTH_SERVICE_URL` to point to your auth service.

## Future Enhancements

- [ ] Subscription management endpoints
- [ ] Invoice generation
- [ ] .fair revenue split automation
- [ ] DID → payment address resolution
- [ ] Multi-currency conversion
- [ ] Payment history/receipts API
