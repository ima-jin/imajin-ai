# Problems
*Concrete code-level bugs and misplacements found in the upstream repo*
*Last reviewed: April 3, 2026 (upstream HEAD: 3bc931be)*
*P1–P5 resolved (March 15–23). P8 resolved March 30 — events settlement wiring live.*
*P6, P7 added March 27 — extracted from active proposals P24 and P22. Both are missing schema fields, not regressions.*
*P9 still open — .fair templates exist but not used in upload paths.*
*New: `institution.verified` attestation disabled (e8a28a1e) — event DIDs lack keypairs. Tracked in P29, not a new problem (architectural, not a code bug).*
*Refunds system shipped (#561) — settlement entries reversed on refund (3bc931be). No new problems introduced.*

These are distinct from architectural concerns in `outstanding-concerns.md`. Each item here has a specific file, a specific line, and a specific fix. When the upstream repo shows the fix has landed, the item moves to `resolved-problems.md`.

---

## P1 — Fail-Open Identity Tier Default ✅ RESOLVED 2026-03-15

**Resolved:** `|| 'soft'` default confirmed in upstream at `apps/auth/app/api/session/route.ts:48`. Cross-service profile tier query removed; tier now read directly from `auth.identities`. Full file: `resolved/p1-fail-open-identity-tier.md`.

**File:** `apps/auth/app/api/session/route.ts`
**Line:** 50
**Severity:** Security bug
**Detected:** March 10, 2026

### The Code

```typescript
let profileTier = session.tier || 'hard';
try {
  const profileRows = await db.execute(
    sql`SELECT identity_tier FROM profile.profiles WHERE did = ${session.sub} LIMIT 1`
  );
  const row = (profileRows as any)?.[0];
  if (row?.identity_tier) profileTier = row.identity_tier;
} catch {
  // Profile schema may not be available
}
```

### The Problem

When the profile service is unavailable or the `profile.profiles` query fails, the session route silently catches the error and returns `tier: 'hard'` — full access. The fail-default should be `'soft'` (minimal access), not `'hard'`.

This is a fail-open security posture for an identity-critical property. An authentication system that grants full access when it can't verify access level is unsafe by design.

### The Fix

One line change on line 50:

```typescript
// Before
let profileTier = session.tier || 'hard';

// After
let profileTier = session.tier || 'soft';
```

This is the minimum fix. The broader architectural issue (tier living in the profile service instead of auth) is tracked as a separate concern in `current-threads/identity-tier-storage.md`. But the fail-open default should be fixed regardless of which architectural path is chosen.

### How to Detect Resolution in the Repo

- Commit touching `apps/auth/app/api/session/route.ts`
- The string `|| 'hard'` no longer appears on line 50
- The string `|| 'soft'` (or equivalent) appears instead

---

## P2 — Identity Tier Stored in Wrong Service ✅ RESOLVED 2026-03-15

**Resolved:** `auth.identities.tier` column live (migration 0001). Session route reads tier from auth directly — cross-service profile query removed. `|| 'soft'` fail-closed default in place. Full file: `resolved/p2-identity-tier-wrong-service.md`.

**File:** `apps/auth/app/api/session/route.ts` (line 54), `apps/profile/src/db/schema.ts` (identity_tier column)
**Severity:** Architectural misplacement with security implications
**Detected:** March 10, 2026

### The Problem

The `soft`/`hard` DID tier — a fundamental access control property — is stored in `profile.profiles.identity_tier`, not in `auth.identities`. Every authentication session check crosses a service boundary to retrieve it.

Access control properties belong to the auth layer. Display properties belong to the profile layer. These are currently mixed. The cross-schema query (`SELECT identity_tier FROM profile.profiles`) inside the auth service creates a hidden service dependency that:

1. Makes the fail-open bug in P1 structurally inevitable (auth depends on profile being up)
2. Breaks the separation of concerns between identity and display
3. Creates a migration burden when the Progressive Trust Model adds a third standing tier

### The Fix

1. Add `tier TEXT NOT NULL DEFAULT 'soft'` column to `auth.identities`
2. Migrate existing values from `profile.profiles.identity_tier` to `auth.identities.tier`
3. Update `apps/auth/app/api/session/route.ts` to read from `auth.identities` directly (same service, no cross-schema query)
4. Profile service reads tier from auth for display purposes if needed
5. Remove `identity_tier` from `profile.profiles` schema once migration is confirmed

### Relationship to P1

P1 (fail-open default) is a one-line fix that should happen immediately. P2 (wrong service) is a migration that should happen before the Progressive Trust Model adds more tiers. P1 can be fixed without P2. P2 fixes P1 permanently by making the cross-service query unnecessary.

### How to Detect Resolution in the Repo

- New migration adding `tier` column to `auth.identities`
- `apps/auth/app/api/session/route.ts` no longer contains `SELECT identity_tier FROM profile.profiles`
- `apps/profile/src/db/schema.ts` removes `identity_tier` column (or it's marked deprecated)

---

## P3 — FairManifest Has No Signature Field ✅ RESOLVED 2026-03-15

**Resolved:** `signature?: FairSignature` and `platformSignature?: FairSignature` added to `FairManifest`. `signManifest()` and `verifyManifest()` live in `packages/fair/src/sign.ts` (Ed25519). Canonical serialization in `packages/fair/src/canonical.ts`. Upstream HEAD eacad35, issue #317. Full file: `resolved/p3-fair-manifest-no-signature.md`.

**File:** `packages/fair/src/types.ts`
**Severity:** Missing enforcement — protocol claim without cryptographic backing
**Detected:** March 10, 2026

### The Code

```typescript
export interface FairManifest {
  fair: string;
  id: string;
  type: string;
  owner: string;         // DID of owner — asserted, not proven
  created: string;
  attribution: FairEntry[];
  distributions?: FairEntry[];
  access: FairAccess;
  transfer?: FairTransfer;
  integrity?: FairIntegrity; // asset hash — not manifest signing
  terms?: string;
}
```

### The Problem

`FairManifest` has no `signature` field. Any service can declare `owner: "did:imajin:ryan"` without cryptographic proof that `did:imajin:ryan` authorized the manifest. The `FairIntegrity` type (`{ hash: string, size: number }`) is for asset integrity (file hash), not manifest authorization.

The MJN whitepaper v0.2 declares .fair a required protocol primitive. A protocol primitive that can be self-declared without verification is a convention, not a primitive.

For human-driven transactions this is an acceptable interim state — UI friction provides implicit consent. For Stream 3 (automated node-to-node settlement), there is no human in the loop and no implicit consent signal.

### The Fix

Add to `FairManifest`:

```typescript
signature?: {
  algorithm: 'ed25519';
  value: string;         // base58 or hex encoded signature
  publicKeyRef: string;  // DID of signing key
}
```

Add to `packages/fair/src/index.ts`:
- `sign(manifest: FairManifest, privateKey: string): SignedFairManifest`
- `verifyManifest(manifest: SignedFairManifest): boolean`

Enforce at settlement: reject manifests with missing or invalid signatures (after a migration window for legacy manifests — see Proposal 6 in `current-proposals.md` for the full migration plan).

### How to Detect Resolution in the Repo

- `packages/fair/src/types.ts` gains a `signature` field on `FairManifest`
- `packages/fair/src/index.ts` exports `sign` and `verifyManifest` functions
- Any commit touching `apps/pay/` settlement routes to add signature validation

---

## P4 — Silent Exception Suppression in Session Route ✅ RESOLVED 2026-03-15

**Resolved:** `console.error('Session error:', error)` confirmed in catch block at `apps/auth/app/api/session/route.ts:66–67`. Errors no longer silently discarded. Full file: `resolved/p4-silent-exception-suppression.md`.

**File:** `apps/auth/app/api/session/route.ts`
**Lines:** 26–28 (the catch block)
**Severity:** Observability gap
**Detected:** March 10, 2026 (surfaced in Identity Tier Storage architectural review)

### The Code

```typescript
} catch {
  // Profile schema may not be available
}
```

### The Problem

The catch block that guards the profile tier query discards the exception entirely — no logging, no metric, no signal. When the profile service is unavailable or the query fails, the auth service has no way to detect or alert on this failure. Combined with P1 (fail-open default), this means:

1. The profile service can fail silently
2. The auth service silently grants full access to all users (`|| 'hard'`)
3. No alarm fires
4. This could persist indefinitely in production without operator awareness

Even after P1 is fixed (fail-default changed to `'soft'`), the silent catch block remains an observability problem. A persistent profile service outage would silently degrade all users to minimal access without any alerting.

### The Fix

At minimum, log the error:

```typescript
} catch (err) {
  console.error('[session] Failed to fetch profile tier:', err);
  // Profile schema may not be available — fail-closed (soft access)
}
```

Ideally, emit a metric or structured log event that can trigger an alert in production monitoring.

### Relationship to P1 and P2

P1 (fail-open default) is the security risk. P4 (silent exception) is the observability risk. They are independent fixes — P4 should be fixed alongside P1 regardless of whether P2 (service migration) is undertaken.

### How to Detect Resolution in the Repo

- Commit touching the catch block in `apps/auth/app/api/session/route.ts`
- The catch block contains a logging call (`console.error`, structured logger, or equivalent)

---

## P5 — FairManifest Missing `intent` Field ✅ RESOLVED 2026-03-15

**Resolved:** `intent?: FairIntent` added to `FairManifest` in same update as P3. `FairIntent` type includes `purpose`, `directive`, `constraints`, `pool` per RFC-05. Upstream HEAD eacad35, issue #317. Full file: `resolved/p5-fair-manifest-missing-intent.md`.

**File:** `packages/fair/src/types.ts`
**Severity:** Missing field — RFC-05 extension not implemented
**Detected:** March 11, 2026 (surfaced by RFC-05 in `apps/www/articles/rfc-05-intent-bearing-transactions.md`)

### The Code

`FairManifest` in `packages/fair/src/types.ts` ends at line 41. No `intent` field exists.

### The Problem

RFC-05 (`rfc-05-intent-bearing-transactions.md:28–41`) specifies an `intent` extension to the `.fair` manifest schema:

```typescript
intent?: {
  purpose: 'infrastructure' | 'living' | 'grant' | 'sponsorship' | 'charitable';
  directive?: string;
  constraints?: string[];
  pool?: string;
}
```

Without this field, intent-bearing transactions and contribution pools (RFC-05) cannot be implemented. The field is optional (`?`) so its absence does not break existing manifests — but it must be added before Phase 1 of RFC-05 (intent declarations) can ship.

### Relationship to P3

P3 (missing `signature` field) and P5 (missing `intent` field) are both gaps on the same type in the same file. They should be fixed in a single PR to avoid two separate migrations of `FairManifest`. The combined fix adds:

```typescript
// To FairManifest in packages/fair/src/types.ts:
signature?: {
  algorithm: 'ed25519';
  value: string;
  publicKeyRef: string;
}
intent?: {
  purpose: 'infrastructure' | 'living' | 'grant' | 'sponsorship' | 'charitable';
  directive?: string;
  constraints?: string[];
  pool?: string;
}
```

### How to Detect Resolution in the Repo

- `packages/fair/src/types.ts` gains an `intent` field on `FairManifest`
- Ideally in the same commit as P3 (`signature` field)

---

## New Problems — March 27 Extraction from Active Proposals

### P6 — FairEntry Missing `contributorType` Field ⬚ OPEN

**File:** `packages/fair/src/types.ts`
**Severity:** Missing field — blocks agent attribution integrity
**Detected:** March 27, 2026 (extracted from Proposal 24)

### The Code

```typescript
export interface FairEntry {
  did: string;
  role: string;
  share: number;
  // No contributorType, no principal, no image, no economicFlow
}
```

### The Problem

`FairEntry` cannot distinguish human from agent contributions. When agent DIDs (P24, RFC-19) generate `.fair` manifests, the attribution chain has no way to identify which entries are human-authored and which are agent-generated. This also means no `principalSignature` validation can be enforced — an agent can forge attribution claims without the principal human's countersignature.

### The Fix

Add four optional fields to `FairEntry`:

```typescript
export interface FairEntry {
  did: string;
  role: string;
  share: number;
  contributorType?: 'human' | 'agent' | 'system';  // defaults to 'human' if absent
  principal?: string;      // parent DID for agent contributors
  image?: string;          // agent image/model identifier
  economicFlow?: 'direct' | 'principal' | 'pool';  // where agent earnings route
}
```

Backwards-compatible — existing manifests without the field are treated as human. Add validation in `packages/fair/src/validate.ts`: reject manifests containing agent contributors without a valid `principalSignature`.

### How to Detect Resolution in the Repo

- `packages/fair/src/types.ts` FairEntry gains `contributorType` field
- `packages/fair/src/validate.ts` checks for `principalSignature` on agent entries
- Any commit referencing "agent attribution" or "contributor type"

---

### P7 — auth.attestations Missing Schema Fields for Archaeology ⬚ OPEN

**File:** `auth.attestations` table (migration files in `apps/auth/`)
**Severity:** Missing fields — cheap now, expensive later
**Detected:** March 27, 2026 (extracted from Proposal 22)

### The Problem

The `auth.attestations` table is missing two fields required for the Identity Archaeology view (P22):

1. **`client_hint JSONB DEFAULT '{}'`** — human-readable context labels (e.g., `{event_name: "Launch Party", venue: "Studio"}`) that allow the archaeology endpoint to return meaningful summaries without exposing encrypted payload content. Without this field, the read-side must either decrypt every payload (privacy violation) or return opaque type codes (unusable UX).

2. **`category TEXT NOT NULL DEFAULT 'system'`** — five-domain grouping (`identity`, `social`, `economic`, `governance`, `system`) with index `idx_attestations_category ON auth.attestations (node_context, subject_did, category, issued_at DESC)`. Without this field, domain-scoped queries require full-table type-string matching.

### The Fix

Add both columns in the next migration:

```sql
ALTER TABLE auth.attestations ADD COLUMN client_hint JSONB DEFAULT '{}';
ALTER TABLE auth.attestations ADD COLUMN category TEXT NOT NULL DEFAULT 'system';
CREATE INDEX idx_attestations_category ON auth.attestations (node_context, subject_did, category, issued_at DESC);
```

Populate `client_hint` and `category` at write time in the attestation ingestion layer. Both are additive — no existing data changes.

### Why This Is "Cheap Now, Expensive Later"

Adding columns to an empty or small table is trivial. Adding them to a table with millions of attestation rows requires a migration, backfill, and index rebuild. The schema fields should be added before the table accumulates significant data.

### How to Detect Resolution in the Repo

- Migration in `apps/auth/` adding `client_hint` and `category` to `auth.attestations`
- Attestation write path populates both fields
- Index `idx_attestations_category` exists

---

### P8 — .fair Attribution Not Wired to Events or Transactions ✅ RESOLVED 2026-03-30

**Resolved:** `settleTicketPurchase()` in `apps/events/src/lib/settle.ts` calls `POST /api/settle` on pay service. Events payment webhook (`apps/events/app/api/webhook/payment/route.ts:352–370`) invokes settlement with `.fair` manifest on every Stripe checkout. Platform fee deducted at 3% via `PLATFORM_FEE_PERCENT`. Full file: `resolved/p8-fair-not-wired-to-events.md`.

**File:** `apps/events/` webhook handler, `apps/pay/app/api/settle/route.ts`
**Severity:** Critical for April 1 demo — issue #25 explicit blocker
**Detected:** March 27, 2026 (from GitHub issue #25 remaining work items)

---

### P9 — .fair Templates Not Used in Any Upload Path ⬚ OPEN

**File:** `packages/fair/src/templates.ts` (exists but unused)
**Severity:** Medium — attribution gap across 3+ upload paths
**Detected:** March 27, 2026 (from GitHub issue #330)

### The Problem

Issue #330 documents that `.fair` manifests are created in only 2 of 5+ upload paths, and neither uses the template system. Three upload paths create zero attribution: `apps/chat` uploads, `apps/input` uploads, and `apps/learn` content. The template system exists but nothing calls `createManifestFromTemplate()`.

### The Fix

Wire `createManifestFromTemplate()` into all upload paths: chat, input, learn, FairEditor in media and events.

### How to Detect Resolution

- All upload paths in the monorepo call `createManifestFromTemplate()`
- Issue #330 closed

---

## Notes on Scope

**What belongs here:** Specific, actionable code-level bugs — wrong defaults, missing fields, misplaced data, incorrect error handling. Items with a file, a line, and a fix.

**What belongs in `outstanding-concerns.md`:** Architectural questions, design decisions, unspecified features, calibration choices.

**What belongs in `current-threads/`:** Full context and proposals for resolving the architectural concerns.

Some problems here (P2, P3) have corresponding architectural threads (`identity-tier-storage.md`, `fair-attribution-automated-nodes.md`). The thread contains the full design context; this document tracks the specific code fix and its detection.
