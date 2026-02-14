# apps/tickets — tickets.imajin.ai

**Status:** 🔴 Not Started  
**Domain:** tickets.imajin.ai  
**Port:** 3007  
**Stack:** Next.js 14, Tailwind, Drizzle, Neon Postgres

---

## Overview

Buy, own, and verify tickets on the sovereign network. Real ownership with cryptographic proof.

**What it does:**
- Purchase tickets (initiates payment flow)
- Ticket ownership (linked to owner DID)
- Transfer tickets between DIDs
- Verify ticket authenticity (signed, unforgeable)
- Generate .fair attribution manifests

**What it doesn't do:**
- Event management (that's `events`)
- Payment processing (that's `pay`)
- Event discovery (that's `events`)

---

## Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/tickets/purchase` | Initiate ticket purchase | Required |
| GET | `/api/tickets/:id` | Get ticket details | No |
| GET | `/api/tickets` | List tickets (by owner, event) | No |
| POST | `/api/tickets/:id/transfer` | Transfer to another DID | Required (owner) |
| POST | `/api/tickets/verify` | Verify ticket signature | No |
| GET | `/api/tickets/:id/qr` | Generate QR code for ticket | No |

---

## Public Pages

| Path | Description |
|------|-------------|
| `/` | Landing / lookup |
| `/:id` | Ticket details (public proof) |
| `/mine` | My tickets (auth required) |
| `/verify` | Ticket verification tool |

---

## Data Model

### Ticket
```typescript
interface Ticket {
  id: string;                     // tkt_xxx
  ticketTypeId: string;           // Reference to ticket_types
  eventId: string;                // Denormalized for queries
  ownerDid: string;               // Current owner
  originalOwnerDid: string;       // First purchaser
  purchasedAt: Date;
  paymentId?: string;             // Stripe payment ID
  fair: FairManifest;             // Attribution data
  signature: string;              // Ed25519 signature
  status: 'valid' | 'used' | 'refunded' | 'transferred';
  usedAt?: Date;
  transferHistory?: Transfer[];
  createdAt: Date;
}

interface Transfer {
  from: string;                   // DID
  to: string;                     // DID
  at: Date;
  signature: string;              // Signed by `from`
}

interface FairManifest {
  version: '1.0';
  type: 'ticket';
  creator: string;                // Event creator DID
  event: string;                  // Event ID
  splits: Array<{
    to: string;                   // DID
    percent: number;              // 0-100
    role: string;                 // "creator", "platform", etc.
  }>;
  createdAt: string;
  signature: string;
}
```

---

## Database Schema

```sql
CREATE TABLE tickets (
  id                  TEXT PRIMARY KEY,
  ticket_type_id      TEXT NOT NULL,
  event_id            TEXT NOT NULL,
  owner_did           TEXT NOT NULL,
  original_owner_did  TEXT NOT NULL,
  purchased_at        TIMESTAMPTZ NOT NULL,
  payment_id          TEXT,
  fair_manifest       JSONB NOT NULL,
  signature           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'valid'
                        CHECK (status IN ('valid', 'used', 'refunded', 'transferred')),
  used_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE ticket_transfers (
  id              TEXT PRIMARY KEY,
  ticket_id       TEXT REFERENCES tickets(id),
  from_did        TEXT NOT NULL,
  to_did          TEXT NOT NULL,
  transferred_at  TIMESTAMPTZ NOT NULL,
  signature       TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_tickets_owner ON tickets(owner_did);
CREATE INDEX idx_tickets_event ON tickets(event_id);
CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_tickets_type ON tickets(ticket_type_id);
CREATE INDEX idx_transfers_ticket ON ticket_transfers(ticket_id);
```

---

## Purchase Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        PURCHASE FLOW                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. User clicks "Buy" on event page                             │
│     → POST /api/tickets/purchase                                │
│     → { eventId, ticketTypeId, quantity, buyerDid }             │
│                                                                 │
│  2. Tickets service checks availability                         │
│     → Query ticket_types for remaining                          │
│     → Reserve tickets (optimistic lock)                         │
│                                                                 │
│  3. Tickets service initiates payment                           │
│     → POST pay.imajin.ai/api/checkout                           │
│     → Returns Stripe checkout URL                               │
│                                                                 │
│  4. User completes payment on Stripe                            │
│     → Stripe webhook → pay.imajin.ai                            │
│     → Pay service notifies tickets service                      │
│                                                                 │
│  5. Tickets service mints ticket                                │
│     → Create ticket record with signature                       │
│     → Generate .fair manifest                                   │
│     → Increment sold count on ticket_type                       │
│                                                                 │
│  6. User receives ticket                                        │
│     → Ticket visible in /mine                                   │
│     → QR code for entry                                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Usage

### Purchase Ticket
```typescript
const response = await fetch('https://tickets.imajin.ai/api/tickets/purchase', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    eventId: 'evt_xxx',
    ticketTypeId: 'tkt_type_xxx',
    quantity: 1,
  }),
});

const { checkoutUrl } = await response.json();
window.location.href = checkoutUrl; // Redirect to Stripe
```

### Verify Ticket
```typescript
const response = await fetch('https://tickets.imajin.ai/api/tickets/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    ticketId: 'tkt_xxx',
    // OR scan QR which contains signed payload
    qrPayload: '...',
  }),
});

const { valid, ticket, event } = await response.json();
// { valid: true, ticket: {...}, event: {...} }
```

### Transfer Ticket
```typescript
const response = await fetch('https://tickets.imajin.ai/api/tickets/tkt_xxx/transfer', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    toDid: 'did:imajin:recipient123',
    signature: '...', // Owner signs transfer intent
  }),
});
```

### List My Tickets
```typescript
const response = await fetch('https://tickets.imajin.ai/api/tickets?owner=did:imajin:me123', {
  headers: { 'Authorization': 'Bearer imajin_tok_xxx' },
});

const { tickets } = await response.json();
```

---

## Ticket Page

Public proof at `tickets.imajin.ai/:id`:

```
┌─────────────────────────────────────────┐
│                                         │
│            🎫 TICKET                    │
│                                         │
│   Jin's Launch Party                    │
│   April 1, 2026 · Virtual               │
│                                         │
│   ┌─────────────┐                       │
│   │   [QR]      │  Owner: @ryan         │
│   │             │  Type: Virtual        │
│   │             │  Status: ✅ Valid     │
│   └─────────────┘                       │
│                                         │
│   Purchased: Feb 14, 2026               │
│   Signature: 0x4a8b...                  │
│                                         │
│   .fair Attribution:                    │
│   └─ 100% → Jin (creator)               │
│                                         │
└─────────────────────────────────────────┘
```

---

## QR Code Format

QR contains signed JSON:
```json
{
  "ticketId": "tkt_xxx",
  "eventId": "evt_xxx",
  "owner": "did:imajin:xxx",
  "timestamp": 1707936000000,
  "signature": "..."
}
```

Scanner verifies signature against owner's public key.

---

## .fair Manifest

Every ticket includes attribution:
```json
{
  "version": "1.0",
  "type": "ticket",
  "creator": "did:imajin:jin123",
  "event": "evt_xxx",
  "splits": [
    { "to": "did:imajin:jin123", "percent": 97, "role": "creator" },
    { "to": "did:imajin:platform", "percent": 3, "role": "platform" }
  ],
  "createdAt": "2026-02-14T20:00:00Z",
  "signature": "..."
}
```

---

## Integration

### With events.imajin.ai
- Fetches event + ticket type data
- Updates sold count on successful purchase

### With pay.imajin.ai
- Initiates checkout sessions
- Receives webhook confirmations
- Handles refunds

### With auth.imajin.ai
- Validates buyer identity
- Verifies signatures for transfers

### With profile.imajin.ai
- Displays owner info on ticket page

---

## Configuration

```bash
DATABASE_URL=postgres://...
AUTH_SERVICE_URL=https://auth.imajin.ai
PAY_SERVICE_URL=https://pay.imajin.ai
EVENTS_SERVICE_URL=https://events.imajin.ai
NEXT_PUBLIC_BASE_URL=https://tickets.imajin.ai
WEBHOOK_SECRET=whsec_xxx
```

---

## TODO

- [ ] Scaffold Next.js app
- [ ] Database schema + Drizzle setup
- [ ] Purchase flow API
- [ ] Ticket minting with signatures
- [ ] .fair manifest generation
- [ ] Transfer functionality
- [ ] QR code generation
- [ ] Verification endpoint
- [ ] My tickets page
- [ ] Integration with pay webhooks
