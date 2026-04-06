# Work Order: Notification Service

**Priority:** High — immediate need (market sale emails), near-term need (in-app notifications, 3rd party scoping)
**Estimated effort:** 2-3 days
**Port:** 3010 (dev) / 7010 (prod) — replaces input service (3008/7008)
**Schema:** `notify`
**Domain:** dev-notify.imajin.ai / notify.imajin.ai

---

## Problem

No centralized notification system. Current state:
- Events service sends emails directly via SendGrid (hardcoded in events)
- Market has no post-sale notifications at all
- Coffee service has no notification on tip received
- No in-app notifications anywhere
- No infrastructure for 3rd party apps to notify users
- Email sending logic would need to be duplicated into every service

---

## Input Service Transition

The `input` service (port 3008/7008) is being retired. Its responsibilities are redistributed:

| Current input responsibility | New home |
|------------------------------|----------|
| Voice recording UI | `@imajin/input` package (already there) |
| Whisper transcription proxy | Direct client → GPU node call, or thin proxy in media service |
| Service port 3008/7008 | Freed up (notify takes 3010/7010) |

The input service was always a passthrough — voice recording is client-side, transcription is on the GPU node. There's no persistent state or business logic that requires a dedicated service. The `packages/input` package with VoiceRecorder already handles the client-side work.

---

## UI Components (DFOS-Inspired)

Notification UI follows patterns observed in DFOS's notification system. All UI lives in `@imajin/ui` as shared components, NOT in the notify service.

### Notification Bell + Panel
- Lives in shared NavBar (already in `@imajin/ui`)
- Unread badge count
- Click opens dropdown panel with notification history
- Each notification: icon, title, body, timestamp, read/unread state
- Mark individual or all as read

### Toast Notifications
- Slide in bottom-right, auto-dismiss 5-8s
- For real-time "just happened" events
- Triggered by polling or SSE from notify service

### Banner Notifications
- Full-width top bar, requires manual dismissal
- Action-required items only (rare)
- Urgent scope items (payment failures, security alerts)

### Context Menus (future)
- Per-item actions: Reply, Bookmark, Mute, Pin
- Emoji quick-reactions (👍❤️😂🔥👀) + full picker
- Reactions stored in relevant service (chat has `message_reactions` already)
- Context menu component is generic `@imajin/ui`, actions route to owning service

### Provider Pattern
```typescript
// In kernel shell / app root
<NotificationProvider>
  <NavBar /> {/* bell lives here */}
  <ToastContainer /> {/* toasts render here */}
  {children}
</NotificationProvider>
```

Initial delivery: polling (`/api/notifications/unread` every 30s).
Follow-up: SSE or WebSocket for real-time push.

This component architecture aligns with RFC-19's kernel shell model — the notification UI is kernel infrastructure, rendered once, available to all userspace apps via the shell.

---

## Architecture

### Caller Package: `@imajin/notify`

Thin client package that any service imports. Handles the HTTP call to the notify service.

```typescript
import { notify } from '@imajin/notify';

// From any service
await notify.send({
  to: sellerDid,
  scope: 'market:sale',
  data: {
    listingTitle: 'Vintage Synth',
    amount: 45000,  // cents
    currency: 'CAD',
    buyerName: 'Someone',
  },
});
```

The package POSTs to the notification service. Internal services authenticate via shared webhook secret (`NOTIFY_WEBHOOK_SECRET`). This keeps the interface stable — if we later add queuing or switch transports, callers don't change.

### Service: `apps/notify`

Core service at 3010/7010. Responsibilities:

1. **Receive notification requests** — authenticated endpoint
2. **Check delivery rules** — user preferences, rate limits, delegation VCs (3rd party)
3. **Deliver** — in-app (DB write), email (SendGrid), push (future)
4. **Store** — all notifications persisted for in-app UI

---

## Schema

```sql
CREATE SCHEMA IF NOT EXISTS notify;

-- All notifications (in-app history + delivery log)
CREATE TABLE notify.notifications (
  id TEXT PRIMARY KEY,
  recipient_did TEXT NOT NULL,
  sender_did TEXT,                      -- service DID or user DID
  scope TEXT NOT NULL,                  -- 'market:sale', 'event:reminder', 'chat:mention'
  urgency TEXT NOT NULL DEFAULT 'normal', -- 'low' | 'normal' | 'urgent'
  title TEXT NOT NULL,
  body TEXT,
  data JSONB DEFAULT '{}',             -- structured payload (listing info, event info, etc.)
  channels_sent TEXT[] DEFAULT '{}',   -- ['email', 'inapp'] — what actually got delivered
  read BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_recipient ON notify.notifications(recipient_did, created_at DESC);
CREATE INDEX idx_notifications_unread ON notify.notifications(recipient_did) WHERE read = FALSE;

-- User delivery preferences
CREATE TABLE notify.preferences (
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  scope TEXT NOT NULL,                  -- 'market:sale' or '*' for default
  email BOOLEAN DEFAULT TRUE,
  inapp BOOLEAN DEFAULT TRUE,
  push BOOLEAN DEFAULT FALSE,          -- future
  UNIQUE(did, scope)
);

-- 3rd party app grants (delegation VC references)
CREATE TABLE notify.grants (
  id TEXT PRIMARY KEY,
  user_did TEXT NOT NULL,               -- who granted
  app_did TEXT NOT NULL,                -- who received the grant
  scope TEXT NOT NULL,                  -- what scope was granted
  rate_limit INTEGER DEFAULT 10,        -- max notifications per day for this grant
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  UNIQUE(user_did, app_did, scope)
);

-- Rate limiting state for 3rd party apps
CREATE TABLE notify.rate_limits (
  app_did TEXT NOT NULL,
  user_did TEXT NOT NULL,
  scope TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,    -- start of current rate window
  count INTEGER DEFAULT 0,
  PRIMARY KEY(app_did, user_did, scope)
);
```

---

## API Routes

### Internal (service-to-service)

```
POST /api/send
  Auth: x-webhook-secret header
  Body: { to, scope, data, from? }
  → Resolves template, checks preferences, delivers, stores

POST /api/send/bulk
  Auth: x-webhook-secret header
  Body: { recipients: [{ to, scope, data }] }
  → Batch send (event announcements, etc.)
```

### User-facing (session auth)

```
GET  /api/notifications            → list my notifications (paginated)
GET  /api/notifications/unread     → unread count
POST /api/notifications/:id/read   → mark as read
POST /api/notifications/read-all   → mark all as read

GET  /api/preferences              → my delivery preferences
PUT  /api/preferences/:scope       → update preferences for a scope
```

### 3rd party (bearer token + delegation VC)

```
POST /api/v1/send
  Auth: Bearer <app-token>
  Body: { to, scope, data }
  → Checks delegation grant, rate limit, then delivers
```

---

## Templates

Templates are code, not DB rows. Each scope maps to a render function.

```typescript
// src/templates/market-sale.ts
export const marketSale = {
  scope: 'market:sale',
  title: (data) => `Your listing "${data.listingTitle}" sold!`,
  body: (data) => `${data.buyerName || 'Someone'} purchased your listing for ${formatCurrency(data.amount, data.currency)}.`,
  email: {
    subject: (data) => `Sale: ${data.listingTitle}`,
    // HTML template or use a shared layout
  },
};
```

## Urgency Levels

Templates set default urgency per scope. Users can override via preferences.

| Urgency | UI Treatment |
|---------|-------------|
| `low` | Bell only (unread badge, check when you want) |
| `normal` | Bell + toast (auto-dismiss 5-8s, real-time awareness) |
| `urgent` | Bell + banner (full-width top bar, requires dismissal) |

## In-App Notification UI

Three layers, implemented as `@imajin/ui` components:

1. **Notification bell** — lives in shared nav, badge with unread count, click opens dropdown/panel with history
2. **Toast** — slides in bottom-right, auto-dismisses after 5-8s. For "just happened" events while user is active
3. **Banner** — full-width bar at top of page, requires manual dismissal. Action-required items only (rare)

Wrapped in `<NotificationProvider>` at app root. Initial delivery via polling (`/api/notifications/unread` every 30s), SSE upgrade as follow-up.

**Initial scopes:**
| Scope | Trigger | Recipients |
|-------|---------|------------|
| `market:sale` | Checkout completed (market listing) | Seller |
| `market:purchase` | Checkout completed (market listing) | Buyer |
| `event:ticket` | Ticket purchased | Buyer |
| `event:registration` | New registration | Event organizer |
| `chat:mention` | @mentioned in chat | Mentioned user |
| `coffee:tip` | Tip received | Page owner |

---

## Integration Points

### Pay service changes

In `handleCheckoutCompleted`, after updating transaction status:

```typescript
if (session.metadata?.service === 'market') {
  // 1. Notify market service for state change (keep existing webhook pattern)
  await notifyMarketService('checkout.completed', session);

  // 2. Send user notifications via notify service
  const notifyUrl = process.env.NOTIFY_SERVICE_URL;
  const notifySecret = process.env.NOTIFY_WEBHOOK_SECRET;

  // Seller notification
  await fetch(`${notifyUrl}/api/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-secret': notifySecret,
    },
    body: JSON.stringify({
      to: session.metadata.sellerDid,
      scope: 'market:sale',
      data: {
        listingId: session.metadata.listingId,
        listingTitle: session.metadata.listingTitle,
        amount: session.amount_total,
        currency: session.currency,
        buyerDid: session.metadata.buyerDid,
      },
    }),
  });

  // Buyer notification
  if (session.metadata.buyerDid) {
    await fetch(`${notifyUrl}/api/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': notifySecret,
      },
      body: JSON.stringify({
        to: session.metadata.buyerDid,
        scope: 'market:purchase',
        data: {
          listingId: session.metadata.listingId,
          listingTitle: session.metadata.listingTitle,
          amount: session.amount_total,
          currency: session.currency,
        },
      }),
    });
  }
}
```

**Or better** — use the `@imajin/notify` package directly from pay:

```typescript
import { notify } from '@imajin/notify';

await notify.send({
  to: session.metadata.sellerDid,
  scope: 'market:sale',
  data: { ... },
});
```

### Events migration

Move events' existing SendGrid email logic into notify service. Events service switches to `notify.send()` calls. This can happen as a follow-up — existing events emails keep working.

### Nav notification bell

Shared nav component (already exists in `@imajin/ui`) adds a bell icon. Client-side: poll `/api/notifications/unread` from notify service, or SSE/WebSocket later.

---

## Env Vars

```bash
# In notify service .env.local
DATABASE_URL=postgres://...
SENDGRID_API_KEY=...
SENDGRID_FROM_EMAIL=notifications@imajin.ai
AUTH_SERVICE_URL=https://auth.imajin.ai

# In every other service that uses @imajin/notify
NOTIFY_SERVICE_URL=http://localhost:3010  # or https://notify.imajin.ai
NOTIFY_WEBHOOK_SECRET=<shared-secret>
```

---

## Implementation Order

1. **Scaffold service** — apps/notify, schema, health endpoint, drizzle-kit push
2. **`@imajin/notify` package** — thin client with `notify.send()`
3. **POST /api/send** — receive, store notification, send email
4. **Market sale templates** — `market:sale` + `market:purchase`
5. **Pay integration** — add notify calls in `handleCheckoutCompleted`
6. **Market webhook** — add `notifyMarketService` in pay for listing state changes
7. **GET /api/notifications** — user-facing read endpoints
8. **Notification bell** — nav UI component

### Follow-ups (not this PR)
- Migrate events email to notify
- Migrate coffee tip notifications
- 3rd party grants + rate limiting
- WebSocket/SSE for real-time push
- Push notifications (mobile)

---

## Checklist (per AGENTS.md)

- [ ] Update `docs/ENVIRONMENTS.md` with port 3010/7010
- [ ] Update `docs/DEVELOPER.md` with schema
- [ ] Update `README.md` apps table
- [ ] Add `.env.example` in apps/notify
- [ ] Add to pm2 ecosystem config
- [ ] Add Caddy routes for notify.imajin.ai
