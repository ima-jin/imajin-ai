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

---

