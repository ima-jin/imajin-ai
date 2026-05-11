# Audit: .fair HTTP 402 Native Settlement + Multi-Scheme Wire Support (#883)

## Current State of Asset Serve Path (`apps/kernel/app/media/api/assets/[id]/route.ts`)

### Access Control Logic
The existing route handler performs access control in this order:

1. **DB lookup** — fetch asset by `id`, check `status === "active"`
2. **Manifest resolution** — prefer inline `asset.fairManifest` (jsonb), fallback to `asset.fairPath` on disk
3. **Access type extraction** — `public` | `private` | `trust-graph` | `conversation`
4. **Auth gate** (if not public):
   - Calls `requireAuth(request)` from `@imajin/auth`
   - For `private`: only `ownerDid` may access
   - For `trust-graph`: owner or `allowedDids` list
   - Returns `403` if any check fails
5. **Byte serving** — with Range support for video, ETag, cache headers, thumbnail resize via sharp, variant serving

### X-Fair-Access Header
The route sets `X-Fair-Access: <accessType>` on every response. This is informational only — the actual enforcement happens before byte serving.

### What's Missing
- No price-aware access control
- No settlement scheme negotiation
- No receipt verification
- No payment-required (402) response path
- No per-action differentiation (`reproduction` vs `streaming`)

---

## What `apps/kernel/src/lib/pay/` Provides

The payment infrastructure lives inside `apps/kernel` (not a standalone `apps/pay/` app).

### Key Components
- **`PaymentService`** (`service.ts`) — unified facade routing to Stripe or Solana
- **`StripeProvider`** (`providers/stripe.ts`) — implements:
  - `charge()` — PaymentIntent creation
  - `checkout()` — hosted Checkout session creation (returns `url`)
  - `escrow()` — manual capture PaymentIntent
  - `refund()`, `createSubscription()`, etc.
- **`types.ts`** — `CheckoutRequest`, `CheckoutResult`, `CheckoutItem`, etc.

### What We Need for Stripe Link Creation
The existing `checkout()` method on `StripeProvider` creates a **Stripe Checkout session** (not a Payment Link). The spec says "Stripe Link" but the provider's `checkout()` returns a redirect URL for a hosted checkout session, which is the correct Stripe primitive for one-time payments.

We will use `PaymentService.checkout()` with:
- `items: [{ name, amount, quantity: 1 }]`
- `currency`
- `metadata` containing splits JSON + settlementId
- `successUrl` / `cancelUrl` from caller's `returnUrl`

### Auth / API Key
- `STRIPE_SECRET_KEY` env var configured on kernel
- `PAY_SERVICE_API_KEY` exists but is for internal API calls between services

---

## Decision: Receipt Format

**JWT signed by the node key (EdDSA / Ed25519)**

Rationale:
- `jose` is already a dependency of `@imajin/auth` and the kernel
- Ed25519 signing keys are already in use (`AUTH_PRIVATE_KEY` hex → PKCS8)
- JWT is compact, URL-safe, and has standard `iss`, `aud`, `exp` claims
- No new crypto dependencies needed

### Receipt JWT Claims
```
iss: "node"                          // issuer
aud: "asset:{assetId}"               // audience = asset
sub: "{settlementId}"                // subject = settlement record
action: "reproduction" | "streaming" | "derivative" | "syndication"
amount: number                        // minor units
currency: string                      // ISO 4217 or MJNX
exp: number                           // Unix timestamp
iat: number                           // issued at
manifestDigest: "sha256:..."          // manifest hash at settle time
```

### Key Source
`process.env.AUTH_PRIVATE_KEY` (hex) → imported as EdDSA signing key via `jose.importPKCS8`, identical to the existing session JWT flow in `apps/kernel/src/lib/auth/jwt.ts`.

---

## Schema Additions

### `media.settlements`

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | `stl_<nanoid>` |
| `asset_id` | text not null | FK to assets |
| `action` | text not null | reproduction / streaming / derivative / syndication |
| `buyer_did` | text nullable | anonymous allowed |
| `amount` | integer not null | minor units |
| `currency` | text not null | ISO 4217 or MJNX |
| `scheme` | text not null | x402 / stripe-link / mjnx-direct / solana-pay / lightning |
| `receipt_token` | text not null | signed JWT |
| `external_receipt_id` | text nullable | Stripe charge id, etc. |
| `fair_manifest_digest` | text not null | sha256: of manifest at settle time |
| `dfos_event_id` | text nullable | if publishContentEvent succeeded |
| `settled_at` | timestamp default now() | |

Indexes: `asset_id`, `buyer_did`, `dfos_event_id`, `settled_at`

### `media.access_log`

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | `acc_<nanoid>` |
| `asset_id` | text not null | |
| `action` | text not null | |
| `settlement_id` | text nullable | null = free access |
| `buyer_did` | text nullable | |
| `ip` | text nullable | store hashed if privacy-sensitive |
| `user_agent` | text nullable | |
| `at` | timestamp default now() | |

Indexes: `asset_id`, `buyer_did`, `at`

---

## Convention vs Override for `/settle` URL

**Convention path:** `POST /media/api/assets/{id}/settle`

This matches the existing Next.js App Router structure:
- `apps/kernel/app/media/api/assets/[id]/route.ts` — GET (serve bytes)
- `apps/kernel/app/media/api/assets/[id]/fair/route.ts` — GET/PUT (manifest)
- `apps/kernel/app/media/api/assets/[id]/settle/route.ts` — POST (new)
- `apps/kernel/app/media/api/assets/[id]/settle/confirm/route.ts` — POST (webhook)
- `apps/kernel/app/media/api/assets/[id]/receipts/route.ts` — GET (new, audit trail)

The manifest-level override `manifest.settlement?.endpoint` takes precedence if present.

---

## Dependencies

- #896 — `Money`, `DidShareList`, `FairManifestV1_1` with per-action `price` + `splits` ✅ (on base branch)
- #897 — `publishContentEvent()` from `@imajin/dfos` — will feature-detect, guard with try/catch

## Next Sequential Migration Number

Current highest: `0021_orders_buyer_email.sql` → next is `0022`
