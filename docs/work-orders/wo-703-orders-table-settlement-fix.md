# Work Order: Orders Table + Settlement Fee Fix (#703)

**Goal:** Introduce a first-class `events.orders` table so purchase-level data and .fair settlement live at order level (not ticket level). Fix settlement math so the organizer's share correctly reflects Stripe fee deduction.

**Branch:** `feat/703-orders-settlement` from `main`
**Issue:** #703

---

## Context — READ THESE FILES FIRST

Before writing any code, read and understand:

1. `apps/events/src/db/schema.ts` — current tickets/ticketTypes schema
2. `apps/events/app/api/webhook/payment/route.ts` — where tickets are created after Stripe payment
3. `apps/events/src/lib/settle.ts` — settlement logic (calls pay service)
4. `apps/events/app/[eventId]/tickets-section.tsx` — UI displaying tickets + .fair receipt
5. `apps/events/app/[eventId]/page.tsx` lines 140-185 — `getUserTickets()` function
6. `packages/fair/src/constants.ts` — STRIPE_RATE_BPS, STRIPE_FIXED_CENTS
7. `packages/fair/src/types.ts` — FairFee, FairManifest types

**Key patterns to follow:**
- IDs use `generateId('ord')` pattern (see `src/lib/kernel/id.ts` or events equivalent)
- All tables live in `eventsSchema` (pgSchema('events'))
- Migrations go in `apps/events/drizzle/` — next is `0004`
- **You MUST add journal entries to `drizzle/meta/_journal.json` and create snapshot files**

---

## WO1 — Schema: Orders Table + Migration

### 1.1 Add `orders` table to `apps/events/src/db/schema.ts`

```ts
export const orders = eventsSchema.table('orders', {
  id: text('id').primaryKey(),                              // ord_xxx
  eventId: text('event_id').references(() => events.id).notNull(),
  buyerDid: text('buyer_did'),                              // owner DID
  ticketTypeId: text('ticket_type_id').references(() => ticketTypes.id).notNull(),
  quantity: integer('quantity').notNull().default(1),
  amountTotal: integer('amount_total').notNull(),           // cents
  currency: text('currency').notNull().default('CAD'),
  paymentMethod: text('payment_method'),                    // 'stripe' | 'etransfer' | 'free'
  stripeSessionId: text('stripe_session_id'),
  paymentId: text('payment_id'),                            // stripe payment_intent id
  fairSettlement: jsonb('fair_settlement'),                  // resolved .fair receipt
  purchasedAt: timestamp('purchased_at', { withTimezone: true }),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  eventIdx: index('idx_orders_event').on(table.eventId),
  buyerIdx: index('idx_orders_buyer').on(table.buyerDid),
  stripeIdx: index('idx_orders_stripe_session').on(table.stripeSessionId),
}));

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
```

### 1.2 Add `orderId` FK to `tickets` table

Add to existing tickets table definition:
```ts
orderId: text('order_id').references(() => orders.id),
```

### 1.3 Export from `apps/events/src/db/index.ts`

Add `orders` to the exports.

### 1.4 Migration: `apps/events/drizzle/0004_add-orders.sql`

```sql
-- Create orders table
CREATE TABLE IF NOT EXISTS events.orders (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events.events(id),
  buyer_did TEXT,
  ticket_type_id TEXT NOT NULL REFERENCES events.ticket_types(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  amount_total INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  payment_method TEXT,
  stripe_session_id TEXT,
  payment_id TEXT,
  fair_settlement JSONB,
  purchased_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_event ON events.orders(event_id);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON events.orders(buyer_did);
CREATE INDEX IF NOT EXISTS idx_orders_stripe_session ON events.orders(stripe_session_id);

-- Add order_id to tickets
ALTER TABLE events.tickets ADD COLUMN IF NOT EXISTS order_id TEXT REFERENCES events.orders(id);
CREATE INDEX IF NOT EXISTS idx_tickets_order ON events.tickets(order_id);
```

### 1.5 Journal entry

Add to `apps/events/drizzle/meta/_journal.json` entries array:
```json
{
  "idx": 4,
  "version": "7",
  "when": 1744588800000,
  "tag": "0004_add-orders",
  "breakpoints": true
}
```

Also create snapshot file `apps/events/drizzle/meta/0004_snapshot.json` — copy `0003_snapshot.json` and add the new table + column.

**DO NOT remove or modify existing columns on tickets yet.** The old fields stay for backward compat — we populate both during the transition.

---

## WO2 — Webhook: Create Order + Attach Tickets

Modify `apps/events/app/api/webhook/payment/route.ts`:

### 2.1 In `handleCheckoutCompleted()`, BEFORE the ticket creation loop:

```ts
import { orders } from '@/src/db';

// Create order record
const orderId = `ord_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;

const [order] = await db.insert(orders).values({
  id: orderId,
  eventId: event.id,
  buyerDid: ownerDid,
  ticketTypeId: ticketType.id,
  quantity,
  amountTotal: amountTotal,  // cents from Stripe
  currency: currency.toUpperCase(),
  paymentMethod: paymentId ? 'stripe' : 'etransfer',
  stripeSessionId: sessionId,
  paymentId: paymentId || null,
  purchasedAt: new Date(),
  metadata: {
    purchaseEmail: customerEmail,
    customerName: customerName || null,
  },
}).returning();
```

### 2.2 In the ticket creation loop, add `orderId`:

Add `orderId: orderId,` to the `db.insert(tickets).values({...})` call.

### 2.3 Update idempotency check

Change the existing idempotency check to look at orders table:
```ts
const existingOrders = await db
  .select({ id: orders.id })
  .from(orders)
  .where(eq(orders.stripeSessionId, sessionId))
  .limit(1);

if (existingOrders.length > 0) {
  log.info({ sessionId }, 'Duplicate webhook — order already exists for session');
  return;
}
```

### 2.4 Pass `orderId` to `settleTicketPurchase()`

Add `orderId` to the params:
```ts
await settleTicketPurchase({
  orderId,          // NEW
  eventId: event.id,
  eventDid: event.did,
  buyerDid: ownerDid,
  amount: amountTotal,
  currency,
  fairManifest: eventMetadata.fair || null,
  metadata: {
    ticketId: createdTickets[0].id,
    ticketTypeId: ticketType.id,
    stripeSessionId: sessionId,
  },
});
```

---

## WO3 — Settlement: Fee-Adjusted Seller Share + Order Receipt

Modify `apps/events/src/lib/settle.ts`:

### 3.1 Update the interface

```ts
interface SettleTicketPurchaseParams {
  orderId: string;    // NEW
  eventId: string;
  eventDid: string;
  buyerDid: string;
  amount: number;
  currency: string;
  fairManifest: FairManifest | null;
  metadata: {
    ticketId: string;
    ticketTypeId: string;
    stripeSessionId: string;
  };
}
```

### 3.2 Fix seller share calculation

Currently the chain is built as: `totalDollars * entry.share` for every entry including seller.

The seller's actual payout from Stripe is: `totalAmount - applicationFee`. The applicationFee = platformShares + processingFee. So the seller gets less than `totalDollars * sellerShare`.

**Replace the chain building logic** to subtract estimated processing fees from the seller's share:

```ts
// Calculate estimated processing fee
const fees = fairManifest?.fees || [];
const processorFee = fees.find(f => f.role === 'processor');
const estimatedFeeDollars = processorFee
  ? parseFloat(((amount * processorFee.rateBps / 10000 + processorFee.fixedCents) / 100).toFixed(2))
  : parseFloat(((amount * 370 / 10000 + 30) / 100).toFixed(2));  // fallback: 3.7% + 30¢

const resolvedChain = chain.map((entry) => {
  let did = entry.did;
  if (did === 'BUYER_PLACEHOLDER') did = buyerDid;
  if (did === 'NODE_PLACEHOLDER') did = NODE_DID || 'did:imajin:node-unresolved';

  let entryAmount = parseFloat((totalDollars * entry.share).toFixed(2));

  // Deduct processing fee from seller's share — they receive (total - applicationFee) from Stripe
  if (entry.role === 'seller' || entry.role === 'creator' || entry.role === 'event') {
    entryAmount = parseFloat((entryAmount - estimatedFeeDollars).toFixed(2));
  }

  return { did, amount: entryAmount, role: entry.role };
});

// Fix rounding drift: adjust seller so chain sums correctly
// Chain total should = totalDollars - estimatedFeeDollars (the Stripe fee is external)
const expectedTotal = parseFloat((totalDollars - estimatedFeeDollars).toFixed(2));
```

**IMPORTANT:** The `total_amount` sent to `/api/settle` must also be adjusted. Currently it sends `totalDollars` but the chain now sums to `totalDollars - fees`. Update the settle call body:

```ts
const body = {
  from_did: buyerDid,
  total_amount: expectedTotal,    // adjusted for fees
  // ... rest same
};
```

### 3.3 Save settlement to ORDER instead of ticket

Replace the ticket metadata update with an order update:

```ts
import { orders } from '@/src/db';

// ... after settlement succeeds:
const resolvedFees = (fairManifest.fees || []).map((fee) => ({
  role: fee.role,
  name: fee.name,
  rateBps: fee.rateBps,
  fixedCents: fee.fixedCents,
  amount: parseFloat(((amount * fee.rateBps / 10000 + fee.fixedCents) / 100).toFixed(2)),
  estimated: true,
}));

const fairSettlement = {
  version: fairManifest.version || fairManifest.fair || '1.0',
  settledAt: new Date().toISOString(),
  totalAmount: totalDollars,
  netAmount: expectedTotal,  // NEW: after fees
  currency: params.currency,
  fees: resolvedFees,
  chain: resolvedChain,
};

await db.update(orders)
  .set({ fairSettlement })
  .where(eq(orders.id, params.orderId));
```

Remove the old `db.update(tickets)` that saved `fair_settlement` to ticket metadata.

---

## WO4 — UI: Group Tickets by Order

### 4.1 Update `getUserTickets()` in `apps/events/app/[eventId]/page.tsx`

Rename to `getUserOrders()`. Query orders + their tickets:

```ts
import { orders } from '@/src/db';

async function getUserOrders(eventId: string, userDid: string) {
  // Get orders for this user + event
  const userOrders = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.eventId, eventId),
        eq(orders.buyerDid, userDid)
      )
    );

  // Get all tickets for these orders
  return Promise.all(userOrders.map(async (order) => {
    const orderTickets = await db
      .select({
        ticket: tickets,
        ticketType: ticketTypes,
      })
      .from(tickets)
      .leftJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
      .where(eq(tickets.orderId, order.id));

    const ticketsWithQr = await Promise.all(orderTickets.map(async ({ ticket, ticketType }) => {
      const qrCodeDataUri = ticket.registrationStatus !== 'pending'
        ? (await generateQRCode(ticket.id) || undefined)
        : undefined;

      return {
        id: ticket.id,
        status: ticket.status,
        usedAt: ticket.usedAt?.toISOString() || null,
        registrationStatus: ticket.registrationStatus || 'not_required',
        qrCodeDataUri,
        ticketType: ticketType ? {
          name: ticketType.name,
          description: ticketType.description,
          perks: ticketType.perks,
          registrationFormId: ticketType.registrationFormId,
        } : null,
      };
    }));

    return {
      id: order.id,
      quantity: order.quantity,
      amountTotal: order.amountTotal,
      currency: order.currency,
      purchasedAt: order.purchasedAt?.toISOString() || order.createdAt?.toISOString() || null,
      paymentMethod: order.paymentMethod,
      fairSettlement: order.fairSettlement as any,
      tickets: ticketsWithQr,
      ticketTypeName: ticketsWithQr[0]?.ticketType?.name || 'Ticket',
    };
  }));
}
```

**Backward compat:** Also fetch any tickets WITHOUT an `orderId` (pre-migration tickets) and synthesize virtual orders from them so old purchases still display.

```ts
// Legacy: tickets without orders
const legacyTickets = await db
  .select({ ticket: tickets, ticketType: ticketTypes })
  .from(tickets)
  .leftJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
  .where(
    and(
      eq(tickets.eventId, eventId),
      eq(tickets.ownerDid, userDid),
      sql`${tickets.orderId} IS NULL`
    )
  );

// ... map each legacy ticket to a synthetic order with 1 ticket
```

### 4.2 Update `TicketsSection` props

Change `userTickets` to `userOrders` — array of order objects, each containing a `tickets` array.

### 4.3 Update `MyTicketsTab`

Render per order:

```tsx
function MyTicketsTab({ userOrders, eventId }) {
  return (
    <div className="space-y-6">
      {userOrders.map((order) => (
        <OrderCard key={order.id} order={order} eventId={eventId} />
      ))}
    </div>
  );
}
```

### 4.4 New `OrderCard` component

- Header: "{quantity}× {ticketTypeName}" + purchase date + total price
- Grid of QR codes (one per ticket) — keep them compact, maybe 2-3 per row
- Each QR shows ticket ID + status badge (valid/used/pending)
- ONE `.fair` settlement receipt at the bottom (from `order.fairSettlement`)
- Reuse `TicketFairReceipt` but update it to show `netAmount` (new field) as the organizer total

### 4.5 Update `TicketFairReceipt`

- Show `settlement.netAmount` if present (post-fee organizer total)
- The "Total" line should still show `settlement.totalAmount` (what the buyer paid)
- Add a line: "Processing fees: ~$X.XX" between chain and total
- The organizer/seller line should show the net amount (after fee deduction)

---

## Verification

After all WOs complete:

1. **Buy 1 ticket** — creates 1 order with 1 ticket, settlement receipt on order
2. **Buy 3 tickets** — creates 1 order with 3 tickets, 3 QR codes, 1 receipt
3. **Receipt math:** Organizer total = sale price × seller share − processing fees
4. **Legacy tickets** (no orderId) still display correctly
5. **Idempotency:** duplicate webhook doesn't create duplicate orders
6. **Free RSVP + e-transfer** paths still work (they don't go through this flow but verify no regression)

---

## Files Changed (expected)

- `apps/events/src/db/schema.ts` — orders table + orderId on tickets
- `apps/events/src/db/index.ts` — export orders
- `apps/events/drizzle/0004_add-orders.sql` — migration
- `apps/events/drizzle/meta/_journal.json` — journal entry
- `apps/events/drizzle/meta/0004_snapshot.json` — snapshot
- `apps/events/app/api/webhook/payment/route.ts` — create order, attach tickets
- `apps/events/src/lib/settle.ts` — fee-adjusted settlement, save to order
- `apps/events/app/[eventId]/page.tsx` — getUserOrders() replacing getUserTickets()
- `apps/events/app/[eventId]/tickets-section.tsx` — order-grouped UI, updated receipt
