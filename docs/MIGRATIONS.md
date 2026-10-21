# Database Migrations

> **This document is superseded by the `imajin-db` skill.**
> For agents: the skill has full migration instructions, schema layout, and query patterns.
> For humans: see below for the quick reference.

## Quick Reference

Active migrations in this repository are **kernel-only**: generated
`migrations/0001_kernel_baseline.sql`, followed by migrations numbered above
the historical cut in `migrations/kernel-baseline.json`. Archived mixed-owner
history is audit-only; app migrations live in app repositories.
See [the baseline runbook](../migrations/BASELINE.md) for generation,
verified ledger adoption, seed inventory and Jin's isolated restore commands.
The baseline's idempotency is transactional ledger-based, not repeated DDL.

```bash
# Run pending migrations
node scripts/migrate.mjs

# Or via wrapper
./scripts/migrate.sh

# Explicit kernel filter (equivalent to the default in this repository)
node scripts/migrate.mjs --owner kernel
```

### Adding a Migration

1. Create `migrations/NNNN_description.sql` (next number above the archived cut and active files)
2. All DDL must be idempotent (`IF NOT EXISTS`, `IF EXISTS`, `DO $$ ... EXCEPTION ...`)
3. Use schema-qualified names (`auth.identities`, not `identities`)
   and `-- owner: kernel`; app-owned SQL belongs in its app repository.
4. Commit — it runs automatically on next deploy

### Scaffolding from Schema Changes

```bash
cd apps/kernel  # or whichever app
npx drizzle-kit generate
# Move output from drizzle/ to migrations/, rename, add idempotent guards
```

### New Environment Setup

```bash
# Fresh DB: baseline, then post-cut migrations
node scripts/migrate.mjs

# Existing DB: verify the complete matching historical ledger, mark baseline
# applied without DDL, then apply only post-cut migrations
node scripts/migrate.mjs
```

### Rules

- **Never use `drizzle-kit push`.** Always use migration files.
- **Post-cut DDL is idempotent.** The generated baseline executes once atomically
  with its tracking row; adoption never executes baseline DDL.
- **One migration file per schema change.** Don't let two agents work on the same migration.
- **Schema-qualified names everywhere.** `auth.identities`, not `identities`.
- **Forward-only. Migrations are additive; no down-scripts.** A column or table may be dropped only
  **≥1 release after** the last code that reads it shipped. Rollback = redeploy the last good tag
  (`docs/ops/ROLLBACK.md`), which leaves the schema ahead of the code — so the previous release must
  still run against the current schema. Never drop or rename in the same release that stops using a
  column.

### Tracking

`public._migrations` stores filename + SHA-256. Baseline and adoption-history
checksum mismatches fail closed. Post-cut files retain the legacy warn/skip
behavior. Never edit applied SQL or blindly seed tracking; the old
`seed-migrations.mjs` path is disabled in baseline layout.

Historically this table was shared across every mode: `--owner <app>` only changed which
files a given run reads from disk, never how a run records what it
applied. A database migrated exclusively with the plain no-flag command
and a database migrated by running every owner's `--owner` slice once each
(plus `--owner kernel` for shared files) converge to the same rows in
`public._migrations`, because both apply the same files under the same
filenames/checksums.

### Ownership

Every table/view/type/function created in `migrations/` is owned by exactly
one app (or the kernel), tracked in `migrations/ownership.json` and
documented in `migrations/OWNERSHIP.md`. A new migration must declare its
owner with a `-- owner: <name>` header; `scripts/check-migration-ownership.mjs`
enforces in CI that a migration only touches tables its declared owner
actually owns, and that any new table it creates is registered in the map.
See `migrations/OWNERSHIP.md` for the full rule, the current map, and the
known cross-owner gaps that predate this guard and are not yet fixed.
