---
name: imajin-identity
description: "Work with Imajin's identity system: DIDs, scopes, subtypes, tiers, stubs, claims, act-as, members, attestations, auth middleware, sessions. Use when: creating or modifying identity flows, working with authentication, building scope-aware features, handling group identities, stubs, or attestations. Triggers on: identity, DID, scope, subtype, tier, stub, claim, act-as, attestation, requireAuth, getSession, identity_members, onboard, verification."
metadata:
  openclaw:
    emoji: "🪪"
---

# Imajin Identity

## Core Concepts

### DIDs (Decentralized Identifiers)

Every identity on the network is a `did:imajin:...` backed by an Ed25519 keypair. The DID is derived from the public key. The same keypair is one derivation from a valid Solana wallet.

DIDs are also backed by DFOS chains (`did:dfos:...`). The `did:imajin` is an alias — the DFOS chain is the canonical, federated identity.

### Identity Scopes

Two fields define every identity: `scope` and `subtype`.

**Scope** = governance model (who controls this identity):

| Scope | What | Examples |
|-------|------|---------|
| `actor` | Individual person or entity | Human user, AI agent, device |
| `family` | Family unit | Birth family, chosen family |
| `community` | Self-governing group | Club, collective, neighborhood |
| `business` | Commercial entity | Cafe, incorporated company, sole proprietor |

**Subtype** = presentation (what kind of entity within that scope):

| Scope | Subtypes |
|-------|----------|
| actor | `human`, `agent`, `device` |
| family | `birth`, `chosen` |
| community | `club`, `collective` |
| business | `sole_proprietor`, `inc`, `cafe`, `restaurant`, `venue`, ... |

Scope determines governance. Subtype determines presentation. Both exist for all scopes.

### Trust Tiers

Progressive verification: `soft` → `preliminary` → `established` → `steward` → `operator`

| Tier | What | How |
|------|------|-----|
| `soft` | Email-only, unverified | Guest checkout, onboard token |
| `preliminary` | Keypair-based, basic verification | Registration with keypair |
| `established` | Fully verified (MFA, attestations) | MFA setup + attestation threshold |
| `steward` | Trusted community steward | Elevated by platform |
| `operator` | Platform operator | Node admin (acts-as NODE_DID) |

**Tier helpers** in `@imajin/auth`:
```typescript
isVerifiedTier(tier)    // preliminary+ (has keypair)
isEstablishedTier(tier) // established+ (fully verified)
isStewardTier(tier)     // steward+
isOperatorTier(tier)    // operator only
normalizeTier(tier)     // handles legacy 'hard' → 'preliminary'
```

**Never compare tiers with string equality.** Always use the helper functions. Legacy code may still have `tier === 'hard'` — `normalizeTier` handles this.

## Auth Middleware (`@imajin/auth`)

### `requireAuth(request, options?)`
Primary auth middleware. Checks session cookie first, then Bearer token. Returns `{ identity }` or `{ error, status }`.

```typescript
const authResult = await requireAuth(request);
if ('error' in authResult) {
  return NextResponse.json({ error: authResult.error }, { status: authResult.status });
}
const { identity } = authResult;
const did = identity.actingAs || identity.id;  // ← always use this pattern
```

Options:
- `verifyChain?: boolean` — also verify DFOS chain validity
- `service?: string` — validate acting-as controller has access to this service

### `getSession(options?)`
For **server components only** (not API routes). Reads from Next.js cookie store.

```typescript
const session = await getSession();
if (!session) redirect('/auth/login');
const did = session.actingAs || session.id;
```

### Other auth functions

| Function | Use for |
|----------|---------|
| `requireHardDID(request)` | Require preliminary+ tier (has keypair) |
| `requireEstablishedDID(request)` | Require established+ tier |
| `requireAdmin(request)` | Require operator tier (acting-as NODE_DID) |
| `optionalAuth(request)` | Get identity if present, null if not |

### The `actingAs` Pattern

When a user is acting on behalf of a group identity (business, community), `identity.actingAs` is set to the group DID. **Always resolve the effective DID:**

```typescript
const did = identity.actingAs || identity.id;
```

This single line appears in virtually every authenticated route. The `X-Acting-As` header or cookie is validated server-side against `identity_members` — only `owner` and `admin` roles can act-as.

Admin = acting-as `NODE_DID` (the node's own identity). `process.env.NODE_DID` must be set.

## Identity Members

Single table for ALL identity relationships: `auth.identity_members`

```sql
identity_did TEXT NOT NULL,  -- the group/business/community DID
member_did TEXT NOT NULL,    -- the person's DID
role TEXT NOT NULL,          -- 'owner' | 'admin' | 'maintainer' | 'member'
allowed_services TEXT[],     -- null = full access, ['events'] = restricted
added_by TEXT,
added_at TIMESTAMPTZ,
removed_at TIMESTAMPTZ       -- soft delete
```

**Roles:**
| Role | Can act-as? | Purpose |
|------|-------------|---------|
| `owner` | ✅ | Full control. Transferred on claim. |
| `admin` | ✅ | Delegated full control. |
| `maintainer` | ❌ | Can edit (stubs), can't act-as. |
| `member` | ❌ | Associated. Can be listed. |

## Stubs (Business Cold-Start)

A stub is an unclaimed business identity: `scope: 'business'`, no `owner` in `identity_members` — only a `maintainer`.

**How stubs work:**
1. Anyone creates a business profile (name, photos, location, subtype)
2. Creator gets `role: 'maintainer'` — can edit, add photos, but can't act-as
3. Check-ins, reviews, connections accumulate on the stub
4. Real owner claims the profile → gets `role: 'owner'` → inherits everything

**Key files:**
- Identity creation: `apps/kernel/app/auth/api/identity/create/route.ts` (or similar)
- Stub edit page: `apps/kernel/app/auth/identity/[did]/edit/`
- Public profile: `apps/kernel/app/profile/[handle]/`

## Attestations

Signed claims about identities. Bilateral when both parties sign.

```typescript
interface Attestation {
  id: string;              // att_xxx
  issuerDid: string;       // who issued it
  subjectDid: string;      // who it's about
  type: AttestationType;   // e.g. 'ticket.purchased', 'vouch.given'
  contextId?: string;      // e.g. event DID
  contextType?: string;    // e.g. 'event'
  payload?: object;
  attestationStatus: 'pending' | 'bilateral' | 'declined';
}
```

**Emit attestations (fire-and-forget):**
```typescript
import { emitAttestation } from '@imajin/auth';

emitAttestation({
  issuer_did: identity.id,
  subject_did: targetDid,
  type: 'ticket.purchased',
  context_id: eventId,
  context_type: 'event',
  payload: { amount, currency },
}).catch(err => log.error({ err: String(err) }, 'Attestation emit error'));
```

**Attestation types** (from `packages/auth/src/types/attestation.ts`):
`event.attendance`, `vouch.given`, `vouch.received`, `transaction.settled`, `connection.invited`, `connection.accepted`, `ticket.purchased`, `listing.purchased`, `tip.granted`, `identity.created`, `identity.verified.preliminary`, `handle.claimed`, `group.created`, `group.member.added`, `learn.enrolled`, `learn.completed`, etc.

## Onboarding Flows

### Keypair Registration (preliminary DID)
1. Client generates Ed25519 keypair
2. `POST /auth/api/register` with public key, handle, name
3. Server creates DID, identity chain, stored key
4. Session token issued

### Magic Link / Onboard (soft DID → preliminary)
1. `POST /auth/api/onboard/generate` creates token + sends email
2. User clicks link → `GET /auth/api/onboard/verify?token=xxx`
3. If soft DID exists: upgrade to preliminary with keypair
4. Orphaned tickets from soft DID are auto-migrated (#713)

### Guest Checkout (soft DID)
1. Checkout with just email → creates soft DID
2. Ticket/purchase attached to soft DID
3. Later onboard → migrate tickets to real DID

## DFOS Chain Integration

Package: `packages/dfos/`

```typescript
import { createIdentityChain, verifyChain, updateIdentityChain } from '@imajin/dfos';
```

- `createIdentityChain({ privateKeyHex, publicKeyHex })` — signs genesis op, returns `{ did, log, operationCID }`
- `verifyChain(log)` — verifies chain integrity
- `updateIdentityChain({ ... })` — key rotation via update op

Identity chains stored in `auth.identity_chains` table (local) and replicated to the DFOS relay network.

## Database Schema

All identity tables live in `auth` schema: `apps/kernel/src/db/schemas/auth.ts`

| Table | Purpose |
|-------|---------|
| `auth.identities` | Core identity record (DID, scope, subtype, handle, tier, keys) |
| `auth.challenges` | Login challenge-response (short-lived) |
| `auth.tokens` | Session tokens |
| `auth.credentials` | Auth methods (email, keypair) linked to DIDs |
| `auth.identity_chains` | DFOS chain log + head CID |
| `auth.stored_keys` | Client-side encrypted private keys (server holds ciphertext) |
| `auth.attestations` | Signed claims between identities |
| `auth.identity_members` | Group membership + roles |
| `auth.mfa_methods` | TOTP, passkeys, recovery codes |
| `auth.devices` | Known devices per identity |
| `auth.onboard_tokens` | Email verification tokens |

## Key Files

| File | Purpose |
|------|---------|
| `packages/auth/src/require-auth.ts` | `requireAuth()` — primary auth middleware |
| `packages/auth/src/session.ts` | `getSession()` — server component auth |
| `packages/auth/src/tiers.ts` | Tier helpers (isVerifiedTier, etc.) |
| `packages/auth/src/types.ts` | Identity, AuthResult, Keypair types |
| `packages/auth/src/types/attestation.ts` | Attestation types vocabulary |
| `packages/auth/src/sign.ts` | Ed25519 message signing |
| `packages/auth/src/verify.ts` | Message verification |
| `packages/auth/src/crypto.ts` | Low-level crypto (keypair gen, hex/bytes) |
| `packages/auth/src/credentials.ts` | `getEmailForDid`, `getDidForEmail` |
| `packages/auth/src/emit-attestation.ts` | Fire-and-forget attestation emitter |
| `packages/auth/src/resolve.ts` | DID → public key resolution |
| `packages/dfos/src/bridge.ts` | DFOS chain create/verify/update |
| `packages/dfos/src/signer.ts` | DFOS-compatible signer from hex private key |
| `apps/kernel/src/db/schemas/auth.ts` | All auth table definitions |
| `apps/kernel/app/auth/` | Auth UI + API routes |

## Common Patterns

### Check if user is the creator/owner
```typescript
const did = identity.actingAs || identity.id;
if (event.creatorDid !== did) {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}
```

### Check if user is an organizer (creator OR cohost)
```typescript
import { isEventOrganizer } from '@/src/lib/organizer';
const orgCheck = await isEventOrganizer(eventId, did);
if (!orgCheck.authorized) return forbidden();
```

### Resolve a DID to profile info
```typescript
const res = await fetch(`${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(did)}`);
const { identity } = await res.json();
// identity.name, identity.handle, identity.avatar
```

### Node DID
```typescript
const NODE_DID = process.env.NODE_DID;
// Dev: did:imajin:EhELpy7cekn3BWdjPK8jHPYpPMrajATtPeBeDnvBLYHk
// Prod: did:imajin:6Y6fwZeqe1wME3heZ2vy1cV3x9zwq4Gphqm6yKC95dBg
```

## Lessons Learned

- **Soft DID tickets get orphaned.** Guest checkout creates soft DID, onboard creates new preliminary DID. Fix: migrate-tickets endpoint called from onboard/verify (#713).
- **Never compare tiers with strings.** Use `isVerifiedTier()`, `isEstablishedTier()` etc. Legacy 'hard' tier still exists in some data.
- **`identity.actingAs || identity.id`** — this pattern appears 200+ times. Always use it. Never use `identity.id` alone for authorization checks.
- **Admin = acting-as NODE_DID.** Future: scoped admin views where any non-actor identity gets filtered access based on scope.
- **Identity members replaces old tables.** `group_controllers` + `group_identities` were dropped in favor of unified `identity_members` (#346).
- **Maintainers filtered from identity switcher.** UI only shows owner/admin in the scope switcher — maintainers can edit but never act-as.
