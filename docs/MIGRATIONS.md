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

### Tracking

`public._migrations` table with filename + SHA-256 checksum. Runner warns but skips on changed checksums (DDL is idempotent, so re-running is safe).
