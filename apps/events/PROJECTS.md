# apps/events — events.imajin.ai

**Status:** 🔴 Not Started  
**Domain:** events.imajin.ai  
**Port:** 3006  
**Stack:** Next.js 14, Tailwind, Drizzle, Neon Postgres

---

## Overview

Create and discover events on the sovereign network. No Eventbrite fees. No data harvesting.

**What it does:**
- Create events (linked to creator DID)
- Configure ticket types and pricing
- Event discovery and search
- Event pages with details and ticket purchase
- Virtual + physical location support

**What it doesn't do:**
- Ticket sales (that's `tickets` + `pay`)
- Ticket verification (that's `tickets`)
- Attendee messaging (that's `chat`)

---

## Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/events` | Create event | Required |
| GET | `/api/events/:id` | Get event details | No |
| PUT | `/api/events/:id` | Update event | Required (creator) |
| DELETE | `/api/events/:id` | Cancel event | Required (creator) |
| GET | `/api/events/search` | Search/filter events | No |
| GET | `/api/events/:id/tickets` | Get ticket types for event | No |
| POST | `/api/events/:id/tickets` | Configure ticket types | Required (creator) |

---

## Public Pages

| Path | Description |
|------|-------------|
| `/` | Event discovery / search |
| `/:id` | Event details page |
| `/:id/edit` | Edit event (auth required) |
| `/create` | Create new event (auth required) |
| `/mine` | My events (auth required) |

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
```

---

## Database Schema

```sql
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

-- Indexes
CREATE INDEX idx_events_creator ON events(creator_did);
CREATE INDEX idx_events_date ON events(date);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_ticket_types_event ON ticket_types(event_id);

-- Full text search
CREATE INDEX idx_events_search ON events 
  USING GIN (to_tsvector('english', title || ' ' || COALESCE(description, '')));
```

---

## Usage

### Create Event
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
    status: "published"
  }),
});

const event = await response.json();
// { id: "evt_xxx", title: "Jin's Launch Party", ... }
```

### Configure Tickets
```typescript
const response = await fetch('https://events.imajin.ai/api/events/evt_xxx/tickets', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer imajin_tok_xxx',
  },
  body: JSON.stringify({
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

## Integration

### With auth.imajin.ai
- Event creation requires valid token
- Creator DID validated against auth

### With tickets.imajin.ai
- "Buy" buttons link to tickets purchase flow
- Event page shows real-time availability

### With pay.imajin.ai
- Ticket purchases routed through pay
- Creator receives funds (minus fees)

### With profile.imajin.ai
- Creator name/avatar pulled from profile
- Link to creator's profile page

---

## Configuration

```bash
DATABASE_URL=postgres://...
AUTH_SERVICE_URL=https://auth.imajin.ai
TICKETS_SERVICE_URL=https://tickets.imajin.ai
NEXT_PUBLIC_BASE_URL=https://events.imajin.ai
```

---

## TODO

- [ ] Scaffold Next.js app
- [ ] Database schema + Drizzle setup
- [ ] API routes (events CRUD)
- [ ] API routes (ticket types)
- [ ] Event discovery page
- [ ] Event detail page
- [ ] Event creation UI
- [ ] Search functionality
- [ ] Auth integration
- [ ] Integration with tickets service
