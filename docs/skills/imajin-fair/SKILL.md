---
name: imajin-fair
description: "Work with the .fair attribution and settlement system. Use when: building fee manifests, settlement flows, FairAccordion UI, transaction attribution, fee model changes, MJNx reconciliation, or anything involving who-gets-paid-what. Triggers on: .fair, fair manifest, settlement, attribution, fee split, FairAccordion, buildFairManifest, settle, processing fees, MJNx, reconciliation."
metadata:
  openclaw:
    emoji: "⚖️"
---

# .fair — Attribution & Settlement

## What .fair Is

.fair is Imajin's attribution and settlement system. Every financial transaction on the network includes a .fair manifest — a permanent, auditable record of who gets paid what. It covers:

1. **Fee manifests** — created at content time (event, listing, etc.), defines the revenue split
2. **Settlement** — executed after payment, resolves placeholder DIDs, deducts processing fees, calls pay service
3. **Settlement receipts** — snapshot of resolved chain stored on the order/listing for display

## Package: `@imajin/fair`

Location: `packages/fair/src/`

### Exports

```typescript
// Types
FairEntry, FairFee, FairTransfer, FairAccess, FairIntegrity, FairIntent, FairManifest, FairSignature

// Building
buildFairManifest(params)  // Build a fee manifest with the 4-way split
createManifest(opts)       // Create a basic manifest (media/content)

// Validation
validateManifest(manifest) // Returns { valid, errors[] }
isValidManifest(manifest)  // Type guard

// Signing
signManifest(manifest, privateKeyHex, signerDid)
verifyManifest(manifest, resolvePublicKey)
platformSign(manifest, platformPrivateKeyHex, platformDid)
verifyPlatformSignature(manifest, resolvePublicKey)
canonicalizeForSigning(manifest)

// UI
FairAccordion   // Expandable attribution display (client component)
FairEditor      // Manifest editor (client component)

// Constants
PROTOCOL_FEE_BPS, PROTOCOL_DID, NODE_FEE_*, BUYER_CREDIT_*, STRIPE_*
```

## Fee Model (v4 — Current)

Four-layer split encoded in every .fair manifest:

| Layer | Default BPS | Default % | Recipient | Configurable? |
|-------|-------------|-----------|-----------|---------------|
| Protocol (MJN) | 100 | 1.0% | `PROTOCOL_DID` | No — governance-controlled |
| Node operator | 50 | 0.5% | `NODE_PLACEHOLDER` → resolved at settlement | Yes — 0.25%–2% range |
| Buyer credit | 25 | 0.25% | `BUYER_PLACEHOLDER` → resolved at settlement | Yes — 0.25%–2% range |
| Scope fee | 25 | 0.25% | Scope DID (community/business) | Yes — 0% to whatever |
| **Seller** | remainder | **98.25%** | Creator DID | Gets whatever's left |
| **Total platform** | 200 | **2%** | | |

Processing fees (Stripe) are **separate** from the platform split:
- Stripe domestic: 2.9% + 30¢
- Stripe international: +0.8%
- Stripe currency conversion: +2%
- Estimated at checkout using international rate (3.7% + 30¢) as safe estimate
- Actual fee fetched from `balance_transaction` API after payment
- Variance reconciled via MJNx credits/debits to seller

### Constants (`packages/fair/src/constants.ts`)

```typescript
PROTOCOL_FEE_BPS = 100      // 1.0% — fixed
PROTOCOL_DID = "did:imajin:c6e6c109..."
STRIPE_RATE_BPS = 370        // 3.7% estimate (international)
STRIPE_MIN_RATE_BPS = 290    // 2.9% (domestic)
STRIPE_FIXED_CENTS = 30      // $0.30
NODE_FEE_DEFAULT_BPS = 50    // 0.5%
BUYER_CREDIT_DEFAULT_BPS = 25 // 0.25%
```

## Building a Fee Manifest

Use `buildFairManifest` when creating content that will have financial transactions:

```typescript
import { buildFairManifest } from '@imajin/fair';

const manifest = buildFairManifest({
  creatorDid: 'did:imajin:seller...',
  contentDid: 'evt_abc123',
  contentType: 'event',         // or 'listing', 'tip', etc.
  scopeDid: null,               // community DID if inside a scope
  scopeFeeBps: null,            // from profile.forest_config
  nodeFeeBps: 50,               // from relay.relay_config
  buyerCreditBps: 25,           // from relay.relay_config
  nodeOperatorDid: 'did:...',   // from relay.relay_config
});
```

**Loading node config (common pattern across all services):**

```typescript
const rawSql = getClient();
const [relayRow] = await rawSql`
  SELECT node_fee_bps, buyer_credit_bps, node_operator_did
  FROM relay.relay_config WHERE id = 'singleton' LIMIT 1
`;
// If inside a scope (acting-as a group identity):
const [forestRow] = await rawSql`
  SELECT scope_fee_bps FROM profile.forest_config
  WHERE group_did = ${scopeDid} LIMIT 1
`;
```

### Placeholder DIDs

Manifests use placeholders that get resolved at settlement time:
- `NODE_PLACEHOLDER` → `process.env.NODE_DID` or node operator DID
- `BUYER_PLACEHOLDER` → buyer's DID from the checkout/payment

The `FairAccordion` UI component also resolves these for display:
- `NODE_PLACEHOLDER` → `nodeDid` prop
- `BUYER_PLACEHOLDER` → `viewerDid` prop

## Settlement Flow

Settlement happens AFTER payment succeeds (Stripe webhook or e-Transfer confirmation). It is **non-fatal** — settlement failure never blocks ticket/purchase creation.

### Where settlement lives

| Service | Settle function | Stores receipt on |
|---------|----------------|-------------------|
| Events | `apps/events/src/lib/settle.ts` | `events.orders.fair_settlement` (JSONB) |
| Market | `apps/market/src/lib/settle.ts` | `market.listings.metadata.fairSettlement` (JSONB) |
| Coffee | `apps/coffee/src/lib/settle.ts` | TBD |

### Settlement steps (same pattern in all services)

```
1. Read the .fair manifest from the content (event/listing)
2. If no manifest or no chain → skip, log warning
3. Resolve placeholder DIDs (BUYER_PLACEHOLDER, NODE_PLACEHOLDER)
4. Calculate estimated processing fee from fees[] array
5. Deduct processing fee from seller's share (seller gets netAmount)
6. Fix rounding drift (adjust seller so chain sums to expectedTotal)
7. POST to ${PAY_SERVICE_URL}/api/settle with resolved chain
8. Snapshot the resolved receipt onto the content (order/listing)
```

### Settle request body

```typescript
{
  from_did: buyerDid,
  total_amount: expectedTotal,    // totalDollars - estimatedFeeDollars
  service: 'events',              // or 'market', 'coffee'
  type: 'ticket_purchase',        // or 'listing_purchase', 'tip'
  funded: true,                   // Stripe-funded = true
  funded_provider: 'stripe',
  fair_manifest: { chain: resolvedChain },
  metadata: { orderId, ticketIds, stripeSessionId, eventId }
}
```

### Settlement receipt (stored on order/listing)

```typescript
{
  version: '0.4.0',
  settledAt: '2026-04-15T...',
  totalAmount: 50.00,
  netAmount: 47.15,               // after processing fee deduction
  currency: 'CAD',
  fees: [{ role: 'processor', name: 'Stripe', rateBps: 370, fixedCents: 30, amount: 2.15, estimated: true }],
  chain: [
    { did: 'did:imajin:protocol...', amount: 0.50, role: 'protocol' },
    { did: 'did:imajin:node...', amount: 0.25, role: 'node' },
    { did: 'did:imajin:buyer...', amount: 0.125, role: 'buyer_credit' },
    { did: 'did:imajin:seller...', amount: 47.15, role: 'seller' },
  ]
}
```

## MJNx Reconciliation

Processing fee variance (estimated vs actual) is reconciled via MJNx:
- **Over-collected** (estimated > actual) → `processor_rebate` credited as MJNx to seller
- **Under-collected** (estimated < actual) → `processor_surcharge` debited from seller MJNx
- This organically seeds MJNx into seller balances — "the on-ramp without an on-ramp"

Actual fee is fetched from Stripe's `balance_transaction` API in the webhook.

## UI Components

### FairAccordion

Expandable component showing attribution split. Used on:
- Event pages (buyer view) — `apps/events/app/[eventId]/page.tsx`
- Listing detail pages — `apps/market/app/listings/[id]/ListingDetail.tsx`

```tsx
import { FairAccordion } from '@imajin/fair';

<FairAccordion
  manifest={manifest}
  nodeDid={process.env.NODE_DID}       // resolves NODE_PLACEHOLDER
  viewerDid={session?.id}               // resolves BUYER_PLACEHOLDER
  viewerHandle={session?.handle}         // display handle for viewer
  resolveProfile={resolveProfile}        // optional: resolve DIDs to names
/>
```

### TicketFairReceipt (events-specific)

Compact settlement receipt for buyer's ticket view. Defined in `apps/events/app/[eventId]/tickets-section.tsx`. Shows resolved chain with dollar amounts, fees, total paid, organizer net.

### GuestFairReceipt (events admin)

Inline expandable receipt on the admin guest list. Defined in `apps/events/app/admin/[eventId]/guest-list.tsx`. ⚖️ button in Price column toggles expansion row.

## Key Patterns

### Seller roles
The settlement code treats these roles as "seller" (processing fees deducted from their share):
```typescript
const SELLER_ROLES = new Set(['seller', 'creator', 'event']);
```

### Role labels (UI)
```typescript
const ROLE_LABELS = {
  buyer_credit: 'Buyer credit',   // or 'Your credit' in buyer view
  node: 'Node',
  platform: 'Protocol (MJN)',
  seller: 'Organizer',            // or 'Seller' in market context
  creator: 'Creator',
};
```

### Color coding (UI)
- 🟠 Orange — seller/creator
- 🔵 Blue — protocol
- 🟢 Green — buyer credit
- ⚫ Gray — fees, node

### DID truncation
```typescript
// In receipts: first 10 + '…' + last 6
did.slice(0, 10) + '…' + did.slice(-6)

// In FairAccordion: first 12 + '…' + last 8
did.slice(0, 12) + '…' + did.slice(-8)
```

## Files Reference

| File | Purpose |
|------|---------|
| `packages/fair/src/types.ts` | All .fair types |
| `packages/fair/src/constants.ts` | Fee constants and bounds |
| `packages/fair/src/buildManifest.ts` | `buildFairManifest()` — 4-way fee split builder |
| `packages/fair/src/create.ts` | `createManifest()` — basic manifest for media/content |
| `packages/fair/src/validate.ts` | `validateManifest()` — structure validation |
| `packages/fair/src/sign.ts` | Ed25519 signing/verification |
| `packages/fair/src/canonical.ts` | Deterministic JSON canonicalization for signing |
| `packages/fair/src/components/FairAccordion.tsx` | Attribution display UI |
| `packages/fair/src/components/FairEditor.tsx` | Manifest editor UI |
| `apps/events/src/lib/settle.ts` | Events settlement |
| `apps/market/src/lib/settle.ts` | Market settlement |
| `apps/kernel/app/pay/api/settle/route.ts` | Pay service settle endpoint |
| `apps/kernel/app/pay/api/webhook/route.ts` | Stripe webhook (fetches actual fee) |
| `apps/kernel/src/lib/media/fair.ts` | Media asset .fair (older v0.2.0 format) |

## Lessons Learned

- **Stripe processing fees come out of application_fee.** The platform's `application_fee_amount` must cover BOTH platform margin AND Stripe's processing fee. Otherwise the platform loses money.
- **Stripe fees are variable by card type.** Estimate high (international rate), reconcile after with `balance_transaction` API.
- **Two .fair versions coexist.** Media uses v0.2.0 (simple creator attribution). Events/market use v0.3.0+/v0.4.0 (full fee cascade with `chain[]` and `fees[]`). The `FairManifest` type has both `attribution` and `chain` fields for backward compat.
- **`funded: true` means Stripe-funded.** The settle route must skip balance credits for seller/creator roles when funded — Stripe pays them directly via Connect.
