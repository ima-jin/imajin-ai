# apps/events — events.imajin.ai

**Status:** 🔴 Not Started  
**Domain:** events.imajin.ai  
**Port:** 3006  
**Stack:** Next.js 14, Tailwind, Drizzle, Neon Postgres

---

## Overview

Create events, sell tickets, verify attendance. The full lifecycle on the sovereign network.

**What it does:**
- Create events (linked to creator DID)
- Configure ticket types and pricing
- Event discovery and search
- Purchase tickets (initiates payment flow)
- Ticket ownership (linked to owner DID)
- Transfer tickets between DIDs
- Verify ticket authenticity (signed, unforgeable)
- Generate .fair attribution manifests

**What it doesn't do:**
- Payment processing (that's `pay`)
- Attendee messaging (that's `chat`)
- Recurring subscriptions (future maybe)

---

## Endpoints

### Events

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/events` | Create event with ticket types | Required |
| GET | `/api/events/:id` | Get event details | No |
| PUT | `/api/events/:id` | Update event | Required (creator) |
| DELETE | `/api/events/:id` | Cancel event | Required (creator) |
| GET | `/api/events/search` | Search/filter events | No |

### Tickets

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/events/:id/purchase` | Initiate ticket purchase | Required |
| GET | `/api/events/:id/tickets` | List tickets for event | No |
| GET | `/api/tickets/:id` | Get ticket details | No |
| GET | `/api/my/tickets` | List my tickets | Required |
| POST | `/api/tickets/:id/transfer` | Transfer to another DID | Required (owner) |
| POST | `/api/tickets/verify` | Verify ticket signature | No |
| GET | `/api/tickets/:id/qr` | Generate QR code | No |

---

## Public Pages

| Path | Description |
|------|-------------|
| `/` | Event discovery / search |
| `/:id` | Event details + ticket purchase |
| `/:id/edit` | Edit event (auth required) |
| `/create` | Create new event (auth required) |
| `/my/events` | My created events (auth required) |
| `/my/tickets` | My purchased tickets (auth required) |
| `/tickets/:id` | Ticket details (public proof) |
| `/verify` | Ticket verification tool |

---

## Data Model

### Event
```typescript
interface Event {
  id: string;                     // evt_xxx
  creatorDid: string;             // DID of creator
  title: string;
  description?: string;
  date: Date;                     // Event start time
  endDate?: Date;                 // Event end time
  location: {
    virtual: boolean;
    virtualUrl?: string;          // Zoom, Unreal, etc.
    physical?: {
      venue?: string;
      address?: string;
      city: string;
      country?: string;
      coordinates?: { lat: number; lng: number };
    };
  };
  status: 'draft' | 'published' | 'cancelled' | 'completed';
  image?: string;                 // Cover image URL
  tags?: string[];
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

interface TicketType {
  id: string;                     // tkt_type_xxx
  eventId: string;
  name: string;                   // "Virtual", "Physical", "VIP"
  description?: string;
  price: number;                  // In cents
  currency: string;               // USD, CAD, etc.
  quantity?: number;              // null = unlimited
  sold: number;                   // Count sold
  maxPerPerson?: number;          // Purchase limit
  salesStart?: Date;
  salesEnd?: Date;
  createdAt: Date;
}

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
  createdAt: Date;
}

interface Transfer {
  id: string;
  ticketId: string;
  fromDid: string;
  toDid: string;
  transferredAt: Date;
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
-- Events
CREATE TABLE events (
  id              TEXT PRIMARY KEY,
  creator_did     TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  date            TIMESTAMPTZ NOT NULL,
  end_date        TIMESTAMPTZ,
  location        JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' 
                    CHECK (status IN ('draft', 'published', 'cancelled', 'completed')),
  image           TEXT,
  tags            TEXT[],
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Ticket Types (configured per event)
CREATE TABLE ticket_types (
  id              TEXT PRIMARY KEY,
  event_id        TEXT REFERENCES events(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  price           INTEGER NOT NULL,          -- cents
  currency        TEXT NOT NULL DEFAULT 'USD',
  quantity        INTEGER,                   -- null = unlimited
  sold            INTEGER NOT NULL DEFAULT 0,
  max_per_person  INTEGER,
  sales_start     TIMESTAMPTZ,
  sales_end       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Tickets (purchased)
CREATE TABLE tickets (
  id                  TEXT PRIMARY KEY,
  ticket_type_id      TEXT REFERENCES ticket_types(id),
  event_id            TEXT REFERENCES events(id),
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

-- Transfer history
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
CREATE INDEX idx_events_creator ON events(creator_did);
CREATE INDEX idx_events_date ON events(date);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_ticket_types_event ON ticket_types(event_id);
CREATE INDEX idx_tickets_owner ON tickets(owner_did);
CREATE INDEX idx_tickets_event ON tickets(event_id);
CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_transfers_ticket ON ticket_transfers(ticket_id);

-- Full text search
CREATE INDEX idx_events_search ON events 
  USING GIN (to_tsvector('english', title || ' ' || COALESCE(description, '')));
```

---

## Purchase Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        PURCHASE FLOW                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. User clicks "Buy" on event page                             │
│     → POST /api/events/:id/purchase                             │
│     → { ticketTypeId, quantity }                                │
│                                                                 │
│  2. Events service checks availability                          │
│     → Query ticket_types for remaining                          │
│     → Reserve tickets (optimistic lock)                         │
│                                                                 │
│  3. Events service initiates payment                            │
│     → POST pay.imajin.ai/api/checkout                           │
│     → Returns Stripe checkout URL                               │
│                                                                 │
│  4. User completes payment on Stripe                            │
│     → Stripe webhook → pay.imajin.ai                            │
│     → Pay service calls events webhook                          │
│                                                                 │
│  5. Events service mints ticket                                 │
│     → Create ticket record with signature                       │
│     → Generate .fair manifest                                   │
│     → Increment sold count on ticket_type                       │
│                                                                 │
│  6. User receives ticket                                        │
│     → Ticket visible in /my/tickets                             │
│     → QR code for entry                                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Usage

### Create Event with Tickets
```typescript
const response = await fetch('https://events.imajin.ai/api/events', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    title: "Jin's Launch Party",
    description: "The first event on the sovereign network",
    date: "2026-04-01T19:00:00-04:00",
    location: {
      virtual: true,
      virtualUrl: "https://party.imajin.ai",
      physical: {
        city: "Toronto",
        venue: "TBD"
      }
    },
    status: "published",
    tickets: [
      {
        name: "Virtual",
        price: 100,           // $1.00
        currency: "USD",
        quantity: null,       // Unlimited
      },
      {
        name: "Physical",
        price: 1000,          // $10.00
        currency: "USD",
        quantity: 500,        // Cap at 500
      }
    ]
  }),
});

const event = await response.json();
// { id: "evt_xxx", title: "Jin's Launch Party", tickets: [...] }
```

### Search Events
```typescript
// Upcoming events
const response = await fetch('https://events.imajin.ai/api/events/search?status=published&after=2026-02-14');

// By creator
const response = await fetch('https://events.imajin.ai/api/events/search?creator=did:imajin:jin123');

// Full text search
const response = await fetch('https://events.imajin.ai/api/events/search?q=launch+party');
```

### Purchase Ticket
```typescript
const response = await fetch('https://events.imajin.ai/api/events/evt_xxx/purchase', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    ticketTypeId: 'tkt_type_xxx',
    quantity: 1,
  }),
});

const { checkoutUrl } = await response.json();
window.location.href = checkoutUrl; // Redirect to Stripe
```

### Verify Ticket
```typescript
const response = await fetch('https://events.imajin.ai/api/tickets/verify', {
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
const response = await fetch('https://events.imajin.ai/api/tickets/tkt_xxx/transfer', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
    toDid: 'did:imajin:recipient123',
  }),
});
```

### List My Tickets
```typescript
const response = await fetch('https://events.imajin.ai/api/my/tickets', {
  headers: { 'Authorization': 'Bearer imajin_tok_xxx' },
});

const { tickets } = await response.json();
```

---

## Event Page

Public page at `events.imajin.ai/:id`:

```
┌─────────────────────────────────────────┐
│  [Event Image]                          │
│                                         │
│  Jin's Launch Party                     │
│  April 1, 2026 · 7:00 PM ET             │
│                                         │
│  🌐 Virtual + 📍 Toronto                │
│                                         │
│  The first event on the sovereign       │
│  network. Genesis transaction.          │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │ Virtual Ticket      $1    [Buy] │   │
│  │ Physical Ticket    $10    [Buy] │   │
│  │                    482 remaining │   │
│  └─────────────────────────────────┘   │
│                                         │
│  Hosted by: Jin (@jin)                  │
│                                         │
└─────────────────────────────────────────┘
```

---

## Ticket Page

Public proof at `events.imajin.ai/tickets/:id`:

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

### With auth.imajin.ai
- Event creation requires valid token
- Validates buyer identity
- Verifies signatures for transfers

### With pay.imajin.ai
- Initiates checkout sessions
- Receives webhook confirmations
- Handles refunds

### With profile.imajin.ai
- Creator name/avatar on event page
- Owner info on ticket page

---

## Configuration

```bash
DATABASE_URL=postgres://...
AUTH_SERVICE_URL=https://auth.imajin.ai
PAY_SERVICE_URL=https://pay.imajin.ai
PROFILE_SERVICE_URL=https://profile.imajin.ai
NEXT_PUBLIC_BASE_URL=https://events.imajin.ai
WEBHOOK_SECRET=whsec_xxx
```

---

## TODO

- [ ] Scaffold Next.js app
- [ ] Database schema + Drizzle setup
- [ ] Event CRUD APIs
- [ ] Ticket type configuration
- [ ] Purchase flow + pay integration
- [ ] Ticket minting with signatures
- [ ] .fair manifest generation
- [ ] Transfer functionality
- [ ] QR code generation
- [ ] Verification endpoint
- [ ] Event discovery page
- [ ] Event detail page
- [ ] My tickets page
- [ ] My events page
- [ ] Search functionality
- [ ] Webhook handling for payment confirmations
