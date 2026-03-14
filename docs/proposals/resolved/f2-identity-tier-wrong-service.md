## STATUS: RESOLVED
**Resolved:** 2026-03-13
**Evidence:** Ryan's Identity & Attestation Hardening Roadmap — Phase 0, issue #319 ("auth.identities tier column migration")
**Outcome:** Issue #319 commits to adding `tier` to `auth.identities`, migrating from `profile.profiles.identity_tier`, and removing the `SELECT identity_tier FROM profile.profiles` cross-schema query from the session route. This is precisely what this concern requested. The fail-open default (P1) is also addressed in Phase 0 (#318). The partial mitigation noted from PR #307 (`requireHardDID()`) is now superseded by the proper fix.
**Implementation:** Issue #319 created — not yet in code. Confirm by checking for migration adding `tier` to `auth.identities`.

---

### F2. Identity Tier is Stored Cross-Service, Not in Auth

**Flagged:** March 10, 2026
**Affects:** Progressive Trust Model, any permission check across the platform

The `soft`/`hard` DID tier — the most fundamental identity property after the DID itself — is stored in `profile.profiles.identity_tier`, not in `auth.identities`. The session API (`apps/auth/app/api/session/route.ts`) queries the profile service's Postgres schema to resolve tier:

```ts
const profileRows = await db.execute(
  sql`SELECT identity_tier FROM profile.profiles WHERE did = ${session.sub} LIMIT 1`
);
```

If the profile service is unavailable, tier defaults to `'hard'` — full access — rather than minimal access. This is a fail-open security posture for an identity-critical property.

The Progressive Trust Model proposes adding a third tier (`preliminary`/`established`) as a standing level. If tier continues to live in the profile service, permission checks will remain scattered and the fail-open behaviour will extend to the new tiers.

**Resolution requires:** A position on where standing/tier should canonically live. Options: move to `auth.identities` (single source of truth, correct fail-closed default), or formalize the profile service as the authoritative tier store with explicit service-dependency guarantees and a fail-closed default.

**Partial mitigation (2026-03-13):** PR #307 — "fix: Service consistency — CORS + auth unification (#242)" — refactored `packages/auth` to export `requireHardDID()`, which explicitly gates routes against soft-tier identities at the handler level (`packages/auth/src/require-hard-did.ts`). This adds enforcement at the point of use but does not resolve the underlying storage problem: the cross-schema query `SELECT identity_tier FROM profile.profiles` is still in `apps/auth/app/api/session/route.ts` line 50, and the fail-open default (`session.tier || 'hard'`) is unchanged. P1 remains open. The core concern — tier data in the wrong service — is unresolved.

---

