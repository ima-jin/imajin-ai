# Problems
*Concrete code-level bugs and misplacements found in the upstream repo*
*Last reviewed: March 10, 2026 (upstream HEAD: 39331e0)*

These are distinct from architectural concerns in `outstanding-concerns.md`. Each item here has a specific file, a specific line, and a specific fix. When the upstream repo shows the fix has landed, the item moves to `resolved-problems.md`.

---

## P1 — Fail-Open Identity Tier Default

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

## P2 — Identity Tier Stored in Wrong Service

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

## P3 — FairManifest Has No Signature Field

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

## P4 — Silent Exception Suppression in Session Route

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

## P5 — FairManifest Missing `intent` Field

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

## Notes on Scope

**What belongs here:** Specific, actionable code-level bugs — wrong defaults, missing fields, misplaced data, incorrect error handling. Items with a file, a line, and a fix.

**What belongs in `outstanding-concerns.md`:** Architectural questions, design decisions, unspecified features, calibration choices.

**What belongs in `current-threads/`:** Full context and proposals for resolving the architectural concerns.

Some problems here (P2, P3) have corresponding architectural threads (`identity-tier-storage.md`, `fair-attribution-automated-nodes.md`). The thread contains the full design context; this document tracks the specific code fix and its detection.
