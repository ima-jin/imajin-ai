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

