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

