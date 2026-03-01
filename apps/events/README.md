# imajin-events

**Create events. Sell tickets. Own your audience.**

Part of the [Imajin](https://github.com/ima-jin/imajin-ai) sovereign stack.

---

## What This Is

A self-hostable event platform that:

- Creates events linked to your DID
- Sells tickets via your own Stripe (not ours)
- Issues tickets signed by the event itself
- No platform fees. No lock-in. You own everything.

---

## Architecture

```
events app                      pay service
(this repo)                     (your node's Stripe keys)
     │                                │
     └──── POST /api/checkout ────────┘
                  │
                  ↓
            Stripe Checkout
                  │
                  ↓
            Webhook → Ticket created
```

This app doesn't touch Stripe directly. It calls your node's pay service, which has your keys. Money goes to you.

---

## Features

- **Event creation** — title, description, date, location (virtual/physical)
- **Ticket types** — multiple tiers with different prices/quantities
- **Checkout flow** — redirects to Stripe via pay service
- **Ticket issuance** — webhook creates signed ticket record
- **Email confirmations** — template-ready (bring your own SMTP)

---

## First Event

**Jin's Launch Party** — April 1, 2026

The genesis event on the sovereign network.

- 🟠 Virtual: $1 (unlimited)
- 🎫 Physical: $10 (500 available, Toronto)

See it live: `/jins-launch-party`

---

## Quick Start

```bash
# Clone
git clone https://github.com/ima-jin/imajin-events.git
cd imajin-events

# Install
pnpm install

# Configure
cp .env.example .env.local
# Edit with your DATABASE_URL, PAY_SERVICE_URL, etc.

# Push schema
pnpm db:push

# Run
pnpm dev
# → http://localhost:3007
```

---

## Environment

```bash
# Database (Neon Postgres)
DATABASE_URL="postgresql://..."

# Services
PAY_SERVICE_URL="http://localhost:3004"
AUTH_SERVICE_URL="http://localhost:3003"
NEXT_PUBLIC_EVENTS_URL="http://localhost:3007"

# Webhook (from pay service)
WEBHOOK_SECRET="your-shared-secret"

# Email (any SMTP - SendGrid, Proton, etc.)
SMTP_HOST="smtp.sendgrid.net"
SMTP_PORT="587"
SMTP_USER="apikey"
SMTP_PASSWORD="SG.xxx"
SMTP_FROM="Your Name <you@example.com>"
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Event listing |
| GET | `/:eventId` | Event details + tickets |
| POST | `/api/checkout` | Create checkout session |
| POST | `/api/webhook/payment` | Receive payment callbacks |
| GET | `/checkout/success` | Post-purchase confirmation |

---

## Schema

```typescript
// Event
{
  id: "jins-launch-party",
  did: "did:imajin:evt_xxx",
  creatorDid: "did:imajin:xxx",
  title: "Jin's Launch Party",
  startsAt: "2026-04-01T23:00:00Z",
  isVirtual: true,
  status: "published"
}

// Ticket Type
{
  id: "tkt_type_xxx",
  eventId: "jins-launch-party",
  name: "Virtual",
  price: 100,  // cents
  quantity: null  // unlimited
}

// Ticket (issued on purchase)
{
  id: "tkt_xxx",
  ownerDid: "did:imajin:buyer",
  signature: "...",  // signed by event
  status: "valid"
}
```

---

## License

MIT

---

*Part of [Imajin](https://imajin.ai) — sovereign infrastructure for humans, agents, and events.*
