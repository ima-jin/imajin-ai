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

# Registered-app identity (settlement, #2739)
IMAJIN_KERNEL_URL="http://localhost:3000"
IMAJIN_APP_DID="did:imajin:..."        # required once the bootstrap keystore exists
IMAJIN_APP_CLAIM_CODE="..."            # one-time, first boot only

# Email (any SMTP - SendGrid, Proton, etc.)
SMTP_HOST="smtp.sendgrid.net"
SMTP_PORT="587"
SMTP_USER="apikey"
SMTP_PASSWORD="SG.xxx"
SMTP_FROM="Your Name <you@example.com>"
```

### Settlement (registered-app contract)

Events settles a paid ticket order itself. At checkout it authenticates to the pay service with
its **own app-service token** (minted from its signing key via `@imajin/auth-client`) and declares
the payee manifest (the resolved `.fair` chain). When the pay webhook reports the payment, events
calls `POST /pay/api/settle` with the same token, the checkout's `transaction_id` and the
`fair_manifest`. `alreadySettled: true` is treated as success. The shared `PAY_SERVICE_API_KEY`
is not used for settlement (refunds and campaign charge-pledges still use it, #2735).

Operator prerequisites before ticket checkout works:

1. Register events as an app and provision its signing key (`apps.provision`); give events
   `IMAJIN_KERNEL_URL`, `IMAJIN_APP_DID` and the one-time `IMAJIN_APP_CLAIM_CODE`.
2. Approve `pay:settle` for events through the operator-countersigned `apps:service-scopes` card.
3. Deploy the kernel contract (#2695) first.
4. The pay service's `checkout.completed` webhook to events must carry the checkout's kernel
   `transactionId` (the key `/pay/api/settle` needs). Until it does, events logs
   `Pay webhook carried no transactionId — order NOT settled` and skips settlement.

Without these, checkout for an event with a `.fair` chain fails closed (503) rather than taking a
payment that cannot pay the organizer.

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

[Imajin Network License (INL) v1.0](../../LICENSE.md) — see the root [README](../../README.md#license) for the summary.

---

*Part of [Imajin](https://imajin.ai) — sovereign infrastructure for humans, agents, and events.*
