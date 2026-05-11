# Audit: .fair HTTP 402 Native Settlement — MJNx-Direct (#883)

> **Scope revision (post-architecture review):** This PR implements MJNx-direct settlement only.
> Stripe Link and other fiat/chain rails are tracked in **#904** as deposit on-ramps INTO MJNx,
> not parallel settlement schemes. See "Deferred to #904" section below.

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
5. **Price-aware 402 path** (if manifest has distribution pricing):
   - Missing receipt → `402` with `mjnx-direct` settlement options
   - Present receipt → JWT verification + DB lookup + replay protection
   - Access logged to `media.access_log`
6. **Byte serving** — with Range support for video, ETag, cache headers, thumbnail resize via sharp, variant serving

### X-Fair-Access Header
The route sets `X-Fair-Access: <accessType>` on every response. This is informational only — the actual enforcement happens before byte serving.

---

## Settlement Architecture

### MJNx-direct is the settlement currency

MJNx is the node's local settlement currency. Fiat rails (Stripe, etc.) are deposit rails INTO
MJNx, not parallel settlement schemes. Stripe-as-settlement is broken at micro-attribution scale:
the 30¢ flat fee makes <$2 settlements uneconomic, and Stripe Connect creates activation energy
(verified business, country gating, webhooks) that is inappropriate for a sovereign identity node.

### Settlement flow (v1)

1. **GET /media/api/assets/{id}** with a priced action → `402` with `mjnx:pay?...` deep link
2. Buyer sends MJNx payment out-of-band
3. **POST /media/api/assets/{id}/settle** — creates `settlements` row (status=pending), returns `{ settlementId, uri }`
4. **POST /media/api/assets/{id}/settle/confirm** — asset owner confirms receipt, signs JWT, updates row (status=completed)
5. Buyer presents receipt JWT in `X-Payment-Receipt` header → access granted

### Owner-mediated confirmation (temporary)
Until the MJNx ledger system (#904) is live, the asset owner mediates confirmation.
The confirm endpoint requires authentication and checks `asset.ownerDid === requesterDid`.
Full atomic debit will replace this when the balance system lands.

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
manifestDigest: "sha256:..."          // manifest hash at settle time (canonicalized)
```

### Manifest Digest
Uses `canonicalize()` from `@imajin/auth` (RFC 8785 key-ordered JSON) via Node `crypto.createHash('sha256')`.
This matches the signing convention used throughout the rest of the codebase.

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
| `scheme` | text not null | mjnx-direct (others deferred to #904) |
| `status` | text not null default 'pending' | pending \| completed |
| `receipt_token` | text not null | signed JWT |
| `external_receipt_id` | text nullable | tx hash or "mjnx-confirmed" |
| `fair_manifest_digest` | text not null | sha256: of canonicalized manifest at settle time |
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
- `apps/kernel/app/media/api/assets/[id]/route.ts` — GET (serve bytes), DELETE, PATCH
- `apps/kernel/app/media/api/assets/[id]/fair/route.ts` — GET/PUT (manifest)
- `apps/kernel/app/media/api/assets/[id]/settle/route.ts` — POST (initiate settlement)
- `apps/kernel/app/media/api/assets/[id]/settle/confirm/route.ts` — POST (owner-confirm)
- `apps/kernel/app/media/api/assets/[id]/receipts/route.ts` — GET (audit trail for owner)

The manifest-level override `manifest.settlement?.endpoint` takes precedence if present.

---

## Dependencies

- #896 — `Money`, `DidShareList`, `FairManifestV1_1` with per-action `price` + `splits` ✅ (on base branch)
- #897 — `publishContentEvent()` from `@imajin/dfos` — feature-detected, guarded with try/catch

---

## Deferred to #904

The following are out of scope for this PR and tracked in **#904** (MJNx on-ramp + balance system):

- **Stripe Link** — fiat checkout via Stripe Checkout sessions
- **x402** — HTTP 402 native payment protocol
- **Solana Pay** — on-chain SOL/USDC settlement
- **Lightning** — Bitcoin Lightning Network settlement
- **MJNx-direct chain verification** — cryptographic proof-of-payment on the MJNx ledger
- **Multi-node MJNx interop** — cross-node settlement routing
- **On-ramp flows** — buyer converting fiat → MJNx before settlement
- **Atomic node-ledger debit** — replacing owner-mediated confirmation with ledger-level atomicity
