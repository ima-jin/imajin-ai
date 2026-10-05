# Database Migrations

> **This document is superseded by the `imajin-db` skill.**
> For agents: the skill has full migration instructions, schema layout, and query patterns.
> For humans: see below for the quick reference.

## Quick Reference

All migrations live in `migrations/` at the repo root. Plain SQL, sequentially numbered, fully idempotent.

```bash
# Run pending migrations
node scripts/migrate.mjs

# Or via wrapper
./scripts/migrate.sh

# Run only one owner's migrations (#1991 phase 2a) — see migrations/OWNERSHIP.md
# for what "owned solely by <app>" and "shared" mean, and why this doesn't
# yet give any app true isolation (most owners still depend on 0001_seed.sql).
node scripts/migrate.mjs --owner <app>
node scripts/migrate.mjs --owner <app> --include-shared

# Per-app mode (#1991 phase 2b, #2524): an extracted app applies ITS OWN
# migrations from ITS OWN repo into ITS OWN schema. See "Per-app mode" below.
node scripts/migrate.mjs --app-dir <dir> --schema <app-schema>
```

### Adding a Migration

1. Create `migrations/NNNN_description.sql` (next sequential number)
2. All DDL must be idempotent (`IF NOT EXISTS`, `IF EXISTS`, `DO $$ ... EXCEPTION ...`)
3. Use schema-qualified names (`auth.identities`, not `identities`)
4. Commit — it runs automatically on next deploy

### Scaffolding from Schema Changes

```bash
cd apps/kernel  # or whichever app
npx drizzle-kit generate
# Move output from drizzle/ to migrations/, rename, add idempotent guards
```

### New Environment Setup

```bash
# Fresh DB: run all migrations
node scripts/migrate.mjs

# Existing DB: seed tracking table first
node scripts/seed-migrations.mjs
node scripts/migrate.mjs
```

### Rules

- **Never use `drizzle-kit push`.** Always use migration files.
- **All DDL is idempotent.** No exceptions.
- **One migration file per schema change.** Don't let two agents work on the same migration.
- **Schema-qualified names everywhere.** `auth.identities`, not `identities`.
- **Forward-only. Migrations are additive; no down-scripts.** A column or table may be dropped only
  **≥1 release after** the last code that reads it shipped. Rollback = redeploy the last good tag
  (`docs/ops/ROLLBACK.md`), which leaves the schema ahead of the code — so the previous release must
  still run against the current schema. Never drop or rename in the same release that stops using a
  column.

### Tracking

`public._migrations` table with filename + SHA-256 checksum. Runner warns but skips on changed checksums (DDL is idempotent, so re-running is safe).

This table is shared across every mode: `--owner <app>` only changes which
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

### Per-app mode (apps run their own migrations)

`--app-dir <dir> --schema <name>` (both required, not combinable with `--owner`)
applies `<dir>/*.sql` (sorted by name, resolved against the cwd) instead of the
kernel's `migrations/` folder:

- **Own ledger.** Applied files are tracked in `<schema>._migrations` (filename +
  SHA-256 checksum) inside the app's schema — never in the kernel's
  `public._migrations`. The schema and ledger are created if missing.
- **Pinned `search_path`.** Each file runs in its own transaction with
  `search_path` set to `<schema>`, so unqualified names land in the app's schema.
- **Fails loud on schema mismatch**, before any SQL runs: `--schema` may not be a
  kernel schema (`auth`, `kernel`, `pay`, ...) or `public`/`pg_*`, and no
  migration file may reference any *other* known kernel or app schema.
- **Idempotent.** Re-running applies nothing; a changed checksum warns and skips
  (same as the kernel runner).
- `DATABASE_URL` is read from the environment first (the kernel's
  `apps/kernel/.env.local` is only a fallback); `postgres` is resolved from the
  kernel checkout's `node_modules`, falling back to the app's own.

From an extracted app's repo (e.g. `ima-jin/links`, schema `links`), with a
checkout of this repo at `$IMAJIN_AI`:

```bash
DATABASE_URL=postgres://... node "$IMAJIN_AI/scripts/migrate.mjs" \
  --app-dir ./migrations --schema links
```

The kernel's own `migrations/` folder is untouched by this mode; moving an app's
existing files out of it (and squashing the kernel baseline) is #1991 phase 3.
