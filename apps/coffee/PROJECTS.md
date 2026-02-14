# apps/coffee — coffee.imajin.ai

**Status:** 🔴 Not Started  
**Domain:** coffee.imajin.ai  
**Port:** 3009  
**Stack:** Next.js 14, Tailwind, Drizzle, Neon Postgres

---

## Overview

Tips and direct payments. "Buy me a coffee" without the platform cut or tracking.

**What it does:**
- Create a tip page linked to your DID
- Accept payments directly to Solana wallet or Stripe account
- Custom amounts or preset buttons ($1, $5, $10)
- Optional messages with tips
- Zero platform fee (just payment processor fees)

**Use cases:**
- Developer tip jar
- Street performer / busker
- Homeless person receiving tap-to-pay
- Creator support without Patreon
- Anyone who wants to receive money directly

**What it doesn't do:**
- Subscriptions (future maybe)
- Merchandise (that's `shop`)
- Event tickets (that's `tickets`)

---

## Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/pages` | Create tip page | Required |
| GET | `/api/pages/:handle` | Get tip page | No |
| PUT | `/api/pages/:handle` | Update tip page | Required (owner) |
| DELETE | `/api/pages/:handle` | Delete tip page | Required (owner) |
| POST | `/api/tip` | Send a tip | No (optional auth) |
| GET | `/api/tips/:did` | Get tips received | Required (owner) |
| GET | `/api/tips/:did/stats` | Get tip statistics | Required (owner) |

---

## Public Pages

| Path | Description |
|------|-------------|
| `/` | Landing / create your page |
| `/:handle` | Public tip page |
| `/dashboard` | Your tip dashboard (auth required) |
| `/create` | Create tip page (auth required) |

---

## Data Model

### CoffeePage
```typescript
interface CoffeePage {
  id: string;                     // page_xxx
  did: string;                    // Owner DID
  handle: string;                 // Unique handle (URL slug)
  title: string;                  // "Buy Ryan a coffee"
  bio?: string;                   // Short description
  avatar?: string;                // Image URL or emoji
  theme?: {
    primaryColor?: string;
    backgroundColor?: string;
  };
  paymentMethods: {
    stripe?: {
      accountId: string;          // Stripe Connect account
      enabled: boolean;
    };
    solana?: {
      address: string;            // Solana wallet address
      enabled: boolean;
    };
  };
  presets: number[];              // e.g., [100, 500, 1000] (cents)
  allowCustomAmount: boolean;
  allowMessages: boolean;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface Tip {
  id: string;                     // tip_xxx
  pageId: string;                 // Reference to coffee page
  fromDid?: string;               // null for anonymous
  fromName?: string;              // Display name (optional)
  amount: number;                 // In cents (USD) or lamports (SOL)
  currency: string;               // USD, SOL, etc.
  message?: string;
  paymentMethod: 'stripe' | 'solana';
  paymentId: string;              // Stripe charge ID or Solana tx
  status: 'pending' | 'completed' | 'failed';
  createdAt: Date;
}
```

---

## Database Schema

```sql
CREATE TABLE coffee_pages (
  id              TEXT PRIMARY KEY,
  did             TEXT NOT NULL UNIQUE,
  handle          TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  bio             TEXT,
  avatar          TEXT,
  theme           JSONB DEFAULT '{}',
  payment_methods JSONB NOT NULL,
  presets         INTEGER[] DEFAULT '{100, 500, 1000}',
  allow_custom    BOOLEAN DEFAULT true,
  allow_messages  BOOLEAN DEFAULT true,
  is_public       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE tips (
  id              TEXT PRIMARY KEY,
  page_id         TEXT REFERENCES coffee_pages(id),
  from_did        TEXT,
  from_name       TEXT,
  amount          INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'USD',
  message         TEXT,
  payment_method  TEXT NOT NULL,
  payment_id      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'failed')),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_coffee_pages_handle ON coffee_pages(handle);
CREATE INDEX idx_coffee_pages_did ON coffee_pages(did);
CREATE INDEX idx_tips_page ON tips(page_id);
CREATE INDEX idx_tips_status ON tips(status);
CREATE INDEX idx_tips_created ON tips(created_at DESC);
```

---

## Usage

### Create Tip Page
```typescript
const response = await fetch('https://coffee.imajin.ai/api/pages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    handle: 'ryan',
    title: 'Buy Ryan a coffee',
    bio: 'Building sovereign infrastructure',
    paymentMethods: {
      stripe: { accountId: 'acct_xxx', enabled: true },
      solana: { address: '7xKXt...', enabled: true },
    },
    presets: [100, 500, 1000, 2500], // $1, $5, $10, $25
  }),
});
```

### Send Tip (Stripe)
```typescript
const response = await fetch('https://coffee.imajin.ai/api/tip', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    pageHandle: 'ryan',
    amount: 500,                  // $5.00
    currency: 'USD',
    paymentMethod: 'stripe',
    message: 'Thanks for OpenClaw!',
    fromName: 'Anonymous fan',    // Optional
  }),
});

const { clientSecret } = await response.json();
// Use Stripe.js to confirm payment
```

### Send Tip (Solana)
```typescript
const response = await fetch('https://coffee.imajin.ai/api/tip', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    pageHandle: 'ryan',
    amount: 100000000,            // 0.1 SOL in lamports
    currency: 'SOL',
    paymentMethod: 'solana',
    message: 'Here\'s some SOL!',
  }),
});

const { transaction } = await response.json();
// Sign and send with wallet adapter
```

### Get Tips Received
```typescript
const response = await fetch('https://coffee.imajin.ai/api/tips/did:imajin:ryan123', {
  headers: { 'Authorization': 'Bearer imajin_tok_xxx' },
});

const { tips, total } = await response.json();
// { tips: [...], total: { USD: 15000, SOL: 500000000 } }
```

---

## Tip Page

Public page at `coffee.imajin.ai/:handle`:

```
┌─────────────────────────────────────────┐
│                                         │
│              [Avatar]                   │
│                                         │
│       Buy Ryan a coffee ☕               │
│                                         │
│   Building sovereign infrastructure.    │
│   No platforms. No tracking.            │
│                                         │
│   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐      │
│   │ $1  │ │ $5  │ │ $10 │ │ $25 │      │
│   └─────┘ └─────┘ └─────┘ └─────┘      │
│                                         │
│   ┌─────────────────────────────────┐   │
│   │ Custom amount: $[____]          │   │
│   └─────────────────────────────────┘   │
│                                         │
│   ┌─────────────────────────────────┐   │
│   │ Message (optional):             │   │
│   │ [                             ] │   │
│   └─────────────────────────────────┘   │
│                                         │
│   Pay with:                             │
│   [💳 Card]  [◎ Solana]                 │
│                                         │
│         [ ☕ Send Coffee ]              │
│                                         │
└─────────────────────────────────────────┘
```

---

## QR Code for In-Person

Generate QR that links to tip page:

```
coffee.imajin.ai/ryan
```

Busker/street performer can:
1. Print QR code
2. Display on phone
3. Accept tips via tap (NFC link to page)

---

## Stripe Connect

For fiat tips, recipients need Stripe Connect account:

1. User clicks "Enable Card Payments" on dashboard
2. Redirected to Stripe Connect onboarding
3. Stripe account ID stored in coffee_pages
4. Tips go directly to their Stripe account
5. We never touch the money (no platform fee)

---

## Solana Direct

For crypto tips:
1. User enters their Solana wallet address
2. Tips create direct transfer transactions
3. User signs with their wallet
4. Funds go straight to recipient
5. No intermediary

---

## Integration

### With pay.imajin.ai
- Stripe payment processing
- Solana transaction building

### With auth.imajin.ai
- Optional auth for tip senders (attribution)
- Required auth for page owners

### With profile.imajin.ai
- Link from profile to coffee page
- Pull avatar/name for page display

---

## Configuration

```bash
DATABASE_URL=postgres://...
AUTH_SERVICE_URL=https://auth.imajin.ai
PAY_SERVICE_URL=https://pay.imajin.ai
STRIPE_SECRET_KEY=sk_xxx
STRIPE_CONNECT_CLIENT_ID=ca_xxx
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
NEXT_PUBLIC_BASE_URL=https://coffee.imajin.ai
```

---

## TODO

- [ ] Scaffold Next.js app
- [ ] Database schema + Drizzle setup
- [ ] Page CRUD APIs
- [ ] Tip submission flow
- [ ] Stripe Connect integration
- [ ] Solana wallet integration
- [ ] Public tip page UI
- [ ] Dashboard with tip history
- [ ] QR code generation
- [ ] Webhook handling for payment confirmations
