# C09 — Migration System Integrity

## STATUS: RESOLVED
**Resolved:** 2026-03-27 (audit against upstream HEAD `1d943e0`)
**Evidence:** `scripts/build.sh` (lines 81–102) includes mandatory pre-flight migration validation before builds. `scripts/migrate-service.mjs` implements per-service migration tracking with named tables (`__drizzle_migrations_<app>`), preventing the shared-table conflict from the original incident. Build fails if any migration fails — preventing silent divergence. Drift detection via `npm run db:generate`. Brownfield baseline process documented in `docs/MIGRATIONS.md`.
**Outcome:** Ryan kept file-based migrations (did not switch to `drizzle-kit push` as originally proposed) but added robust safeguards: CI-integrated pre-flight validation, per-service tracking tables, build-fail-on-migration-error, and documented baseline process. The root cause (silent schema divergence) is addressed.

**Flagged:** March 23, 2026
**Source:** Issue #459 (filed March 23, 2026 — post-incident)
**Priority:** URGENT — production incident (now resolved)
**Related:** All proposals that touch schema changes; P27 (chain-as-source-of-truth principle)

---

## The Concern

The drizzle file-based migration system has been silently producing schema divergence between code and the live database. A production incident on the night of March 22–23 revealed:

- 11 missing columns across 5 tables
- 4 missing indexes
- 5 default/nullable mismatches
- Multiple production 500 errors from missing columns
- Manual SQL required at 2am to recover

**Root cause (per #459):** Re-baseline operations wipe the `drizzle/` migration folders and re-run `drizzle-kit generate` fresh, then seed tracking tables claiming "everything applied." But the baseline captures schema that did not exist in the DB. Two tracking systems (`__drizzle_migrations` and `__drizzle_migrations_<app>`) disagree. Nothing validates whether the DB actually matches what the code expects. Divergence is discovered at runtime when queries crash.

## Why This Matters Architecturally

P27 (Unified Identity Substrate) establishes that **the chain is the source of truth; the database is a cache.** The migration incident reveals that even the cache cannot be trusted to be internally consistent without active validation. The broader implication: any proposal that introduces new chain-anchored data (gas credits in #433, key rotation, settlement entries) depends on the DB schema being reliably in sync with what the chain verification layer expects.

If chain-verified data is committed to a chain but the corresponding DB column doesn't exist, the chain entry is correct but the cached state is wrong. In a unified substrate architecture, DB schema drift is not just an operational problem — it undermines the cache/source-of-truth split that P27 proposes.

## Proposed Resolution (#459)

Replace file-based migrations with `drizzle-kit push` (schema-sync):
- `drizzle-kit push` compares `schema.ts` directly against the live DB and generates necessary ALTER statements
- No migration files, no tracking tables, no re-baseline risk
- CI check: `drizzle-kit push --dry-run` fails if `schema.ts` diverges from DB (catches drift before deploy)
- Per-service schema isolation maintained
- Migration path: verify dev + prod DBs in sync, update `build.sh`, delete `drizzle/` folders, drop `__drizzle_migrations*` tables

**Tradeoffs:** Loses ordered migration history (not used properly anyway). Gains: DB always matches code; no manual ALTER recovery; schema drift detectable in CI.

## What Resolution Requires

1. `build.sh` migration step updated to `drizzle-kit push --force`
2. All `drizzle/` migration folders deleted
3. All `__drizzle_migrations*` tracking tables dropped
4. CI schema drift check added
5. Tested on dev before prod

## Resolution Signal

`drizzle-kit push` in `build.sh`; no `drizzle/` directories in services; CI pipeline includes schema validation step.

---

**Status:** Open — #459 filed March 23, implementation pending
