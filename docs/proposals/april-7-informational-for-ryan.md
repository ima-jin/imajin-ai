# Informational Findings — April 7, 2026

*Lower-priority items from a comprehensive codebase audit. Not blocking, but worth tracking.*
*Upstream HEAD: 227b2785 (93 commits since April 3)*

These items are informational — they don't have immediate exploit risk or block features, but they represent technical debt that compounds over time. Sharing for awareness and prioritization at your discretion.

---

## 1. Circular Service Dependencies

Several services have circular dependency chains:

- **auth <-> registry <-> connections** — Auth validates sessions, registry stores identities, connections queries auth for DID resolution. A failure in any one can cascade.
- **events -> pay -> auth -> events** — Event settlement calls pay, pay validates via auth, auth may query event context for scope resolution.

This doesn't break anything today (single node, all services co-located), but will become a problem under federation (services on different nodes) or during partial outages. Consider documenting the dependency graph and identifying which calls can be made async or cached.

---

## 2. Inconsistent Rate Limiting

Rate limiting is applied to some routes but not others, with no consistent policy:

- Some auth endpoints have rate limiting
- Most service API endpoints have none
- Escrow, settlement, and ticket endpoints have no rate limiting
- No DID-scoped rate limiting anywhere

Not urgent, but a funded attacker could overwhelm specific endpoints. A consistent rate-limiting middleware (per-IP and per-DID) applied at the service gateway level would address this uniformly.

---

## 3. Empty Catch Blocks (50+)

Over 50 instances of empty `catch {}` or `catch { /* comment */ }` blocks across the codebase. These silently swallow errors, making debugging production issues significantly harder. Examples span:

- Settlement error handling
- Webhook processing
- Attestation creation
- Profile fetches
- Connection lookups

Suggestion: A single pass replacing empty catches with `catch (err) { console.error('[service:context]', err) }` would dramatically improve production observability.

---

## 4. No Unified Migration System

Each app runs its own migration independently:

- `apps/auth/` has its own migration files
- `apps/events/` has its own
- `apps/pay/` has its own
- etc.

`scripts/migrate-service.mjs` provides per-service tracking, but there's no way to:
- Run all migrations in dependency order
- Verify cross-service schema consistency
- Roll back a coordinated multi-service change

Fine for single-node deployment. Will become a pain point when multiple nodes need schema consistency, or when a breaking change requires coordinated migration across services.

---

## 5. Stale DEVELOPER.md

`DEVELOPER.md` has not been updated for the April 3-7 forest infrastructure sprint. A new contributor reading it today would not learn about:

- Forest/scope concepts
- The `actingAs` pattern (`const did = identity.actingAs || identity.id`)
- Group identities and forest config
- Contextual onboarding
- Fee model v3

The 93-commit sprint was arguably the biggest architectural change since launch. The developer guide should reflect it.

---

## 6. 35 Open TODOs in Codebase

35 TODO comments remain in the codebase, including:

- **`// TODO: verify token`** in claim route — security-critical (tracked as P24)
- **`// TODO: verify countersignature`** in attestation code — blocks bilateral attestation claim
- **`// TODO: implement standing computation`** — blocks trust model
- Various UI and feature TODOs of lower priority

Suggestion: A triage pass to classify TODOs as (a) security-critical, (b) blocks a marketing claim, (c) nice-to-have would help prioritize.

---

## 7. Test Coverage

Current state: **9 test files for ~132,000 lines of code.**

Zero test coverage for:
- Forest/scope infrastructure (the entire April 3-7 sprint)
- Escrow (release, refund, authorization)
- Fee calculation and settlement
- Ticket hold and purchase flow
- `actingAs` validation
- Attestation creation and verification

This isn't a philosophical argument for testing — it's a practical observation that the four CRITICAL security issues found in this audit (escrow auth bypass, ticket race condition, unvalidated forest join, identity impersonation) would have been caught by basic integration tests.

Even a minimal test suite covering the critical payment and identity paths would significantly reduce regression risk during rapid development sprints like April 3-7.

---

## 8. Standing Computation — Not Built

The trust model's central claim is "standing is computed, not assigned — it's a query over attestation history." The `auth.attestations` table exists and attestations are being written, but:

- No standing computation function exists
- No API endpoint returns a DID's standing
- No service queries standing for access decisions
- The trust graph has connections but no scoring/weighting

Standing is the load-bearing primitive of the entire trust model. Everything downstream — governance weight, gas pricing, attestation credibility, vetting authority — depends on it. Worth prioritizing the computation even if the formula is simple initially (e.g., count of bilateral attestations weighted by type).

---

*Generated from Tonalith audit, April 7, 2026. See `problems/problems.md` for security findings and `outstanding-concerns/outstanding-concerns.md` for architectural concerns.*
