## STATUS: RESOLVED
**Resolved:** 2026-03-13
**Evidence:** Ryan's Identity & Attestation Hardening Roadmap — Phase 0 issue #318 ("Session route hardening")
**Outcome:** BUG-4 (silent catch block) is addressed alongside BUG-1 in issue #318. Both are Phase 0 items. The fix (adding `console.error('[session] Failed to fetch profile tier:', err)`) is adopted as stated.
**Implementation:** Roadmap commitment — issue created (#318), not yet in code. Check the catch block in `apps/auth/app/api/session/route.ts` for a logging call as confirmation.

---

## BUG-4 — Silent Exception Suppression in Session Route

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

The catch block that guards the profile tier query discards the exception entirely — no logging, no metric, no signal. When the profile service is unavailable or the query fails, the auth service has no way to detect or alert on this failure. Combined with BUG-1 (fail-open default), this means:

1. The profile service can fail silently
2. The auth service silently grants full access to all users (`|| 'hard'`)
3. No alarm fires
4. This could persist indefinitely in production without operator awareness

Even after BUG-1 is fixed (fail-default changed to `'soft'`), the silent catch block remains an observability problem. A persistent profile service outage would silently degrade all users to minimal access without any alerting.

### The Fix

At minimum, log the error:

```typescript
} catch (err) {
  console.error('[session] Failed to fetch profile tier:', err);
  // Profile schema may not be available — fail-closed (soft access)
}
```

Ideally, emit a metric or structured log event that can trigger an alert in production monitoring.

### Relationship to BUG-1 and BUG-2

BUG-1 (fail-open default) is the security risk. BUG-4 (silent exception) is the observability risk. They are independent fixes — BUG-4 should be fixed alongside BUG-1 regardless of whether BUG-2 (service migration) is undertaken.

### How to Detect Resolution in the Repo

- Commit touching the catch block in `apps/auth/app/api/session/route.ts`
- The catch block contains a logging call (`console.error`, structured logger, or equivalent)

---

