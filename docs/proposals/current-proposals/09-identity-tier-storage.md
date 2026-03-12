## 9. Identity Tier Storage — Security Fix and Auth Domain Consolidation

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/identity-tier-storage.md`
**Related upstream:** `apps/auth/app/api/session/route.ts`, `apps/profile/src/db/schema.ts`
**Addresses:** Problems P1 (fail-open default) and P2 (wrong service); Outstanding Concern F2

### Executive Summary

The soft/hard DID tier — the most fundamental access control property after the DID itself — is stored in the profile service, not the auth service. The auth session API crosses a service boundary to retrieve it on every permission check. If that query fails, it defaults to `'hard'` (full access) rather than minimal access. This is a fail-open security posture for an identity-critical property.

In the current single-server deployment, the risk is low. But the platform is building toward federated nodes, a three-tier Progressive Trust Model, key delegation in the Embedded Wallet, and an attestation-based standing computation layer. Each of these compounds the cost of leaving tier in the wrong place.

### 1. Three Compounding Problems in the Current Code

**In `apps/auth/app/api/session/route.ts`:**

1. **Fail-open default:** `session.tier || 'hard'` — falls back to full access, not minimal access (Problem P1)
2. **Silent exception swallow:** the catch block discards the exception without logging — no observability into profile service failures (Problem P4 — new)
3. **Wrong service boundary:** `identity_tier` is an access control property stored and owned by a display service (Problem P2)

**Why shared Postgres mitigates but does not resolve:** Both services currently point at the same Postgres instance, so the cross-schema query is a local join. But 'same Postgres' is an accident of current deployment that future infrastructure changes will invalidate.

### 2. Why This Matters Now — Converging Dependencies

**Progressive Trust Model — the third tier:** If standing is computed from `auth.attestations`, and tier is the access-control output of standing computation, then tier must live in auth — so the computation and its output are in the same service domain.

**BaggageDID — authoritative tier claims:** For the BaggageDID's tier summary to be verifiable, the originating node must sign a tier claim from the service that owns and computed that value. If tier lives in profile, the auth service is signing a claim about a value it doesn't own.

**Attestation layer:** Tier is the access-control output of standing computation. If tier remains in profile, standing computation in auth must write its result across a service boundary into a display service to take effect.

### 3. The Immediate Fix — One Line, No Migration

Change `session.tier || 'hard'` to `session.tier || 'soft'` on line 50 of `apps/auth/app/api/session/route.ts`.

A user experiencing a profile service outage will see reduced permissions rather than elevated ones. The catch block should also log the exception at minimum — silent failure is an observability gap regardless of the fail-default direction.

### 4. Longer-Term Options

**Option A — Move tier to `auth.identities` (Recommended):**
Add a `tier TEXT NOT NULL DEFAULT 'soft'` column directly to `auth.identities`. Migrate existing values from `profile.profiles.identity_tier`. The session route reads from auth only — no cross-schema query, no service boundary crossing.

**Option B — Formalize profile as canonical tier store:**
Keep tier in `profile.profiles`, but replace the silent fail-open pattern with an explicit availability contract — explicit error handling, fail-closed default, and a defined SLA for the profile service as a dependency of auth.

**Option C — Dual write during transition (bridge path):**
Add tier to `auth.identities` immediately, begin dual-writing to both locations, then cut the session route over to read from auth once the dual-write has been running stably. Maintains backward compatibility throughout migration.

Option C allows the fail-closed fix (one line, immediate) to ship independently of the migration.

### 5. The Unified Auth Domain

The correct long-term architecture concentrates every access-control property into the auth service: the DID, the keypair, and the access tier.

**Tier values in the three-tier model:**

| Column Value | Standing Level | Access |
|-------------|----------------|--------|
| `soft` | Visitor (Soft DID) | Attend events, hold tickets |
| `preliminary` | Resident (Hard DID, onboarding) | Full profile, wallet, apps |
| `established` | Host (Hard DID, standing threshold met) | Vouch, govern, full platform |

The `tier` column stores the output of standing computation, not the raw attestation history. Attestations are the evidence; tier is the access decision. This keeps permission checks fast (single column read) while keeping the evidence base rich.

**Tier computation trigger model:**

| Option | Description | Recommendation |
|--------|-------------|----------------|
| On-write trigger | Recompute standing each time a new attestation is written | Cleanest — consistent with attestation layer's integrity model |
| Scheduled recomputation | Batch job recalculates all standing on a schedule | Acceptable; standing may be stale between runs |
| On-demand with cache | Compute on session check, cache with TTL | Performance-friendly; standing lags by cache TTL |

### 6. Recommended Sequencing

1. Change fail-default to `'soft'` immediately (one line, no migration, no dependencies)
2. Add logging to the catch block immediately (one line addition)
3. Add `tier` column to `auth.identities` with dual-write
4. Build `auth.attestations`
5. Implement standing computation
6. Cut session route to read from `auth.identities` only
7. Remove `identity_tier` from `profile.profiles` once migration confirmed

### 7. Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Option A, B, or C for tier migration? | Determines migration scope and timeline | Option C — dual-write bridge path for zero-downtime migration |
| Three-tier column values: `soft/preliminary/established` or `soft/hard.preliminary/hard.established`? | Naming convention for the new standing levels | `soft/preliminary/established` — cleaner, less verbose |
| Tier computation trigger: on-write, scheduled, or on-demand? | Performance vs. consistency tradeoff | On-write trigger for consistency |
| Does the profile service retain `identity_tier` for display purposes after migration? | Profile may need to show tier in the UI | Yes — profile reads from auth as a downstream consumer, not a canonical store |

**Detecting resolution in the repo:**
- `|| 'hard'` no longer appears on line 50 of `apps/auth/app/api/session/route.ts`
- Catch block in session route includes logging
- New migration adding `tier` column to `auth.identities`
- `apps/profile/src/db/schema.ts` removes or deprecates `identity_tier` column

---

